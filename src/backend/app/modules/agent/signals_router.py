"""Explicit confirmation endpoint for chat-derived profile proposals."""

from __future__ import annotations

from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from pydantic import Field
from sqlalchemy import select

from app.core.errors import DomainError, missing, result
from app.core.security import current_user
from app.db.models import ChatProfileSignal, User, now
from app.db.session import get_db
from app.modules.agent.profile_signals import signal_view
from app.modules.community.schemas import StrictModel
from app.modules.profiles.service import current_profile, save_profile
from app.modules.protocol.service import InternalProfile, profile_view

router = APIRouter(prefix="/api/v1", tags=["chat profile calibration"])


class SignalDecision(StrictModel):
    decision: Literal["confirm", "reject"]
    expected_version: int = Field(ge=0)


@router.post("/chat/profile-signals/{signal_id}/resolve")
def resolve_signal(
    signal_id: UUID,
    data: SignalDecision,
    request: Request,
    user=Depends(current_user),
    db=Depends(get_db),
):
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    signal = db.scalar(
        select(ChatProfileSignal)
        .where(ChatProfileSignal.id == signal_id, ChatProfileSignal.owner_id == user.id)
        .with_for_update()
    )
    if not signal or signal.owner_id != user.id:
        missing()
    if signal.status != "proposed":
        raise DomainError(409, "SIGNAL_ALREADY_RESOLVED", "这条画像建议已经处理过了。")
    current = current_profile(db, user.id)
    if not current:
        raise DomainError(409, "PROFILE_MISSING", "请先创建考生画像，再确认更新。")
    if data.decision == "reject":
        signal.status = "rejected"
        signal.resolved_at = now()
        db.commit()
        return result(
            request,
            {"signal": signal_view(signal), "profile": profile_view(current)},
        )
    if data.expected_version != current.version:
        raise DomainError(
            409,
            "PROFILE_VERSION_CONFLICT",
            "画像已在其他页面更新，请刷新后再确认。",
        )
    values = dict(current.data)
    allowed = {"province", "year", "score", "rank", "subjects", "cities", "interests", "schools"}
    for change in signal.changes or []:
        field = change.get("field")
        if field not in allowed:
            continue
        values[field] = change.get("new")
    try:
        saved = save_profile(
            db,
            user.id,
            InternalProfile.model_validate(values),
            data.expected_version,
        )
    except ValueError:
        raise DomainError(422, "PROFILE_INVALID", "画像更新内容不合法，请手动修改。") from None
    signal.status = "confirmed"
    signal.resolved_at = now()
    db.commit()
    return result(
        request,
        {"signal": signal_view(signal), "profile": profile_view(saved)},
    )
