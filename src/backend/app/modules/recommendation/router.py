import asyncio
import json
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Header, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import Field
from sqlalchemy import select

from app.core.errors import DomainError, missing, result
from app.core.security import current_user, digest, throttle
from app.db.models import RecommendationRun, RunEvent, SessionToken, User, now
from app.db.session import get_db
from app.modules.admissions.service import active_units, school_views, unit_view
from app.modules.community.content import plan_record, plan_view
from app.modules.community.schemas import StrictModel
from app.modules.profiles.service import current_profile
from app.modules.recommendation.service import (
    AnswerInput,
    LegacyRecommendation,
    RunInput,
    answer_run,
    create_run,
    emit,
    evaluate_snapshot,
    owned_run,
    rules,
    run_view,
)

router = APIRouter(prefix="/api/v1", tags=["recommendations"])


@router.post("/recommendations")
def recommend(
    data: RunInput | LegacyRecommendation,
    request: Request,
    idempotency_key: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    throttle(request, "recommendation")
    if isinstance(data, RunInput):
        run = create_run(db, request.app.state.settings, user, data, idempotency_key)
        db.commit()
        return JSONResponse(status_code=202, content=result(request, run_view(run)))
    # Transitional legacy adapter: same deterministic rules and immutable snapshots.
    run = create_run(
        db,
        request.app.state.settings,
        user,
        RunInput(question="当前画像候选比较"),
        idempotency_key or str(uuid4()),
    )
    if not run.snapshot["profile"]:
        db.rollback()
        raise DomainError(422, "PROFILE_INCOMPLETE", "请先完善考生画像。")
    evaluated = run.result
    if evaluated is None:
        evaluated = evaluate_snapshot(run.snapshot)
        run.result, run.status = evaluated, "succeeded"
        emit(db, run, "result", evaluated)
        emit(db, run, "done", {"status": "succeeded"})
    visible = {s["id"] for s in school_views(db)}
    recommendations = []
    for item in [*evaluated["items"], *evaluated["pending_confirmation"]]:
        if item["school_id"] not in visible:
            continue
        score = item["preference_match"]["score"]
        recommendations.append(
            {
                "schoolId": item["school_id"],
                "major": item["major"],
                "tier": "unknown",
                "matchScore": round(score * 100) if score is not None else None,
                "reasons": item["reasons"],
                "warnings": [
                    *item["warnings"],
                    item["historical_risk"]["reason"],
                    "M1 未校准冲稳保阈值，本项为待核对候选，不表示已满足全部条件",
                ],
                "sourceIds": item["evidence_ids"],
                "postIds": [],
            }
        )
    db.commit()
    return result(request, recommendations)


class Explanation(StrictModel):
    schoolId: UUID


@router.post("/recommendations/explain")
def explain(data: Explanation, request: Request, user=Depends(current_user), db=Depends(get_db)):
    profile = current_profile(db, user.id)
    if not profile:
        raise DomainError(422, "PROFILE_INCOMPLETE", "请先完善考生画像。")
    units = [u for u in active_units(db) if u.school_id == data.schoolId]
    if not units:
        missing()
    decisions = [rules(profile.data, unit_view(u)) for u in units]
    text = "；".join(
        f"{d['major']}：{d['eligibility']['status']}，"
        + "、".join(
            d["eligibility"]["failed_requirements"] + d["eligibility"]["missing_requirements"]
            or ["当前已知硬条件满足"]
        )
        for d in decisions
    )
    return result(
        request, {"text": text, "sourceIds": list(dict.fromkeys(str(u.source_id) for u in units))}
    )


@router.get("/recommendations/{run_id}")
def get_run(run_id: UUID, request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(request, run_view(owned_run(db, run_id, user.id)))


@router.post("/recommendations/{run_id}/answers", status_code=202)
def answers(
    run_id: UUID,
    data: AnswerInput,
    request: Request,
    user=Depends(current_user),
    db=Depends(get_db),
):
    run = answer_run(db, user, run_id, data)
    db.commit()
    return result(request, run_view(run))


@router.post("/recommendations/{run_id}/cancel", status_code=202)
def cancel(run_id: UUID, request: Request, user=Depends(current_user), db=Depends(get_db)):
    run = owned_run(db, run_id, user.id, lock=True)
    if run.status == "cancelled":
        return result(request, run_view(run))
    if run.status in {"succeeded", "failed"}:
        raise DomainError(409, "RUN_STATE_CONFLICT", "任务已结束。")
    run.cancelled, run.status = True, "cancelled"
    emit(db, run, "done", {"status": "cancelled"})
    db.commit()
    return result(request, run_view(run))


@router.get("/recommendations/{run_id}/validation")
def validation(run_id: UUID, request: Request, user=Depends(current_user), db=Depends(get_db)):
    run = owned_run(db, run_id, user.id)
    return result(request, run.result.get("validation") if run.result else None)


@router.get("/recommendations/{run_id}/events")
def events(
    run_id: UUID,
    request: Request,
    last_event_id: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    run = owned_run(db, run_id, user.id)
    try:
        cursor = int(last_event_id or "0")
        if not 0 <= cursor <= run.event_seq:
            raise ValueError()
    except ValueError:
        raise DomainError(
            422, "EVENT_CURSOR_INVALID", "事件编号无效，请通过任务详情恢复状态。"
        ) from None
    owner_id, token_hash = user.id, digest(request.cookies["nv_session"])
    sessions = request.app.state.sessions
    db.rollback()

    async def stream():
        nonlocal cursor
        yield "retry: 1000\n\n"
        for _ in range(25):
            if await request.is_disconnected():
                return
            with sessions() as session:
                active = session.scalar(
                    select(User.id)
                    .join(SessionToken, SessionToken.user_id == User.id)
                    .where(
                        SessionToken.token_hash == token_hash,
                        SessionToken.expires_at > now(),
                        User.active.is_(True),
                    )
                )
                current = session.get(RecommendationRun, run_id)
                if not active or not current or current.owner_id != owner_id:
                    return
                rows = list(
                    session.scalars(
                        select(RunEvent)
                        .where(RunEvent.run_id == run_id, RunEvent.event_id > cursor)
                        .order_by(RunEvent.event_id)
                    )
                )
                ended = current.status in {"succeeded", "failed", "cancelled", "waiting_input"}
                for row in rows:
                    payload = {
                        "event_id": row.event_id,
                        "event_type": row.event_type,
                        "run_id": str(run_id),
                        "timestamp": row.timestamp.isoformat(),
                        "payload": row.payload,
                    }
                    cursor = row.event_id
                    yield f"id: {cursor}\nevent: {row.event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"
            if ended:
                return
            yield ": heartbeat\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


class PlanEntry(StrictModel):
    id: str = Field(min_length=1, max_length=100)
    schoolId: UUID
    major: str = Field(min_length=1, max_length=100)
    adjustment: bool


class PlanInput(StrictModel):
    id: UUID
    version: int = Field(ge=1)
    name: str = Field(min_length=1, max_length=120)
    entries: list[PlanEntry] = Field(max_length=40)


@router.put("/me/plan")
def save_plan(data: PlanInput, request: Request, user=Depends(current_user), db=Depends(get_db)):
    plan = plan_record(db, user)
    if data.id != plan.id:
        missing()
    if data.version != plan.version:
        raise DomainError(409, "PLAN_VERSION_CONFLICT", "方案已更新，请刷新后重试。")
    if len({e.id for e in data.entries}) != len(data.entries):
        raise DomainError(422, "INVALID_INPUT", "志愿条目编号不能重复。")
    units = active_units(db)
    for entry in data.entries:
        if not any(u.school_id == entry.schoolId and u.data["major"] == entry.major for u in units):
            raise DomainError(422, "PLAN_INVALID", "专业不属于该校当前招生单位。")
    plan.entries = [entry.model_dump(mode="json") for entry in data.entries]
    plan.name, plan.version = data.name, plan.version + 1
    db.commit()
    return result(request, plan_view(plan))


class SimulationInput(StrictModel):
    planId: UUID
    version: int = Field(ge=1)


@router.post("/plans/simulations")
def simulation(
    data: SimulationInput, request: Request, user=Depends(current_user), db=Depends(get_db)
):
    plan = plan_record(db, user)
    if plan.id != data.planId:
        missing()
    if plan.version != data.version:
        raise DomainError(409, "PLAN_VERSION_CONFLICT", "方案已更新，请刷新。")
    profile = current_profile(db, user.id)
    if not profile:
        raise DomainError(422, "PROFILE_INCOMPLETE", "请先完善考生画像。")
    units = active_units(db)
    valid = bool(plan.entries)
    warnings = ["仅检查当前已知条件，未实现完整投档与志愿顺序模拟。"]
    for entry in plan.entries:
        matches = [
            u
            for u in units
            if str(u.school_id) == entry["schoolId"] and u.data["major"] == entry["major"]
        ]
        decisions = [rules(profile.data, unit_view(u)) for u in matches]
        if len(decisions) != 1 or decisions[0]["eligibility"]["status"] != "pass":
            valid = False
            warnings.append(f"{entry['major']} 的校区、条件或招生单位需核对。")
    db.commit()
    return result(
        request,
        {
            "eligible": valid,
            "warnings": warnings,
            "assessment": "不计算录取概率；请核对最新官方政策。",
            "basisYear": profile.data["year"],
            "probabilities": None,
        },
    )
