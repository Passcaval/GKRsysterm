"""Full official national school list; model output never supplies directory facts."""

import hashlib
import json
import re
from datetime import date
from io import BytesIO
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx
from bs4 import BeautifulSoup
from pydantic import BaseModel, ConfigDict, Field

from app.core.errors import DomainError
from app.core.storage import blob_path, save_blob
from app.modules.admissions.config import AdmissionSourceConfig
from app.modules.admissions.crawler import FetchBlocked, FetchFailed, validate_url


class CatalogConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = True
    auto_start: bool = True
    index_url: str
    publication_url: str
    fallback_publication_urls: list[str] = Field(default_factory=list, max_length=5)
    allowed_hosts: list[str] = Field(min_length=1)
    attachment_mirrors: dict[str, list[str]] = Field(default_factory=dict)
    minimum_counts: dict[str, int] = Field(default_factory=lambda: {"ordinary": 2500, "adult": 150})
    max_bytes: int = Field(default=16 * 1024 * 1024, ge=1024, le=20 * 1024 * 1024)
    timeout_seconds: int = Field(default=30, ge=1, le=120)
    analysis_batch_size: int = Field(default=100, ge=1, le=100)

    @property
    def fingerprint(self):
        return digest(self.model_dump())


def digest(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def load_config(settings):
    try:
        return CatalogConfig.model_validate_json(
            settings.school_catalog_file.read_text(encoding="utf-8-sig")
        )
    except (OSError, ValueError):
        raise DomainError(
            503, "CATALOG_CONFIG_INVALID", "全国院校名录配置无效，请检查配置文件。"
        ) from None


def network_policy(config):
    return AdmissionSourceConfig.model_validate(
        {
            "discovery": {
                "enabled": False,
                "allowed_hosts": config.allowed_hosts,
                "allowed_suffixes": [],
            },
            "sources": [],
        }
    )


def download(client, config, url):
    """HTTPS whitelist and public-address validation on every redirect; bounded body."""
    policy = network_policy(config)
    for _ in range(6):
        validate_url(url, policy)
        with client.stream(
            "GET",
            url,
            follow_redirects=False,
            headers={
                "User-Agent": "NightVoyageCatalog/1.0",
                "Accept": "text/html,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
        ) as response:
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get("location")
                if not location:
                    break
                url = urljoin(url, location)
                continue
            if response.status_code != 200:
                raise DomainError(
                    503,
                    "CATALOG_SOURCE_UNAVAILABLE",
                    f"官方名录来源返回 HTTP {response.status_code}，未更新正式资料。",
                )
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > config.max_bytes:
                    raise DomainError(
                        413, "CATALOG_SOURCE_TOO_LARGE", "官方附件超过限制，未截断或发布资料。"
                    )
            return url, bytes(body)
    raise DomainError(503, "CATALOG_REDIRECT_FAILED", "官方来源重定向异常。")


PROVINCES = (
    "北京市",
    "天津市",
    "河北省",
    "山西省",
    "内蒙古自治区",
    "辽宁省",
    "吉林省",
    "黑龙江省",
    "上海市",
    "江苏省",
    "浙江省",
    "安徽省",
    "福建省",
    "江西省",
    "山东省",
    "河南省",
    "湖北省",
    "湖南省",
    "广东省",
    "广西壮族自治区",
    "海南省",
    "重庆市",
    "四川省",
    "贵州省",
    "云南省",
    "西藏自治区",
    "陕西省",
    "甘肃省",
    "青海省",
    "宁夏回族自治区",
    "新疆维吾尔自治区",
)


def cell(value):
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return re.sub(r"\s+", "", str(value)).strip()


def parse_workbook(content, category):
    if content.startswith(bytes.fromhex("D0CF11E0A1B11AE1")):
        import xlrd

        book = xlrd.open_workbook(file_contents=content)
        sheets = [
            [list(sheet.row_values(i)) for i in range(sheet.nrows)] for sheet in book.sheets()
        ]
    elif content.startswith(b"PK"):
        from zipfile import ZipFile

        with ZipFile(BytesIO(content)) as archive:
            if sum(entry.file_size for entry in archive.infolist()) > 128 * 1024 * 1024:
                raise ValueError("workbook expands beyond limit")
        import openpyxl

        book = openpyxl.load_workbook(BytesIO(content), read_only=True, data_only=True)
        try:
            sheets = []
            for sheet in book:
                rows = []
                for row in sheet.iter_rows(values_only=True):
                    rows.append(list(row))
                    if len(rows) > 10000:
                        raise ValueError("too many rows")
                sheets.append(rows)
        finally:
            book.close()
    else:
        raise DomainError(422, "CATALOG_FORMAT_INVALID", "官方名录附件不是有效 XLS/XLSX。")
    output = []
    for sheet in sheets:
        if len(sheet) > 10000:
            raise ValueError("too many rows")
        headers, province = {}, ""
        aliases = {
            "学校名称": "name",
            "学校标识码": "identifier",
            "主管部门": "department",
            "所在地": "city",
            "办学层次": "education_level",
            "备注": "remarks",
        }
        for row in sheet:
            values = [cell(value) for value in row[:30]]
            if "学校标识码" in values and "学校名称" in values:
                headers = {
                    key: values.index(label) for label, key in aliases.items() if label in values
                }
                continue
            title = "".join(values)
            if not any(re.fullmatch(r"\d{10}", value) for value in values):
                for value in PROVINCES:
                    if title.startswith(value):
                        province = value
                        break
                continue
            if not headers:
                raise ValueError("missing header")
            data = {
                key: values[index] if index < len(values) else "" for key, index in headers.items()
            }
            if (
                not province
                or not re.fullmatch(r"\d{10}", data.get("identifier", ""))
                or not data.get("name")
                or not data.get("department")
            ):
                raise DomainError(
                    422,
                    "CATALOG_ROW_INVALID",
                    "院校代码、名称、主管部门、省份或所在地缺失，未发布不完整名单。",
                )
            if category == "ordinary" and not data.get("education_level"):
                raise ValueError("missing education level")
            output.append(
                {
                    **data,
                    "city": data.get("city") or "待核对",
                    "province": province,
                    "category": category,
                    "education_level": data.get("education_level") or "待核对",
                    "remarks": data.get("remarks", ""),
                }
            )
    return output


def fetch_catalog(settings, config, client=None):
    owns = client is None
    client = client or httpx.Client(timeout=config.timeout_seconds, follow_redirects=False)
    snapshots = []
    success = False

    def get(url, label):
        final, body = download(client, config, url)
        snapshots.append(
            {
                "url": final,
                "label": label,
                "content_hash": hashlib.sha256(body).hexdigest(),
                "storage_key": save_blob(settings, body),
            }
        )
        return final, body

    try:
        # Discover new annual publications; explicit current official publication is a fallback.
        publication = config.publication_url
        try:
            index_url, index_body = get(config.index_url, "教育部名单索引")
            index = BeautifulSoup(index_body, "html.parser")
            links = [
                urljoin(index_url, a["href"])
                for a in index.select("a[href]")
                if "全国高等学校名单" in a.get_text()
            ]
            dates = [(re.search(r"/t(\d{8})_", url), url) for url in links]
            dated = [(match.group(1), url) for match, url in dates if match]
            if dated:
                publication = max(dated)[1]
        except (DomainError, FetchBlocked, FetchFailed, httpx.HTTPError):
            pass
        article_url, article_body = "", b""
        for candidate in dict.fromkeys(
            [publication, config.publication_url, *config.fallback_publication_urls]
        ):
            try:
                article_url, article_body = get(candidate, "全国高等学校名单公告")
                break
            except (DomainError, FetchBlocked, FetchFailed, httpx.HTTPError):
                continue
        if not article_body:
            raise DomainError(
                503,
                "CATALOG_SOURCE_UNAVAILABLE",
                "教育部公告及官方备用发布页均不可用，未更新资料。",
            )
        soup = BeautifulSoup(article_body, "html.parser")
        text = re.sub(r"\s+", "", soup.get_text())
        cutoff = re.search(r"截至(\d{4})年(\d{1,2})月(\d{1,2})日", text)
        as_of = date(*(int(value) for value in cutoff.groups())).isoformat() if cutoff else None
        expected = {}
        patterns = {
            "ordinary": r"普通高等学校(\d+)所",
            "adult": r"成人高等学校(\d+)所",
            "total": r"高等学校共计(\d+)所",
        }
        for key, pattern in patterns.items():
            match = re.search(pattern, text)
            if not match:
                raise DomainError(
                    422, "CATALOG_COUNT_UNKNOWN", "公告未提供完整院校数量，无法确认全量抓取。"
                )
            expected[key] = int(match.group(1))
        attachments = {}
        for anchor in soup.select("a[href]"):
            label = anchor.get_text()
            category = (
                "ordinary"
                if "普通高等学校名单" in label
                else "adult"
                if "成人高等学校名单" in label
                else None
            )
            if category and re.search(r"\.xlsx?(?:$|[?#])", anchor["href"], re.I):
                attachment = urljoin(article_url, anchor["href"])
                if attachment.startswith("http://"):
                    attachment = "https://" + attachment.removeprefix("http://")
                attachments[category] = attachment
        if set(attachments) != {"ordinary", "adult"}:
            raise DomainError(
                422, "CATALOG_ATTACHMENTS_MISSING", "未找到普通高校和成人高校两份官方完整名单。"
            )
        rows = []
        for category, url in attachments.items():
            parsed_url = urlsplit(url)
            candidates = [
                url,
                *[
                    urlunsplit(("https", host, parsed_url.path, parsed_url.query, ""))
                    for host in config.attachment_mirrors.get(parsed_url.hostname, [])
                ],
            ]
            body = None
            for candidate in candidates:
                try:
                    _, body = get(candidate, category)
                    break
                except (DomainError, FetchBlocked, FetchFailed, httpx.HTTPError):
                    continue
            if body is None:
                raise DomainError(
                    503, "CATALOG_ATTACHMENT_UNAVAILABLE", "官方附件及配置的HTTPS镜像均不可用。"
                )
            parsed = parse_workbook(body, category)
            if len(parsed) != expected[category] or len(parsed) < config.minimum_counts.get(
                category, 1
            ):
                raise DomainError(
                    422,
                    "CATALOG_COUNT_MISMATCH",
                    "附件行数与官方公告数量不符，禁止把部分资料作为全量发布。",
                )
            rows.extend(parsed)
        if len(rows) != expected["total"] or len({row["identifier"] for row in rows}) != len(rows):
            raise DomainError(
                422, "CATALOG_DUPLICATE_OR_INCOMPLETE", "全国名录包含重复代码或总数不符。"
            )
        success = True
        return {
            "rows": rows,
            "counts": expected,
            "publication_url": article_url,
            "title": "教育部全国高等学校名单",
            "snapshots": snapshots,
            "content_hash": digest(rows),
            "as_of": as_of,
            "scope_note": "按教育部公布的全国高等学校名单，包含普通及成人高校；该名单不包含港澳台高校。",
        }
    except (ValueError, FetchBlocked, FetchFailed, httpx.HTTPError) as exc:
        raise DomainError(
            503, "CATALOG_FETCH_FAILED", "官方名单抓取或解析失败，未更新正式院校资料。"
        ) from exc
    finally:
        if not success:
            for snapshot in snapshots:
                blob_path(settings, snapshot["storage_key"]).unlink(missing_ok=True)
        if owns:
            client.close()
