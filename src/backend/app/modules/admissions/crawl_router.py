"""Admin-only admission crawl endpoints (backend-only, not shared v0.4 ops)."""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Query, Request
from fastapi.responses import FileResponse
from sqlalchemy import select

from app.core.errors import DomainError, missing, result
from app.core.security import admin, fingerprint, idempotency, throttle
from app.core.storage import blob_path
from app.db.models import CrawlPage, CrawlRun, Idempotency
from app.db.session import get_db
from app.modules.admissions.crawl_service import (
    CrawlReviewInput,
    crawl_run_summary,
    crawl_run_view,
    create_crawl_run,
    review_crawl,
)
from app.modules.community.schemas import StrictModel

router = APIRouter(prefix="/api/v1", tags=["admissions crawl"])

STATUSES = {
    "queued",
    "running",
    "awaiting_review",
    "approved",
    "publishing",
    "succeeded",
    "partial",
    "rejected",
    "failed",
    "cancelled",
}


class CrawlTrigger(StrictModel):
    pass


def _config(request: Request):
    return getattr(request.app.state, "admission_config", None)


def _config_error(request: Request) -> str | None:
    return getattr(request.app.state, "admission_config_error", None)


@router.get("/admin/admission-sources")
def admission_sources(request: Request, actor=Depends(admin)):
    settings = request.app.state.settings
    config = _config(request)
    return result(
        request,
        {
            "config_path": str(settings.admission_sources_file),
            "config_error": _config_error(request),
            "model_configured": settings.model_configured,
            "model_name": settings.model_name,
            "config": config.summary() if config else None,
        },
    )


@router.get("/admin/admissions/crawl")
def crawl_runs(
    request: Request,
    status: str | None = None,
    cursor: str | None = None,
    limit: int = Query(default=20, ge=1, le=50),
    actor=Depends(admin),
    db=Depends(get_db),
):
    if status is not None and status not in STATUSES:
        raise DomainError(422, "INVALID_INPUT", "未知抓取状态。")
    try:
        offset = int(cursor or "0")
        if offset < 0:
            raise ValueError()
    except ValueError:
        raise DomainError(422, "CURSOR_INVALID", "分页游标不正确。") from None
    statement = select(CrawlRun).order_by(CrawlRun.created_at.desc(), CrawlRun.id)
    if status is not None:
        statement = statement.where(CrawlRun.status == status)
    rows = list(db.scalars(statement.offset(offset).limit(limit + 1)))
    has_more = len(rows) > limit
    rows = rows[:limit]
    return result(
        request,
        {
            "items": [crawl_run_summary(row) for row in rows],
            "next_cursor": str(offset + limit) if has_more else None,
        },
    )


@router.post("/admin/admissions/crawl", status_code=202)
def trigger_crawl(
    request: Request,
    data: CrawlTrigger | None = Body(default=None),
    idempotency_key: str | None = Header(default=None),
    actor=Depends(admin),
    db=Depends(get_db),
):
    throttle(request, "crawl")
    settings = request.app.state.settings
    config = _config(request)
    if config is None:
        raise DomainError(
            503,
            "CONFIG_INVALID",
            _config_error(request) or "招生来源配置不可用。",
        )
    if not settings.model_configured:
        raise DomainError(
            503, "MODEL_NOT_CONFIGURED", "未配置 MODEL_BASE_URL/MODEL_API_KEY/MODEL_NAME。"
        )
    if not config.enabled_sources and not config.discovery.enabled:
        raise DomainError(422, "SOURCES_NOT_CONFIGURED", "配置中没有可用招生来源。")
    signature = fingerprint(
        settings.app_secret,
        {"config": config.config_fingerprint, "body": data.model_dump() if data else {}},
    )
    key, previous = idempotency(db, "crawl:" + str(actor.id), idempotency_key, signature)
    if previous:
        run = db.get(CrawlRun, previous.resource_id)
        if not run:
            missing()
        return result(request, crawl_run_summary(run))
    run = create_crawl_run(db, settings, config, trigger_type="admin", triggered_by=actor.id)
    db.add(Idempotency(key=key, fingerprint=signature, resource_id=run.id))
    db.commit()
    return result(request, crawl_run_summary(run))


@router.get("/admin/admissions/crawl/{run_id}")
def crawl_run_detail(
    run_id: UUID,
    request: Request,
    row_offset: int = Query(default=0, ge=0),
    row_limit: int = Query(default=200, ge=1, le=1000),
    actor=Depends(admin),
    db=Depends(get_db),
):
    run = db.get(CrawlRun, run_id)
    if not run:
        missing()
    return result(request, crawl_run_view(db, run, row_offset, row_limit))


@router.get("/admin/admissions/crawl/{run_id}/pages/{page_id}/raw")
def crawl_page_raw(
    run_id: UUID,
    page_id: UUID,
    request: Request,
    actor=Depends(admin),
    db=Depends(get_db),
):
    page = db.get(CrawlPage, page_id)
    if not page or page.crawl_run_id != run_id:
        missing()
    if not page.storage_key:
        raise DomainError(410, "SNAPSHOT_PURGED", "该页面没有保存原始快照。")
    path = blob_path(request.app.state.settings, page.storage_key)
    if not path.is_file():
        raise DomainError(410, "SNAPSHOT_PURGED", "原始快照已过期清理。")
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=f"crawl-{page.id}.bin",
        headers={
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.post("/admin/admissions/crawl/{run_id}/review")
def review(
    run_id: UUID,
    data: CrawlReviewInput,
    request: Request,
    idempotency_key: str | None = Header(default=None),
    actor=Depends(admin),
    db=Depends(get_db),
):
    settings = request.app.state.settings
    signature = fingerprint(
        settings.app_secret,
        {"run_id": str(run_id), "body": data.model_dump(mode="json")},
    )
    key, previous = idempotency(
        db, "crawl-review:" + str(actor.id) + ":" + str(run_id), idempotency_key, signature
    )
    run = db.get(CrawlRun, run_id)
    if not run:
        missing()
    if previous:
        return result(request, crawl_run_view(db, run))
    updated = review_crawl(db, settings, actor, run_id, data, _config(request))
    db.add(Idempotency(key=key, fingerprint=signature, resource_id=updated.id))
    db.commit()
    return result(request, crawl_run_view(db, updated))
