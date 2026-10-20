"""Safe HTTP fetching and text/link extraction for official admission pages.

Only allowlisted HTTPS hosts are fetched (HTTP/loopback in explicit test mode).
Redirects are validated hop by hop; private/link-local addresses are rejected.
"""

from __future__ import annotations

import hashlib
import ipaddress
import re
import socket
from dataclasses import dataclass, field
from datetime import UTC, datetime
from io import BytesIO
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

import httpx
from bs4 import BeautifulSoup
from pypdf import PdfReader

from app.modules.admissions.config import AdmissionSourceConfig, normalize_host


class FetchBlocked(Exception):
    pass


class FetchTooLarge(Exception):
    pass


class FetchTimeout(Exception):
    pass


class FetchFailed(Exception):
    pass


class ContentTypeUnsupported(Exception):
    pass


XLS_MIME = "application/vnd.ms-excel"
XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
EXCEL_TYPES = {XLS_MIME, XLSX_MIME}
OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"
ZIP_MAGIC = b"PK\x03\x04"


@dataclass
class FetchedPage:
    url: str
    http_status: int
    content_type: str
    content: bytes
    text: str
    title: str
    links: list[dict] = field(default_factory=list)
    table: list[list[str]] = field(default_factory=list)
    content_hash: str = ""
    fetched_at: datetime = field(default_factory=lambda: datetime.now(UTC))


def _private_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return True
    return bool(
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_multicast
        or address.is_reserved
        or address.is_unspecified
    )


def _resolve_and_check(host: str, port: int, config: AdmissionSourceConfig) -> None:
    if config.crawl.allow_private_hosts_for_tests:
        return
    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise FetchFailed("无法解析来源主机") from exc
    for info in infos:
        address = info[4][0]
        if _private_address(address):
            raise FetchBlocked("来源主机解析到私网/环回地址")


def validate_url(url: str, config: AdmissionSourceConfig) -> str:
    try:
        config.require_allowed_url(url)
    except ValueError as exc:
        raise FetchBlocked(str(exc)) from exc
    parsed = urlparse(url)
    if not parsed.hostname:
        raise FetchBlocked("来源 URL 缺少主机")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    _resolve_and_check(normalize_host(parsed.hostname), port, config)
    return url


def _decode(content: bytes, encoding: str | None) -> str:
    for candidate in [encoding, "utf-8", "gb18030", "latin-1"]:
        if not candidate:
            continue
        try:
            return content.decode(candidate)
        except (LookupError, UnicodeDecodeError):
            continue
    return content.decode("utf-8", errors="replace")


def _sniff_content_type(content: bytes, declared: str) -> str:
    declared = (declared or "").split(";", 1)[0].strip().lower()
    # Magic bytes win: some official download endpoints label XLS as text/html.
    if content.startswith(b"%PDF-"):
        return "application/pdf"
    if content.startswith(OLE2_MAGIC):
        return XLS_MIME
    if content.startswith(ZIP_MAGIC) and (
        b"xl/workbook.xml" in content[:65536] or b"xl/workbook.xml" in content[-65536:]
    ):
        return XLSX_MIME
    if declared in {
        "text/html",
        "application/xhtml+xml",
        "application/pdf",
        "text/plain",
        *EXCEL_TYPES,
    }:
        return declared
    head = content[:512].lstrip().lower()
    if head.startswith(b"<!doctype html") or head.startswith(b"<html"):
        return "text/html"
    if declared.startswith("text/"):
        return "text/plain"
    raise ContentTypeUnsupported("不支持的来源内容类型")


def _keyword_score(text: str, url: str, keywords: list[str]) -> int:
    haystack = (text + " " + url).lower()
    return sum(1 for keyword in keywords if keyword.lower() in haystack)


def html_text_and_links(
    content: bytes, base_url: str, config: AdmissionSourceConfig, encoding: str | None
) -> tuple[str, str, list[dict]]:
    html = _decode(content, encoding)
    soup = BeautifulSoup(html, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    for tag in soup.find_all(
        ["script", "style", "noscript", "svg", "iframe", "object", "embed", "nav", "footer"]
    ):
        tag.decompose()

    table_lines = []
    for table in soup.find_all("table"):
        for row in table.find_all("tr"):
            cells = [
                cell.get_text(" ", strip=True)
                for cell in row.find_all(["th", "td"])
                if cell.get_text(" ", strip=True)
            ]
            if cells:
                table_lines.append(" | ".join(cells))

    container = soup.find("main") or soup.find("article") or soup.body or soup
    body_text = container.get_text("\n", strip=True)
    text = "\n".join(table_lines + [body_text])
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    max_chars = max(config.crawl.max_chars_per_call * 20, 200_000)
    if len(text) > max_chars:
        text = text[:max_chars] + "\n[TRUNCATED]"

    links = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        href = (anchor.get("href") or "").strip()
        if not href or href.startswith(("#", "mailto:", "javascript:", "tel:")):
            continue
        target = urljoin(base_url, href).split("#", 1)[0]
        parsed = urlparse(target)
        if parsed.scheme not in {"http", "https"}:
            continue
        if not config.host_allowed(parsed.hostname or ""):
            continue
        if target in seen:
            continue
        seen.add(target)
        label = anchor.get_text(" ", strip=True)[:200]
        score = _keyword_score(label, target, config.discovery.keywords)
        links.append(
            {
                "url": target,
                "text": label,
                "score": score,
            }
        )
    links.sort(key=lambda item: item["score"], reverse=True)
    return title[:300], text, links[: config.discovery.max_links_per_page]


def pdf_text(content: bytes, config: AdmissionSourceConfig) -> str:
    try:
        reader = PdfReader(BytesIO(content), strict=False)
        if reader.is_encrypted:
            raise ContentTypeUnsupported("加密 PDF 不支持")
        chunks = []
        for page in list(reader.pages)[:50]:
            chunks.append(page.extract_text() or "")
    except ContentTypeUnsupported:
        raise
    except Exception as exc:
        raise FetchFailed("PDF 解析失败") from exc
    text = "\n".join(chunks).strip()
    if len(text) < 20:
        raise ContentTypeUnsupported("PDF 没有可抽取的文本层（可能是扫描件）")
    max_chars = max(config.crawl.max_chars_per_call * 20, 200_000)
    return text[:max_chars]


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, datetime):
        return value.date().isoformat()
    return str(value).strip()


def excel_table(content: bytes, content_type: str) -> tuple[str, list[list[str]]]:
    rows: list[list[str]] = []
    try:
        if content_type == XLS_MIME:
            import xlrd

            book = xlrd.open_workbook(file_contents=content)
            if not book.nsheets:
                raise ValueError("no sheets")
            sheet = book.sheet_by_index(0)
            title = sheet.name
            for row_index in range(min(sheet.nrows, 10000)):
                rows.append(
                    [
                        _cell(sheet.cell_value(row_index, column))
                        for column in range(min(sheet.ncols, 50))
                    ]
                )
        else:
            import openpyxl

            book = openpyxl.load_workbook(BytesIO(content), read_only=True, data_only=True)
            if not book.worksheets:
                raise ValueError("no sheets")
            sheet = book.worksheets[0]
            title = sheet.title
            for values in sheet.iter_rows(max_row=10000, max_col=50, values_only=True):
                rows.append([_cell(value) for value in values])
            book.close()
    except Exception as exc:
        raise ContentTypeUnsupported("Excel 附件解析失败") from exc
    while rows and not any(rows[-1]):
        rows.pop()
    return title, rows


def excel_text(rows: list[list[str]], config: AdmissionSourceConfig) -> str:
    text = "\n".join(line for line in (" | ".join(row).strip() for row in rows) if line)
    max_chars = max(config.crawl.max_chars_per_call * 20, 200_000)
    return text[:max_chars]


class RobotsCache:
    def __init__(self, client: httpx.Client, config: AdmissionSourceConfig):
        self.client = client
        self.config = config
        self.cache: dict[str, RobotFileParser] = {}

    def allowed(self, url: str) -> bool:
        if not self.config.crawl.respect_robots:
            return True
        parsed = urlparse(url)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        parser = self.cache.get(origin)
        if parser is None:
            parser = RobotFileParser()
            parser.allow_all = True
            try:
                response = self.client.get(
                    origin + "/robots.txt",
                    headers={"User-Agent": self.config.crawl.user_agent},
                )
                if response.status_code in {401, 403}:
                    parser.disallow_all = True
                elif response.status_code < 400 and len(response.content) <= 256 * 1024:
                    parser.parse(response.text.splitlines())
            except httpx.HTTPError:
                pass
            self.cache[origin] = parser
        return parser.can_fetch(self.config.crawl.user_agent, url)


def fetch_page(
    url: str,
    config: AdmissionSourceConfig,
    client: httpx.Client,
    robots: RobotsCache | None = None,
) -> FetchedPage:
    robots = robots or RobotsCache(client, config)
    current = url
    response = None
    for _ in range(config.crawl.max_redirects + 1):
        validate_url(current, config)
        if not robots.allowed(current):
            raise FetchBlocked("robots.txt 禁止抓取")
        try:
            with client.stream(
                "GET",
                current,
                headers={
                    "User-Agent": config.crawl.user_agent,
                    "Accept": "text/html,application/xhtml+xml,application/pdf,text/plain",
                },
                follow_redirects=False,
            ) as candidate:
                if candidate.status_code in {301, 302, 303, 307, 308}:
                    location = candidate.headers.get("location")
                    if not location:
                        raise FetchFailed("重定向缺少 Location")
                    current = urljoin(current, location)
                    continue
                if candidate.status_code >= 400:
                    raise FetchFailed(f"来源返回 HTTP {candidate.status_code}")
                declared = candidate.headers.get("content-type", "")
                chunks = []
                total = 0
                for chunk in candidate.iter_bytes():
                    total += len(chunk)
                    if total > config.crawl.max_bytes_per_page:
                        raise FetchTooLarge("来源页面超过大小限制")
                    chunks.append(chunk)
                content = b"".join(chunks)
                response = (candidate.status_code, declared, candidate.encoding)
                break
        except httpx.TimeoutException as exc:
            raise FetchTimeout("来源请求超时") from exc
        except httpx.HTTPError as exc:
            raise FetchFailed("来源请求失败") from exc
    else:
        raise FetchFailed("重定向次数超过限制")

    if response is None:
        raise FetchFailed("来源请求失败")
    status, declared, encoding = response
    content_type = _sniff_content_type(content, declared)
    table: list[list[str]] = []
    if content_type == "application/pdf":
        text = pdf_text(content, config)
        title = urlparse(current).path.rsplit("/", 1)[-1] or "PDF"
        links: list[dict] = []
    elif content_type in {"text/html", "application/xhtml+xml"}:
        title, text, links = html_text_and_links(content, current, config, encoding)
    elif content_type in EXCEL_TYPES:
        title, table = excel_table(content, content_type)
        text = excel_text(table, config)
        links = []
    else:
        text = _decode(content, encoding)
        title = urlparse(current).path.rsplit("/", 1)[-1] or "text"
        links = []
    return FetchedPage(
        url=current,
        http_status=status,
        content_type=content_type,
        content=content,
        text=text,
        title=title,
        links=links,
        table=table,
        content_hash=hashlib.sha256(content).hexdigest(),
    )
