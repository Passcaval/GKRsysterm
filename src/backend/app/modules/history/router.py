from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import Field
from sqlalchemy import select

from app.core.errors import DomainError, result
from app.core.security import admin, current_user, fingerprint, idempotency
from app.db.models import Feedback, Idempotency, RecommendationRun
from app.db.session import get_db
from app.modules.community.schemas import StrictModel
from app.modules.recommendation.service import owned_run, run_view

router = APIRouter(prefix="/api/v1", tags=["feedback and history"])


@router.get("/admin/feedback")
def corrections(
    request: Request,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=30, ge=1, le=100),
    actor=Depends(admin),
    db=Depends(get_db),
):
    """Human verification queue; feedback never mutates official data automatically."""
    rows = db.scalars(
        select(Feedback)
        .where(Feedback.kind == "correction")
        .order_by(Feedback.created_at.desc(), Feedback.id)
        .offset(offset)
        .limit(limit)
    )
    return result(
        request,
        {
            "items": [
                {
                    "feedback_id": str(f.id),
                    "run_id": str(f.run_id),
                    "recommendation_item_id": f.recommendation_item_id,
                    "reason": f.reason,
                    "created_at": f.created_at.isoformat(),
                    "status": "needs_manual_verification",
                }
                for f in rows
            ],
            "offset": offset,
            "limit": limit,
        },
    )


class FeedbackInput(StrictModel):
    run_id: UUID
    recommendation_item_id: str
    kind: Literal["preference", "correction", "satisfaction", "outcome"]
    reason: str = Field(min_length=1, max_length=2000)


@router.post("/feedback", status_code=201)
def feedback(
    data: FeedbackInput,
    request: Request,
    idempotency_key: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    signature = fingerprint(request.app.state.settings.app_secret, data.model_dump())
    key, previous = idempotency(db, "feedback:" + str(user.id), idempotency_key, signature)
    if previous:
        return result(request, {"feedback_id": str(previous.resource_id), "accepted": True})
    run = owned_run(db, data.run_id, user.id, lock=True)
    if not run.result or data.recommendation_item_id not in {
        item["recommendation_item_id"]
        for group in ("items", "pending_confirmation", "excluded")
        for item in run.result.get(group, [])
    }:
        raise DomainError(422, "FEEDBACK_TARGET_INVALID", "反馈必须关联本次推荐中的具体条目。")
    record = Feedback(
        owner_id=user.id,
        run_id=run.id,
        profile_version_id=run.profile_version_id,
        recommendation_item_id=data.recommendation_item_id,
        kind=data.kind,
        reason=data.reason,
    )
    db.add(record)
    db.flush()
    db.add(Idempotency(key=key, fingerprint=signature, resource_id=record.id))
    db.commit()
    return result(request, {"feedback_id": str(record.id), "accepted": True})


@router.get("/me/history")
def history(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(
        request,
        [
            run_view(run)
            for run in db.scalars(
                select(RecommendationRun)
                .where(RecommendationRun.owner_id == user.id)
                .order_by(RecommendationRun.created_at.desc())
            )
        ],
    )
