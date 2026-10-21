"""Admin-only staged national catalog API."""

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from fastapi.responses import FileResponse
from pydantic import Field
from sqlalchemy import select

from app.core.errors import DomainError, missing, result
from app.core.security import admin, fingerprint, idempotency, throttle
from app.core.storage import blob_path
from app.db.models import Idempotency, Job, SchoolCatalogRun, now
from app.db.session import get_db
from app.modules.catalog.dto import ConfigView, Detail, Envelope, Page, Summary
from app.modules.catalog.service import enqueue, publish, summarize
from app.modules.catalog.source import load_config
from app.modules.community.schemas import StrictModel

router = APIRouter(
    prefix="/api/v1/admin/school-catalog",
    tags=["national school catalog"],
    responses={
        401: {"description": "需要登录"},
        403: {"description": "仅管理员"},
        404: {"description": "对象不存在"},
        409: {"description": "状态或版本冲突"},
        422: {"description": "输入或审核条件不满足"},
        503: {"description": "官方来源或AI不可用"},
    },
)


class Expected(StrictModel):
    expected_version: int = Field(ge=1)


class Review(Expected):
    decision: Literal["approve", "reject"]
    reason: str = Field(min_length=1, max_length=2000)
    identifiers: list[str] | None = Field(default=None, max_length=10000)
    acknowledge_analysis: bool = False


def locked(db, run_id):
    run = db.scalar(select(SchoolCatalogRun).where(SchoolCatalogRun.id == run_id).with_for_update())
    if not run:
        missing()
    return run


def key_for(db, request, actor, operation, run_id, key, body):
    signature = fingerprint(request.app.state.settings.app_secret, body)
    scoped, previous = idempotency(db, f"catalog:{operation}:{actor.id}:{run_id}", key, signature)
    return scoped, previous, signature


def remember(db, key, signature, run):
    db.add(Idempotency(key=key, fingerprint=signature, resource_id=run.id))
    db.commit()


@router.get("/config", response_model=Envelope[ConfigView])
def config(request: Request, actor=Depends(admin)):
    settings = request.app.state.settings
    value = load_config(settings)
    return result(
        request,
        {
            "enabled": value.enabled,
            "auto_start": value.auto_start,
            "model_configured": settings.model_configured,
            "model_name": settings.model_name,
            "publication_url": value.publication_url,
            "scope": "教育部全国普通及成人高校名录（名单不含港澳台）",
            "config_fingerprint": value.fingerprint,
        },
    )


@router.get("/runs", response_model=Envelope[Page])
def runs(
    request: Request, offset: int = Query(default=0, ge=0), actor=Depends(admin), db=Depends(get_db)
):
    records = list(
        db.scalars(
            select(SchoolCatalogRun)
            .order_by(SchoolCatalogRun.created_at.desc(), SchoolCatalogRun.id)
            .offset(offset)
            .limit(21)
        )
    )
    return result(
        request,
        {
            "items": [summarize(run) for run in records[:20]],
            "next_offset": offset + 20 if len(records) > 20 else None,
        },
    )


@router.post("/runs", status_code=202, response_model=Envelope[Summary])
def trigger(
    request: Request,
    idempotency_key: str | None = Header(default=None),
    actor=Depends(admin),
    db=Depends(get_db),
):
    throttle(request, "crawl")
    settings = request.app.state.settings
    value = load_config(settings)
    key, previous, signature = key_for(
        db, request, actor, "fetch", "new", idempotency_key, {"config": value.fingerprint}
    )
    if previous:
        run = db.get(SchoolCatalogRun, previous.resource_id)
        if not run:
            missing()
    else:
        run = enqueue(db, settings, actor)
        if not run:
            raise DomainError(409, "CATALOG_DISABLED", "全国名录同步已在配置中关闭。")
        remember(db, key, signature, run)
    return result(request, summarize(run))


@router.get("/runs/{run_id}", response_model=Envelope[Detail])
def detail(
    run_id: UUID,
    request: Request,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=100, ge=1, le=200),
    kind: Literal["all", "new", "changed", "unchanged", "conflict"] = "all",
    q: str = Query(default="", max_length=100),
    actor=Depends(admin),
    db=Depends(get_db),
):
    run = db.get(SchoolCatalogRun, run_id)
    if not run:
        missing()
    changes = [
        change
        for change in run.changes
        if (kind == "all" or change["kind"] == kind)
        and (not q or q in change["name"] or q in change["identifier"])
    ]
    snapshot = {
        **run.snapshot,
        "snapshots": [
            {k: v for k, v in item.items() if k != "storage_key"}
            for item in run.snapshot.get("snapshots", [])
        ],
    }
    return result(
        request,
        {
            **summarize(run),
            "snapshot": snapshot,
            "analysis": run.analysis,
            "changes": changes[offset : offset + limit],
            "total": len(changes),
            "next_offset": offset + limit if offset + limit < len(changes) else None,
        },
    )


@router.get(
    "/runs/{run_id}/snapshots/{index}",
    response_class=FileResponse,
    responses={
        200: {
            "description": "官方名录原始快照",
            "content": {
                "application/octet-stream": {"schema": {"type": "string", "format": "binary"}}
            },
        }
    },
)
def raw(run_id: UUID, index: int, request: Request, actor=Depends(admin), db=Depends(get_db)):
    run = db.get(SchoolCatalogRun, run_id)
    snapshots = run.snapshot.get("snapshots", []) if run else []
    if index < 0 or index >= len(snapshots):
        missing()
    path = blob_path(request.app.state.settings, snapshots[index]["storage_key"])
    if not path.is_file():
        missing()
    return FileResponse(
        path,
        media_type="application/octet-stream",
        filename=f"catalog-{run_id}-{index}.bin",
        headers={"Cache-Control": "no-store", "Content-Security-Policy": "sandbox"},
    )


@router.post("/runs/{run_id}/analyze", status_code=202, response_model=Envelope[Summary])
def analyze(
    run_id: UUID,
    data: Expected,
    request: Request,
    idempotency_key: str | None = Header(default=None),
    actor=Depends(admin),
    db=Depends(get_db),
):
    throttle(request, "crawl")
    key, previous, signature = key_for(
        db, request, actor, "analyze", run_id, idempotency_key, data.model_dump()
    )
    run = locked(db, run_id)
    if previous:
        return result(request, summarize(run))
    if not request.app.state.settings.model_configured:
        raise DomainError(503, "MODEL_NOT_CONFIGURED", "请先配置AI服务，再分析已抓取的资料。")
    if run.version != data.expected_version or run.status not in {
        "analysis_pending",
        "awaiting_review",
    }:
        raise DomainError(409, "CATALOG_STATE_CONFLICT", "任务状态或版本已变化，请刷新。")
    run.status, run.error, run.analysis = "analyzing", None, {}
    run.version += 1
    db.add(
        Job(
            task_type="catalog_analyze",
            object_id=run.id,
            source_version=run.version,
            processor_version="catalog-v1",
        )
    )
    remember(db, key, signature, run)
    return result(request, summarize(run))


@router.post("/runs/{run_id}/review", response_model=Envelope[Summary])
def review(
    run_id: UUID,
    data: Review,
    request: Request,
    idempotency_key: str | None = Header(default=None),
    actor=Depends(admin),
    db=Depends(get_db),
):
    key, previous, signature = key_for(
        db, request, actor, "review", run_id, idempotency_key, data.model_dump()
    )
    run = locked(db, run_id)
    if previous:
        return result(request, summarize(run))
    if run.version != data.expected_version or run.status not in {
        "analysis_pending",
        "awaiting_review",
    }:
        raise DomainError(409, "CATALOG_STATE_CONFLICT", "任务已处理或版本变化，请刷新。")
    if data.decision == "reject":
        run.status, run.reviewed_by, run.reviewed_at = "rejected", actor.id, now()
        run.review = {"decision": "reject", "reason": data.reason}
        run.version += 1
    else:
        if run.status != "awaiting_review" or run.analysis.get("rows_analyzed") != len(run.changes):
            raise DomainError(409, "CATALOG_ANALYSIS_REQUIRED", "必须完成全量AI分析后再决定更新。")
        if not data.acknowledge_analysis:
            raise DomainError(
                422, "CATALOG_REVIEW_REQUIRED", "请确认已核对官方原件、新旧差异和AI告警。"
            )
        publish(db, run, actor, data.identifiers, data.reason)
    remember(db, key, signature, run)
    return result(request, summarize(run))
