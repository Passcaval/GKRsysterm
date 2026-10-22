"""Pinned official reference tables, separate from reviewed admission units."""

import hashlib
import json
from datetime import timedelta
from pathlib import Path

import httpx
import xlrd
from sqlalchemy import select

from app.core.errors import DomainError
from app.core.security import advisory_lock
from app.db.models import Source, now
from app.modules.admissions.knowledge import official_url

TABLE_CONFIG = Path(__file__).resolve().parents[5] / "config/atlas_reference.json"


def parse_table(content, year):
    sheet = xlrd.open_workbook(file_contents=content).sheet_by_index(0)
    headers = [str(v).strip() for v in sheet.row_values(0)]
    required = ("学校名称", "专业名称", "分数线", "位次")
    if any(v not in headers for v in required):
        raise DomainError(503, "ATLAS_TABLE_FORMAT", "官方投档参考表列名已变化，请核对配置。")
    columns = {name: headers.index(name) for name in required}
    rows = []
    for index in range(1, sheet.nrows):
        values = sheet.row_values(index)
        school = str(values[columns["学校名称"]]).strip()
        major = str(values[columns["专业名称"]]).strip()
        try:
            rank = int(float(values[columns["位次"]]))
            score = int(float(values[columns["分数线"]]))
        except (ValueError, TypeError):
            continue
        if not school or not major or not 1 <= rank <= 5000000 or not 100 <= score <= 900:
            continue
        rows.append(
            {
                "school_name": school,
                "major": major,
                "rank": rank,
                "score": score,
                "year": year,
                "province": "浙江",
                "required_subjects": [],
                "row": index + 1,
            }
        )
    if len(rows) < 1000:
        raise DomainError(503, "ATLAS_TABLE_INCOMPLETE", "官方投档参考表不完整，暂不使用。")
    return rows


def table_facts(db, settings, context, *, client_factory=httpx.Client):
    if context.province not in {"浙江", "浙江省"}:
        return []
    definitions = json.loads(TABLE_CONFIG.read_text(encoding="utf-8"))
    options = [v for v in definitions if v["year"] <= context.year]
    if not options:
        return []
    definition = max(options, key=lambda v: v["year"])
    url = official_url(definition["download_url"])
    if not url or not url.startswith("https://www.zjzs.net/"):
        raise DomainError(503, "ATLAS_TABLE_CONFIG", "投档参考表仅接受已配置的考试院官方地址。")
    advisory_lock(db, "atlas-reference-table:" + url)
    source = db.scalar(
        select(Source)
        .where(
            Source.data["origin"].astext == "atlas_official_table",
            Source.data["download_url"].astext == url,
            Source.created_at >= now() - timedelta(hours=settings.admission_knowledge_ttl_hours),
        )
        .order_by(Source.created_at.desc())
        .limit(1)
    )
    if not source:
        try:
            with client_factory(timeout=20, follow_redirects=False) as client:
                with client.stream("GET", url) as response:
                    response.raise_for_status()
                    chunks = []
                    length = 0
                    for chunk in response.iter_bytes():
                        length += len(chunk)
                        if length > 8 * 1024 * 1024:
                            raise ValueError("table too large")
                        chunks.append(chunk)
            content = b"".join(chunks)
            rows = parse_table(content, definition["year"])
        except (httpx.HTTPError, ValueError, xlrd.XLRDError):
            raise DomainError(503, "ATLAS_TABLE_UNAVAILABLE", "官方投档参考表暂不可读。") from None
        epoch = int(now().timestamp() // (settings.admission_knowledge_ttl_hours * 3600))
        digest = hashlib.sha256(
            ("atlas-reference:" + url + str(epoch)).encode() + content
        ).hexdigest()
        source = db.scalar(select(Source).where(Source.content_hash == digest))
        if not source:
            source = Source(
                content_hash=digest,
                data={
                    "kind": "official",
                    "origin": "atlas_official_table",
                    "title": definition["title"],
                    "url": definition["publication_url"],
                    "download_url": url,
                    "year": definition["year"],
                    "retrievedAt": now().isoformat(),
                    "rows": rows,
                    "excerpt": f"{definition['year']}年浙江普通类第一段官方投档参考表，含{len(rows)}条有位次记录；按学校名称、专业名称、分数线和位次逐列读取。",
                    "locator": "原始XLS：学校名称、专业名称、分数线、位次列",
                    "scope": "浙江普通类第一段历史投档参考；不直接发布正式招生单位；本表不含选科要求，请另行核对。",
                },
            )
            db.add(source)
            db.flush()
    return [{**row, "source_id": str(source.id)} for row in source.data["rows"]]
