"""Crawl orchestration, staging validation and admin review/publish hand-off."""

from __future__ import annotations

import hashlib
import json
import logging
import re
import time
import unicodedata
from collections import deque
from datetime import UTC, datetime, timedelta, timezone
from typing import Literal
from urllib.parse import urlparse
from uuid import UUID, uuid4

import httpx
from pydantic import Field, ValidationError, model_validator
from sqlalchemy import func, select

from app.core.config import Settings
from app.core.errors import DomainError
from app.core.model import (
    ModelCallFailed,
    ModelGateway,
    ModelNotConfigured,
    ModelOutputInvalid,
)
from app.core.security import advisory_lock
from app.core.storage import blob_path, save_blob
from app.db.models import (
    AdmissionUnit,
    CrawlPage,
    CrawlRun,
    ImportBatch,
    Job,
    User,
    now,
)
from app.modules.admissions.config import AdmissionSourceConfig, load_admission_config
from app.modules.admissions.crawler import (
    ContentTypeUnsupported,
    FetchBlocked,
    FetchedPage,
    FetchFailed,
    FetchTimeout,
    FetchTooLarge,
    RobotsCache,
    fetch_page,
    html_text_and_links,
)
from app.modules.admissions.prompts import (
    EXTRACT_PROMPT_VERSION,
    EXTRACT_SYSTEM,
    LINK_PROMPT_VERSION,
    LINK_SYSTEM,
    build_extraction_prompt,
    build_link_prompt,
)
from app.modules.admissions.service import AdmissionRow, ImportInput, enqueue_import, find_school
from app.modules.community.schemas import StrictModel

logger = logging.getLogger("admissions.crawl")

TERMINAL_STATUSES = {
    "approved",
    "publishing",
    "succeeded",
    "partial",
    "rejected",
    "failed",
    "cancelled",
}


class CrawlReviewInput(StrictModel):
    decision: Literal["approve", "reject"]
    reason: str = Field(default="", max_length=2000)
    expected_version: int = Field(ge=1)
    supersedes_import_id: UUID | None = None
    acknowledge_published_at_fallback: bool = False
    rows_override: dict[str, list[AdmissionRow]] | None = None

    @model_validator(mode="after")
    def validate_decision(self):
        if self.decision == "reject" and not self.reason.strip():
            raise ValueError("reject requires a reason")
        return self


def create_crawl_run(
    db,
    settings: Settings,
    config: AdmissionSourceConfig,
    *,
    trigger_type: str,
    triggered_by: UUID | None = None,
) -> CrawlRun:
    run = CrawlRun(
        trigger_type=trigger_type,
        triggered_by=triggered_by,
        status="queued",
        config_fingerprint=config.config_fingerprint,
        config_snapshot=config.model_dump(mode="json"),
        model_name=settings.model_name,
        prompt_version=f"{LINK_PROMPT_VERSION}+{EXTRACT_PROMPT_VERSION}",
        progress={},
        rows=[],
        pages_summary={},
        warnings=[],
        errors=[],
        import_ids=[],
        version=1,
    )
    db.add(run)
    db.flush()
    db.add(Job(task_type="crawl", object_id=run.id, processor_version="crawl-v1"))
    return run


def maybe_enqueue_startup_crawl(
    sessions,
    settings: Settings,
    config: AdmissionSourceConfig | None = None,
    config_error: str | None = None,
) -> UUID | None:
    if config is None and config_error is None:
        config, config_error = load_admission_config(settings)
    if config is None or config_error:
        return None
    if not config.discovery_mode or not config.discovery.auto_start:
        return None
    if not settings.model_configured:
        return None
    with sessions.begin() as db:
        advisory_lock(db, "crawl:startup")
        active = db.scalar(
            select(func.count()).select_from(AdmissionUnit).where(AdmissionUnit.active.is_(True))
        )
        if active:
            return None
        existing = db.scalar(
            select(CrawlRun.id)
            .where(CrawlRun.config_fingerprint == config.config_fingerprint)
            .limit(1)
        )
        if existing:
            return None
        run = create_crawl_run(db, settings, config, trigger_type="startup")
        logger.info("enqueued startup crawl run %s", run.id)
        return run.id


def _renew_lease(sessions, job_id: UUID, token: str) -> bool:
    with sessions.begin() as db:
        job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
        if not job or job.lease_token != token or job.status != "running":
            return False
        job.lease_until = now() + timedelta(minutes=5)
        return True


def _chunks(text: str, size: int, overlap: int = 500, limit: int = 10) -> list[str]:
    if not text:
        return []
    if len(text) <= size:
        return [text]
    step = max(1, size - overlap)
    return [text[i : i + size] for i in range(0, len(text), step)][:limit]


def _norm(text: str) -> str:
    return "".join(unicodedata.normalize("NFKC", text).split())


def _parse_published_at(value) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    raw = value.strip().replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        # Official Chinese pages usually publish dates in Beijing time.
        parsed = parsed.replace(tzinfo=timezone(timedelta(hours=8)))
    return parsed.astimezone(UTC)


def _row_wrapper(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    data = item.get("data")
    evidence = str(item.get("evidence") or "")[:1000]
    locator = str(item.get("locator") or "")[:200]
    confidence = item.get("confidence")
    if not isinstance(confidence, (int, float)):
        confidence = None
    else:
        confidence = max(0.0, min(1.0, float(confidence)))
    base = {
        "row_id": str(uuid4()),
        "evidence": evidence,
        "locator": locator,
        "confidence": confidence,
    }
    try:
        row = AdmissionRow.model_validate(data)
    except ValidationError as exc:
        errors = [
            {"field": ".".join(str(x) for x in error["loc"]), "message": error["msg"]}
            for error in exc.errors()[:10]
        ]
        return {
            **base,
            "data": data if isinstance(data, dict) else {},
            "validation": {"status": "invalid", "errors": errors, "warnings": []},
        }
    normalized = _norm(evidence)
    warnings = []
    if len(normalized) < 8 or normalized not in _norm(str(item.get("_chunk", ""))):
        warnings.append("evidence_unverified")
    dumped = row.model_dump(mode="json")
    fingerprint = hashlib.sha256(
        json.dumps(dumped, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    return {
        **base,
        "row_fingerprint": fingerprint,
        "data": dumped,
        "validation": {"status": "valid", "errors": [], "warnings": warnings},
    }


SPREADSHEET_ALIASES = {
    "school_code": ["学校代码", "院校代码", "院校代号", "学校代号"],
    "school_name": ["学校名称", "院校名称"],
    "short_name": ["学校简称", "院校简称"],
    "unit_code": ["专业代码", "专业代号"],
    "major": ["专业名称", "专业"],
    "plan_count": ["计划数", "招生计划", "计划"],
    "tuition": ["学费", "学费标准"],
    "required_subjects": ["选考科目", "选科要求", "科目要求"],
    "campus": ["校区"],
    "city": ["城市", "所在城市"],
    "school_province": ["院校省份", "学校省份"],
    "batch": ["批次"],
    "rank_cohort": ["位次口径", "统计口径"],
    "score": ["投档分", "分数线", "最低分"],
    "rank": ["位次", "最低位次", "投档位次"],
}
REQUIRED_SPREADSHEET_FIELDS = ("school_code", "school_name", "unit_code", "major")
SUBJECTS = {"物理", "化学", "生物", "历史", "地理", "政治", "技术"}


def _header(value: str) -> str:
    return re.sub(r"\s+", "", value or "")


def _find_column(headers: list[str], field: str) -> int | None:
    for index, raw in enumerate(headers):
        header = _header(raw)
        if not header:
            continue
        if field == "major":
            if header in {"专业", "专业名称"} or "专业名称" in header:
                return index
            continue
        if field == "rank":
            if "位次" in header and "口径" not in header:
                return index
            continue
        if any(alias in header for alias in SPREADSHEET_ALIASES[field]):
            return index
    return None


def _is_document_link(link: dict) -> bool:
    """Attachments are valuable data even when the model overlooks them."""
    haystack = (str(link.get("text") or "") + " " + str(link.get("url") or "")).lower()
    return any(token in haystack for token in (".xls", ".xlsx", ".pdf"))


def _batch_from_title(title: str) -> str:
    match = re.search(r"普通类(?:第)?[一二三四五六七八九十]+段", title or "")
    if not match:
        match = re.search(r"普通类[^，。；\s]{0,6}批", title or "")
    return match.group(0) if match else "待核对"


def _spreadsheet_wrappers(page: FetchedPage, config: AdmissionSourceConfig) -> list[dict]:
    rows = page.table
    if len(rows) < 2:
        return []
    header_index = None
    headers: list[str] = []
    for index, row in enumerate(rows[:10]):
        found = sum(
            1 for field in REQUIRED_SPREADSHEET_FIELDS if _find_column(row, field) is not None
        )
        if found >= 3:
            header_index, headers = index, row
            break
    if header_index is None:
        return []
    columns = {field: _find_column(headers, field) for field in SPREADSHEET_ALIASES}
    if any(columns[field] is None for field in REQUIRED_SPREADSHEET_FIELDS):
        return []

    batch_default = _batch_from_title(page.title)
    wrappers: list[dict] = []

    def value(row: list[str], field: str) -> str:
        index = columns.get(field)
        if index is None or index >= len(row):
            return ""
        return str(row[index]).strip()

    for row_index, row in enumerate(rows[header_index + 1 :], start=header_index + 2):
        if not any(str(cell).strip() for cell in row):
            continue
        school_code = value(row, "school_code")
        school_name = value(row, "school_name")
        unit_code = value(row, "unit_code")
        major = value(row, "major")
        if not all((school_code, school_name, unit_code, major)):
            wrappers.append(
                {
                    "row_id": str(uuid4()),
                    "data": {
                        "school_code": school_code,
                        "school_name": school_name,
                        "unit_code": unit_code,
                        "major": major,
                    },
                    "evidence": " | ".join(str(cell) for cell in row)[:1000],
                    "locator": f"sheet:{page.title or 'sheet'}:row:{row_index}"[:200],
                    "confidence": 1.0,
                    "validation": {
                        "status": "invalid",
                        "errors": [
                            {
                                "field": "row",
                                "message": "缺少学校代码/名称/专业代码/专业名称",
                            }
                        ],
                        "warnings": [],
                    },
                }
            )
            continue

        warnings: list[str] = []
        short_name = value(row, "short_name") or school_name[:20]
        if not value(row, "short_name"):
            warnings.append("short_name_derived")
        city = value(row, "city") or "待核对"
        if not value(row, "city"):
            warnings.append("city_placeholder")
        school_province = value(row, "school_province") or "待核对"
        if not value(row, "school_province"):
            warnings.append("school_province_placeholder")
        batch = value(row, "batch") or batch_default
        if batch == "待核对":
            warnings.append("batch_unconfirmed")
        rank_cohort = value(row, "rank_cohort") or "浙江普通类"
        if not value(row, "rank_cohort"):
            warnings.append("rank_cohort_from_scope")

        raw_subjects = value(row, "required_subjects")
        if not raw_subjects:
            subjects = None
            warnings.append("subjects_unknown")
        elif "不限" in raw_subjects:
            subjects = []
        else:
            subjects = [
                item for item in re.split(r"[、,，/／;；\s]+", raw_subjects) if item in SUBJECTS
            ]
            if not subjects:
                subjects = None
                warnings.append("subjects_unparsed")

        tuition = None
        tuition_match = re.search(r"\d+(?:\.\d+)?", value(row, "tuition").replace(",", ""))
        if tuition_match:
            tuition = float(tuition_match.group(0))
        else:
            warnings.append("tuition_unknown")

        plan_match = re.search(r"\d+", value(row, "plan_count").replace(",", ""))
        plan_count = int(plan_match.group(0)) if plan_match else None
        score = value(row, "score")
        rank = value(row, "rank")
        description_parts = []
        if score:
            description_parts.append(f"2026投档参考分：{score}")
            warnings.append("current_year_reference_in_description")
        if rank:
            description_parts.append(f"位次：{rank}")
        if plan_count is not None:
            description_parts.append(f"计划数：{plan_count}")
        description_parts.append(f"来源：{page.title or '官方表格'}")
        description = "；".join(description_parts)[:3000]

        data = {
            "school_code": school_code,
            "school_name": school_name,
            "short_name": short_name,
            "city": city,
            "school_province": school_province,
            "unit_code": unit_code,
            "unit_type": "major",
            "province_code": config.province_code,
            "exam_year": config.exam_year,
            "exam_category": config.exam_category,
            "batch": batch,
            "rank_cohort": rank_cohort,
            "campus": value(row, "campus") or None,
            "major": major,
            "required_subjects": subjects,
            "tuition": tuition,
            "plan_count": plan_count,
            "additional_requirements": [],
            "history": [],
            "description": description,
        }
        evidence = " | ".join(str(cell) for cell in row)[:1000]
        locator = f"sheet:{page.title or 'sheet'}:row:{row_index}"[:200]
        try:
            model = AdmissionRow.model_validate(data)
        except ValidationError as exc:
            wrappers.append(
                {
                    "row_id": str(uuid4()),
                    "data": data,
                    "evidence": evidence,
                    "locator": locator,
                    "confidence": 1.0,
                    "validation": {
                        "status": "invalid",
                        "errors": [
                            {
                                "field": ".".join(str(x) for x in error["loc"]),
                                "message": error["msg"],
                            }
                            for error in exc.errors()[:10]
                        ],
                        "warnings": warnings,
                    },
                }
            )
            continue
        dumped = model.model_dump(mode="json")
        wrappers.append(
            {
                "row_id": str(uuid4()),
                "row_fingerprint": hashlib.sha256(
                    json.dumps(dumped, sort_keys=True, ensure_ascii=False).encode()
                ).hexdigest(),
                "data": dumped,
                "evidence": evidence,
                "locator": locator,
                "confidence": 1.0,
                "validation": {"status": "valid", "errors": [], "warnings": warnings},
            }
        )
    return wrappers


def _save_page(
    sessions,
    run_id: UUID,
    url: str,
    depth: int,
    *,
    status: str,
    http_status: int | None = None,
    content_type: str | None = None,
    content_hash: str | None = None,
    storage_key: str | None = None,
    title: str | None = None,
    fetched_at: datetime | None = None,
    published_at: datetime | None = None,
    text_chars: int = 0,
    rows: list[dict] | None = None,
    error: str | None = None,
) -> CrawlPage:
    with sessions.begin() as db:
        if content_hash:
            duplicate = db.scalar(
                select(CrawlPage).where(
                    CrawlPage.crawl_run_id == run_id,
                    CrawlPage.content_hash == content_hash,
                    CrawlPage.url != url,
                )
            )
            if duplicate:
                return duplicate
        page = db.scalar(
            select(CrawlPage).where(CrawlPage.crawl_run_id == run_id, CrawlPage.url == url)
        )
        if not page:
            page = CrawlPage(crawl_run_id=run_id, url=url, depth=depth)
            db.add(page)
        page.status = status
        page.http_status = http_status
        page.content_type = content_type
        page.content_hash = content_hash
        page.storage_key = storage_key
        page.title = (title or "")[:300] or None
        page.fetched_at = fetched_at
        page.published_at = published_at
        page.text_chars = text_chars
        page.rows = rows or []
        page.row_count = len(page.rows)
        page.error = (error or "")[:2000] or None
        db.flush()
        return page


def _update_progress(sessions, run_id: UUID, **fields) -> None:
    with sessions.begin() as db:
        run = db.get(CrawlRun, run_id)
        if not run:
            return
        run.progress = {**(run.progress or {}), **fields}


def _fail_run(sessions, run_id: UUID, code: str, message: str) -> None:
    with sessions.begin() as db:
        run = db.scalar(select(CrawlRun).where(CrawlRun.id == run_id).with_for_update())
        if not run or run.status in TERMINAL_STATUSES:
            return
        run.status = "failed"
        run.errors = [
            *(run.errors or []),
            {"code": code, "message": message[:500]},
        ]
        run.finished_at = now()
        run.version += 1


def _error_code(exc: Exception) -> str:
    return {
        FetchBlocked: "FETCH_BLOCKED",
        FetchTooLarge: "FETCH_TOO_LARGE",
        FetchTimeout: "FETCH_TIMEOUT",
        ContentTypeUnsupported: "CONTENT_TYPE_UNSUPPORTED",
        FetchFailed: "FETCH_FAILED",
        ModelCallFailed: "MODEL_CALL_FAILED",
        ModelOutputInvalid: "MODEL_OUTPUT_INVALID",
        ModelNotConfigured: "MODEL_NOT_CONFIGURED",
    }.get(type(exc), "CRAWL_FAILED")


def _add_usage(usage: dict, target: dict) -> None:
    for key in ("prompt_tokens", "completion_tokens", "total_tokens"):
        value = usage.get(key)
        if isinstance(value, (int, float)):
            target[key] = target.get(key, 0) + int(value)


def run_crawl_job(
    sessions,
    settings: Settings,
    run_id: UUID,
    job_id: UUID,
    lease_token: str,
    *,
    gateway=None,
) -> None:
    with sessions.begin() as db:
        run = db.scalar(select(CrawlRun).where(CrawlRun.id == run_id).with_for_update())
        if not run or run.status in TERMINAL_STATUSES:
            return
        try:
            config = AdmissionSourceConfig.model_validate(run.config_snapshot)
        except ValidationError as exc:
            _fail_run(sessions, run_id, "CONFIG_INVALID", str(exc))
            return
        if run.status == "queued":
            run.status = "running"
            run.started_at = now()
            run.version += 1

    owns_gateway = gateway is None
    try:
        if gateway is None:
            gateway = ModelGateway(settings)
    except ModelNotConfigured as exc:
        _fail_run(sessions, run_id, "MODEL_NOT_CONFIGURED", str(exc))
        return

    client = httpx.Client(
        timeout=httpx.Timeout(config.crawl.timeout_seconds),
        follow_redirects=False,
    )
    robots = RobotsCache(client, config)
    queue = deque()
    if config.enabled_sources:
        for source in config.enabled_sources:
            queue.append((source.url, 0, min(source.max_depth, config.discovery.max_depth)))
    else:
        for url in config.discovery.entrypoints:
            queue.append((url, 0, config.discovery.max_depth))

    visited: set[str] = set()
    pages_done = 0
    model_calls = 0
    usage_totals: dict = {}
    warnings: list[str] = []
    errors: list[dict] = []
    deadline = time.monotonic() + config.crawl.max_wall_seconds
    budget_hit = False

    try:
        while queue and pages_done < config.discovery.max_pages and time.monotonic() < deadline:
            url, depth, path_max_depth = queue.popleft()
            url = url.split("#", 1)[0]
            if url in visited:
                continue
            visited.add(url)

            with sessions() as db:
                existing = db.scalar(
                    select(CrawlPage).where(CrawlPage.crawl_run_id == run_id, CrawlPage.url == url)
                )
                existing_status = existing.status if existing else None
                existing_key = existing.storage_key if existing else None
                existing_type = existing.content_type if existing else None
            if existing_status in {"extracted", "skipped"}:
                # On retry, rediscover links from the stored snapshot so a crash
                # after extraction does not strand the rest of the site.
                if (
                    existing_key
                    and depth < path_max_depth
                    and existing_type in {"text/html", "application/xhtml+xml"}
                ):
                    try:
                        raw = blob_path(settings, existing_key).read_bytes()
                        _, _, links = html_text_and_links(raw, url, config, None)
                        for link in sorted(links, key=lambda item: item["score"], reverse=True)[
                            : config.discovery.max_links_per_page
                        ]:
                            queue.append((link["url"], depth + 1, path_max_depth))
                    except Exception:
                        logger.warning("could not rediscover links from %s", url)
                continue

            if not _renew_lease(sessions, job_id, lease_token):
                return

            try:
                page = fetch_page(url, config, client, robots)
            except (
                FetchBlocked,
                FetchTooLarge,
                FetchTimeout,
                ContentTypeUnsupported,
                FetchFailed,
            ) as exc:
                code = _error_code(exc)
                _save_page(
                    sessions,
                    run_id,
                    url,
                    depth,
                    status="failed",
                    error=f"{code}: {exc}",
                )
                errors.append({"url": url, "code": code, "message": str(exc)[:300]})
                pages_done += 1
                _update_progress(
                    sessions,
                    run_id,
                    pages_done=pages_done,
                    current_url=url,
                    model_calls=model_calls,
                    **usage_totals,
                )
                continue

            try:
                storage_key = save_blob(settings, page.content)
            except OSError as exc:
                _save_page(
                    sessions,
                    run_id,
                    url,
                    depth,
                    status="failed",
                    error=f"STORAGE_FAILED: {exc}",
                )
                errors.append({"url": url, "code": "STORAGE_FAILED", "message": str(exc)[:300]})
                pages_done += 1
                continue

            # Step 1: let the model select relevant links (backend still fetches).
            if depth < path_max_depth and page.links:
                # Keep navigation/column links even when their keyword score is
                # zero: the real site exposes admission sections through them.
                candidates = sorted(page.links, key=lambda link: link["score"], reverse=True)[
                    : config.discovery.max_links_per_page
                ]
                if candidates:
                    if model_calls >= config.crawl.max_model_calls:
                        budget_hit = True
                        warnings.append("模型调用预算耗尽，后续链接使用关键词回退")
                    elif time.monotonic() >= deadline:
                        budget_hit = True
                    else:
                        if not _renew_lease(sessions, job_id, lease_token):
                            return
                        try:
                            try:
                                selected, usage = gateway.complete_json(
                                    LINK_SYSTEM,
                                    build_link_prompt(page.url, page.title, candidates),
                                    max_tokens=config.model.max_output_tokens,
                                )
                            except ModelOutputInvalid:
                                # A provider may occasionally wrap JSON in prose.
                                # One stricter retry is cheaper than losing the
                                # attachment path for the whole run.
                                selected, usage = gateway.complete_json(
                                    LINK_SYSTEM,
                                    build_link_prompt(page.url, page.title, candidates)
                                    + "\nReturn a JSON object only, with no prose or code fences.",
                                    max_tokens=config.model.max_output_tokens,
                                )
                            model_calls += 1
                            _add_usage(usage, usage_totals)
                            selected_urls = {
                                item.get("url")
                                for item in selected.get("links", [])
                                if isinstance(item, dict)
                            }
                            for link in candidates:
                                if (
                                    link["url"] in selected_urls or _is_document_link(link)
                                ) and config.host_allowed(urlparse(link["url"]).hostname or ""):
                                    item = (link["url"], depth + 1, path_max_depth)
                                    # Attachments contain the actual admission
                                    # rows; fetch them before ordinary links so
                                    # the page budget cannot starve the XLS.
                                    if _is_document_link(link):
                                        queue.appendleft(item)
                                    else:
                                        queue.append(item)
                        except (ModelCallFailed, ModelOutputInvalid) as exc:
                            errors.append(
                                {
                                    "url": url,
                                    "code": _error_code(exc),
                                    "message": f"链接筛选失败，使用关键词回退：{exc}",
                                }
                            )
                            # Do not flood the small page budget with every
                            # navigation link when the model call fails. Keep
                            # the highest-scored candidates and always keep
                            # attachments, so an article -> XLS path survives.
                            limit = max(8, config.discovery.max_links_per_page // 4)
                            fallback = candidates[:limit]
                            fallback_urls = {link["url"] for link in fallback}
                            fallback.extend(
                                link
                                for link in candidates
                                if _is_document_link(link) and link["url"] not in fallback_urls
                            )
                            for link in fallback:
                                item = (link["url"], depth + 1, path_max_depth)
                                if _is_document_link(link):
                                    queue.appendleft(item)
                                else:
                                    queue.append(item)

            # Step 2: extract rows from the page text.
            rows: list[dict] = []
            published_at: datetime | None = None
            page_warnings: list[str] = []
            if page.table:
                # Large official spreadsheets are parsed deterministically by
                # header names; the model's role was selecting the attachment.
                rows = _spreadsheet_wrappers(page, config)
                if not any(item["validation"]["status"] == "valid" for item in rows):
                    page_warnings.append("表格未识别出可审核行")
            elif page.text.strip():
                for chunk in _chunks(
                    page.text,
                    config.crawl.max_chars_per_call,
                ):
                    if model_calls >= config.crawl.max_model_calls:
                        budget_hit = True
                        warnings.append("模型调用预算耗尽，页面抽取不完整")
                        break
                    if time.monotonic() >= deadline:
                        budget_hit = True
                        warnings.append("抓取时限耗尽，页面抽取不完整")
                        break
                    if not _renew_lease(sessions, job_id, lease_token):
                        return
                    try:
                        extracted, usage = gateway.complete_json(
                            EXTRACT_SYSTEM,
                            build_extraction_prompt(
                                page.url,
                                page.title,
                                chunk,
                                AdmissionRow.model_json_schema(),
                                config.crawl.max_rows_per_call,
                            ),
                            max_tokens=config.model.max_output_tokens,
                        )
                    except ModelOutputInvalid:
                        # One repair attempt, then record the failure.
                        try:
                            extracted, usage = gateway.complete_json(
                                EXTRACT_SYSTEM,
                                build_extraction_prompt(
                                    page.url,
                                    page.title,
                                    chunk,
                                    AdmissionRow.model_json_schema(),
                                    config.crawl.max_rows_per_call,
                                )
                                + "\nReturn valid JSON only.",
                                max_tokens=config.model.max_output_tokens,
                            )
                        except (ModelCallFailed, ModelOutputInvalid) as repair_exc:
                            errors.append(
                                {
                                    "url": url,
                                    "code": _error_code(repair_exc),
                                    "message": str(repair_exc)[:300],
                                }
                            )
                            break
                    except ModelCallFailed as exc:
                        errors.append(
                            {
                                "url": url,
                                "code": _error_code(exc),
                                "message": str(exc)[:300],
                            }
                        )
                        break
                    model_calls += 1
                    _add_usage(usage, usage_totals)
                    if published_at is None:
                        published_at = _parse_published_at(extracted.get("published_at"))
                    page_warnings.extend(
                        str(item)[:300] for item in extracted.get("warnings", [])[:20]
                    )
                    items = extracted.get("rows", [])
                    if not isinstance(items, list):
                        page_warnings.append("模型返回的 rows 不是数组")
                        continue
                    if len(items) > config.crawl.max_rows_per_call:
                        page_warnings.append("模型返回行数超过上限，已截断")
                    for item in items[: config.crawl.max_rows_per_call]:
                        if isinstance(item, dict):
                            item = {**item, "_chunk": chunk}
                        wrapper = _row_wrapper(item)
                        if wrapper:
                            rows.append(wrapper)

            _save_page(
                sessions,
                run_id,
                url,
                depth,
                status="extracted" if page.text.strip() else "skipped",
                http_status=page.http_status,
                content_type=page.content_type,
                content_hash=page.content_hash,
                storage_key=storage_key,
                title=page.title,
                fetched_at=page.fetched_at,
                published_at=published_at,
                text_chars=len(page.text),
                rows=rows,
                error=None if page.text.strip() else "页面没有可用正文",
            )
            warnings.extend(page_warnings)
            pages_done += 1
            _update_progress(
                sessions,
                run_id,
                pages_done=pages_done,
                current_url=url,
                model_calls=model_calls,
                **usage_totals,
            )

        if budget_hit:
            warnings.append("抓取预算/时限耗尽，结果可能不完整")

        with sessions.begin() as db:
            run = db.scalar(select(CrawlRun).where(CrawlRun.id == run_id).with_for_update())
            if not run or run.status in TERMINAL_STATUSES:
                return
            pages = list(
                db.scalars(
                    select(CrawlPage)
                    .where(CrawlPage.crawl_run_id == run_id)
                    .order_by(CrawlPage.created_at, CrawlPage.id)
                )
            )
            aggregated = []
            valid_count = 0
            for page_row in pages:
                for row in page_row.rows or []:
                    aggregated.append(
                        {
                            **row,
                            "page_id": str(page_row.id),
                            "page_url": page_row.url,
                            "page_title": page_row.title,
                        }
                    )
                    if row.get("validation", {}).get("status") == "valid":
                        valid_count += 1
            counts = {
                "total": len(pages),
                "extracted": sum(1 for p in pages if p.status == "extracted"),
                "skipped": sum(1 for p in pages if p.status == "skipped"),
                "failed": sum(1 for p in pages if p.status == "failed"),
                "rows": len(aggregated),
                "valid_rows": valid_count,
                "invalid_rows": len(aggregated) - valid_count,
            }
            run.rows = aggregated
            run.pages_summary = counts
            run.warnings = (run.warnings or []) + warnings
            run.errors = (run.errors or []) + errors
            run.progress = {
                **(run.progress or {}),
                "pages_done": pages_done,
                "model_calls": model_calls,
                **usage_totals,
            }
            run.finished_at = now()
            if valid_count:
                run.status = "awaiting_review"
            else:
                run.status = "failed"
                run.errors = [
                    *run.errors,
                    {
                        "code": "CRAWL_NO_APPROVABLE_PAGES",
                        "message": "没有抽取到可审核的完整招生行",
                    },
                ]
            run.version += 1
    except Exception as exc:
        logger.exception("crawl run %s failed unexpectedly", run_id)
        with sessions.begin() as db:
            run = db.get(CrawlRun, run_id)
            if run and run.status not in TERMINAL_STATUSES:
                run.errors = [
                    *(run.errors or []),
                    {"code": "CRAWL_FAILED", "message": str(exc)[:300]},
                ]
        raise
    finally:
        client.close()
        if owns_gateway:
            gateway.close()


def _load_pages(db, run_id: UUID) -> list[CrawlPage]:
    return list(
        db.scalars(
            select(CrawlPage)
            .where(CrawlPage.crawl_run_id == run_id)
            .order_by(CrawlPage.created_at, CrawlPage.id)
        )
    )


def crawl_run_summary(run: CrawlRun) -> dict:
    return {
        "crawl_run_id": str(run.id),
        "status": run.status,
        "trigger_type": run.trigger_type,
        "created_at": run.created_at.isoformat(),
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "model_name": run.model_name,
        "prompt_version": run.prompt_version,
        "config_fingerprint": run.config_fingerprint,
        "version": run.version,
        "row_count": len(run.rows or []),
        "valid_row_count": (run.pages_summary or {}).get("valid_rows", 0),
        "import_ids": run.import_ids or [],
        "warning_count": len(run.warnings or []),
        "error_count": len(run.errors or []),
    }


def crawl_run_view(db, run: CrawlRun, row_offset: int = 0, row_limit: int = 200) -> dict:
    pages = _load_pages(db, run.id)
    imports = []
    for value in run.import_ids or []:
        try:
            batch = db.get(ImportBatch, UUID(str(value)))
        except ValueError:
            batch = None
        if batch:
            imports.append(
                {
                    "import_id": str(batch.id),
                    "status": batch.status,
                    "errors": batch.errors or [],
                }
            )
    all_rows = run.rows or []
    row_offset = max(0, min(row_offset, len(all_rows)))
    row_limit = max(1, min(row_limit, 1000))
    return {
        **crawl_run_summary(run),
        "progress": run.progress or {},
        "pages_summary": run.pages_summary or {},
        "warnings": run.warnings or [],
        "errors": run.errors or [],
        "rows": all_rows[row_offset : row_offset + row_limit],
        "row_total": len(all_rows),
        "row_offset": row_offset,
        "row_limit": row_limit,
        "imports": imports,
        "review": {
            "reviewed_at": run.reviewed_at.isoformat() if run.reviewed_at else None,
            "reviewed_by": str(run.reviewed_by) if run.reviewed_by else None,
            "reason": run.review_reason,
        },
        "pages": [
            {
                "page_id": str(page.id),
                "url": page.url,
                "depth": page.depth,
                "status": page.status,
                "http_status": page.http_status,
                "content_type": page.content_type,
                "content_hash": page.content_hash,
                "title": page.title,
                "fetched_at": page.fetched_at.isoformat() if page.fetched_at else None,
                "published_at": page.published_at.isoformat() if page.published_at else None,
                "text_chars": page.text_chars,
                "row_count": page.row_count,
                "has_snapshot": bool(page.storage_key),
                "error": page.error,
            }
            for page in pages
        ],
    }


def _preflight_and_build_payloads(
    db,
    run: CrawlRun,
    review: CrawlReviewInput,
    config: AdmissionSourceConfig,
) -> list[ImportInput]:
    pages = _load_pages(db, run.id)
    page_map = {str(page.id): page for page in pages}
    if review.rows_override:
        unknown = set(review.rows_override) - set(page_map)
        if unknown:
            raise DomainError(422, "ROW_INVALID", "rows_override 包含未知页面编号。")

    per_page: dict[str, list[AdmissionRow]] = {}
    for page in pages:
        key = str(page.id)
        if review.rows_override and key in review.rows_override:
            per_page[key] = list(review.rows_override[key])
            continue
        rows = []
        for wrapper in page.rows or []:
            if wrapper.get("validation", {}).get("status") != "valid":
                continue
            try:
                rows.append(AdmissionRow.model_validate(wrapper.get("data")))
            except ValidationError as exc:
                raise DomainError(
                    422, "ROW_INVALID", f"页面 {page.url} 存在非法行：{exc}"
                ) from None
        per_page[key] = rows

    all_rows = [row for rows in per_page.values() for row in rows]
    if not all_rows:
        raise DomainError(422, "CRAWL_NO_APPROVABLE_PAGES", "没有可批准的有效行。")
    keys = [(row.school_code, row.unit_code) for row in all_rows]
    if len(keys) != len(set(keys)):
        raise DomainError(409, "CRAWL_PREFLIGHT_FAILED", "本次抓取包含重复的院校+招生单位编码。")

    supersedes = review.supersedes_import_id
    seen_old_imports: set[str] = set()
    for row in all_rows:
        school = find_school(db, row.school_code, row.school_name)
        if not school:
            continue
        old = list(
            db.scalars(
                select(AdmissionUnit).where(
                    AdmissionUnit.school_id == school.id,
                    AdmissionUnit.unit_code == row.unit_code,
                    AdmissionUnit.active.is_(True),
                )
            )
        )
        old_ids = {str(item.import_id) for item in old}
        if len(old_ids) > 1:
            raise DomainError(
                409,
                "CRAWL_MULTIPLE_SUPERSEDES",
                "同一招生单位存在多个旧导入批次，需人工拆分处理。",
            )
        if old_ids:
            if not supersedes or str(supersedes) not in old_ids:
                raise DomainError(
                    409,
                    "CRAWL_PREFLIGHT_FAILED",
                    "已存在同院校+招生单位的当前版本，请指定正确的 supersedes_import_id。",
                )
            seen_old_imports |= old_ids
    if len(seen_old_imports) > 1:
        raise DomainError(
            409,
            "CRAWL_MULTIPLE_SUPERSEDES",
            "多个页面需要替代不同的旧导入批次，请分批审核。",
        )

    payloads: list[ImportInput] = []
    for page in pages:
        rows = per_page.get(str(page.id), [])
        if not rows:
            continue
        if page.published_at is None:
            if not review.acknowledge_published_at_fallback:
                raise DomainError(
                    422,
                    "CRAWL_PUBLISHED_AT_UNKNOWN",
                    "部分页面没有官方发布时间；请显式确认使用抓取时间。",
                )
            published_at = page.fetched_at or now()
            published_at_source = "retrieved"
        else:
            published_at = page.published_at
            published_at_source = "official"
        title = (page.title or urlparse(page.url).hostname or "自动抓取来源")[:200]
        base_locator = f"auto:crawl:{run.id}:page:{page.id}"
        confidence_values = [
            wrapper.get("confidence")
            for wrapper in page.rows or []
            if isinstance(wrapper.get("confidence"), (int, float))
        ]
        confidence = sum(confidence_values) / len(confidence_values) if confidence_values else None
        chunks = [rows[i : i + 1000] for i in range(0, len(rows), 1000)]
        for index, chunk in enumerate(chunks, start=1):
            locator = base_locator if len(chunks) == 1 else f"{base_locator}:shard:{index}"
            payloads.append(
                ImportInput(
                    source_url=page.url,
                    source_title=title,
                    published_at=published_at,
                    locator=locator[:200],
                    reviewed=True,
                    rows=chunk,
                    supersedes_import_id=supersedes,
                    origin="crawl",
                    crawl_run_id=run.id,
                    crawl_page_id=page.id,
                    config_fingerprint=run.config_fingerprint,
                    raw_content_hash=page.content_hash,
                    model_name=run.model_name,
                    prompt_version=run.prompt_version,
                    confidence=confidence,
                    published_at_source=published_at_source,
                    retrieved_at=page.fetched_at,
                )
            )
    return payloads


def review_crawl(
    db,
    settings: Settings,
    actor: User,
    run_id: UUID,
    review: CrawlReviewInput,
    config: AdmissionSourceConfig | None,
) -> CrawlRun:
    run = db.scalar(select(CrawlRun).where(CrawlRun.id == run_id).with_for_update())
    if not run:
        raise DomainError(404, "RESOURCE_NOT_FOUND", "抓取任务不存在。")
    if run.status != "awaiting_review":
        raise DomainError(409, "CRAWL_STATE_CONFLICT", "当前抓取任务不可审核。")
    if run.version != review.expected_version:
        raise DomainError(409, "CRAWL_VERSION_CONFLICT", "抓取任务已更新，请刷新。")

    run.reviewed_at = now()
    run.reviewed_by = actor.id
    run.review_reason = review.reason
    run.version += 1
    if review.decision == "reject":
        run.status = "rejected"
        return run

    payloads = _preflight_and_build_payloads(db, run, review, config)
    import_ids: list[str] = []
    for payload in payloads:
        batch = enqueue_import(db, settings, actor, payload, config)
        if str(batch.id) not in import_ids:
            import_ids.append(str(batch.id))
    run.import_ids = import_ids
    run.status = "approved"
    run.review_payload = {
        "rows_override": {
            page_id: [row.model_dump(mode="json") for row in rows]
            for page_id, rows in (review.rows_override or {}).items()
        }
        if review.rows_override
        else None,
        "supersedes_import_id": str(review.supersedes_import_id)
        if review.supersedes_import_id
        else None,
        "acknowledge_published_at_fallback": review.acknowledge_published_at_fallback,
    }
    return run


def refresh_crawl_status_for_batch(db, batch: ImportBatch) -> None:
    """Aggregate ImportBatch statuses into the parent crawl run after publish."""
    runs = list(db.scalars(select(CrawlRun).where(CrawlRun.import_ids.contains([str(batch.id)]))))
    for run in runs:
        ids = []
        for value in run.import_ids or []:
            try:
                ids.append(UUID(str(value)))
            except ValueError:
                continue
        batches = (
            list(db.scalars(select(ImportBatch).where(ImportBatch.id.in_(ids)))) if ids else []
        )
        if not batches:
            continue
        statuses = {item.status for item in batches}
        if statuses & {"queued", "running"}:
            status = "publishing"
        elif statuses == {"published"}:
            status = "succeeded"
        elif statuses == {"failed"}:
            status = "failed"
        elif "published" in statuses:
            status = "partial"
        else:
            status = "publishing"
        if run.status != status:
            run.status = status
            run.version += 1
