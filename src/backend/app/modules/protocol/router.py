"""Production v0.4 API. Reuses transactional domain services, never browser mock logic."""

import json
import re
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Body, Depends, Header, Request, Response
from jsonschema import Draft202012Validator
from pydantic import ValidationError
from sqlalchemy import delete, select

from app.core.errors import DomainError, missing, result
from app.core.security import (
    admin,
    current_user,
    digest,
    fingerprint,
    idempotency,
    optional_user,
    reviewer,
    throttle,
)
from app.db.models import (
    Application,
    Idempotency,
    Job,
    Post,
    PostRevision,
    ProfileVersion,
    RecommendationRun,
    RegistrationEvidence,
    School,
    User,
)
from app.db.session import get_db
from app.modules.admissions.service import active_units, school_views
from app.modules.agent.profile_signals import extract_profile_values
from app.modules.community import content, registration
from app.modules.community import router as accounts
from app.modules.community.schemas import Decision, Login, PostFeedbackInput
from app.modules.history.router import FeedbackInput, feedback
from app.modules.profiles.service import current_profile, save_profile
from app.modules.protocol.service import (
    application_view,
    internal_profile,
    optional_questions,
    page,
    profile_view,
    questions,
    run_view,
    source_view,
    unit_view,
    user_view,
    wire,
)
from app.modules.recommendation import router as old_recommendations
from app.modules.recommendation.service import RunInput, create_run, emit, owned_run, rules

router = APIRouter(prefix="/api/v1", tags=["M0-M1 v0.4"])
CONTRACT = json.loads(
    (Path(__file__).resolve().parents[5] / "docs/contracts/openapi.json").read_text(
        encoding="utf-8"
    )
)


def validate(name, data):
    schema = {"$ref": "#/components/schemas/" + name, "components": CONTRACT["components"]}
    if next(Draft202012Validator(schema).iter_errors(data), None):
        raise DomainError(422, "INVALID_INPUT", "字段类型、范围或格式不正确，请重新输入。")
    return data


def uuid(value):
    try:
        return UUID(str(value))
    except ValueError:
        raise DomainError(422, "INVALID_INPUT", "对象编号不正确。") from None


def not_implemented():
    raise DomainError(
        503, "FEATURE_NOT_AVAILABLE", "此功能尚未在 M0–M1 接入，请使用结构化画像及官方资料推荐。"
    )


def all_schools(db):
    # v0.4 permits unknown ranks and tuition. Never omit unknown-only schools.
    units = active_units(db)
    grouped: dict = {}
    for unit in units:
        grouped.setdefault(unit.school_id, []).append(unit)
    views = {s["id"]: wire(s) for s in school_views(db, units)}
    for s in db.scalars(select(School).order_by(School.code)):
        group = grouped.get(s.id, [])
        if str(s.id) not in views:
            views[str(s.id)] = {
                "id": str(s.id),
                **s.data,
                "level": "待核对",
                "type": "待核对",
                "rank": None,
                "tuition": None,
                "majors": list(dict.fromkeys(u.data["major"] for u in group)),
                "required_subjects": [],
                "description": "请按具体招生单位核对条件",
                "color": "#d9b56d",
                "x": 50,
                "y": 50,
                "source_ids": list(dict.fromkeys(str(u.source_id) for u in group)),
                "history": [],
            }
        views[str(s.id)]["historical_risk"] = "unknown"
        basic = s.data.get("catalog_basic")
        if basic:
            views[str(s.id)]["level"] = basic["education_level"]
            views[str(s.id)]["description"] = (
                f"学校标识码：{basic['identifier']}；主管部门：{basic['department']}；"
                f"类别：{'普通高等学校' if basic['category'] == 'ordinary' else '成人高等学校'}；"
                f"备注：{basic.get('remarks') or '无'}。基础名录不表示已取得该校招生计划。"
            )
            views[str(s.id)]["source_ids"] = list(
                dict.fromkeys([*views[str(s.id)]["source_ids"], *s.data.get("source_ids", [])])
            )
    return list(views.values())


def post_view(db, post, actor=None):
    return {
        **wire(content.post_view(db, post, actor)),
        "version": post.version,
        "visibility": post.data.get("visibility", "public"),
        "claims": [],
        "campus_id": post.data.get("campus_id"),
        "major_id": post.data.get("major_id"),
        "experienced_at": post.data.get("experienced_at"),
    }


def visible(post, actor):
    return (
        post.status == "published" and post.data.get("visibility", "public") == "public"
    ) or bool(actor and (post.owner_id == actor.id or actor.role in {"reviewer", "admin"}))


def plan_view(plan):
    return {
        **wire(content.plan_view(plan)),
        "id": str(plan.id) if plan else "anonymous",
        "max_entries": 40,
    }


@router.post("/auth/login")
def login(data: Login, request: Request, response: Response, db=Depends(get_db)):
    logged = accounts.login(data, request, response, db)["data"]
    return result(request, user_view(db, db.get(User, uuid(logged["id"]))))


@router.post("/auth/logout")
def logout(request: Request, response: Response, db=Depends(get_db)):
    return accounts.logout(request, response, db)


@router.get("/auth/me")
def me(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(request, user_view(db, user))


@router.get("/bootstrap")
def bootstrap(request: Request, user=Depends(optional_user), db=Depends(get_db)):
    schools = all_schools(db)[:30]
    plan = content.plan_record(db, user) if user else None
    snapshot = content.bootstrap(request, user, db)["data"]
    return result(
        request,
        {
            **wire(snapshot),
            "user": user_view(db, user) if user else None,
            "profile": profile_view(current_profile(db, user.id)) if user else None,
            "schools": schools,
            "plan": plan_view(plan),
            "sources": [
                source_view(db, s) for s in sorted({x for s in schools for x in s["source_ids"]})
            ],
            "posts": [
                post_view(db, p, user)
                for p in db.scalars(select(Post).order_by(Post.created_at, Post.id))
                if visible(p, user)
            ][:30],
        },
    )


@router.post("/registration-applications", status_code=202)
async def apply(
    request: Request, idempotency_key: str | None = Header(default=None), db=Depends(get_db)
):
    receipt = await accounts.apply(request, idempotency_key, db)
    # A replay may return a terminal state; the receipt schema must allow that state.
    return receipt


@router.get("/registration-applications/{application_id}")
def application(
    application_id: UUID,
    request: Request,
    x_application_token: str | None = Header(default=None),
    db=Depends(get_db),
):
    return result(
        request, application_view(db, registration.lookup(db, application_id, x_application_token))
    )


@router.get("/admin/registration-applications")
def applications(
    request: Request,
    status: str = "pending",
    cursor: str | None = None,
    actor=Depends(admin),
    db=Depends(get_db),
):
    if status not in {"pending", "approved", "rejected"}:
        raise DomainError(422, "INVALID_INPUT", "未知申请状态。")
    rows = db.scalars(
        select(Application)
        .where(Application.status == status)
        .order_by(Application.created_at, Application.id)
    )
    return result(request, page([application_view(db, a, detail=True) for a in rows], cursor))


@router.get("/admin/registration-applications/{application_id}")
def application_detail(
    application_id: UUID, request: Request, actor=Depends(admin), db=Depends(get_db)
):
    record = db.get(Application, application_id)
    if not record:
        missing()
    return result(request, application_view(db, record, detail=True))


@router.get("/admin/registration-applications/{application_id}/audio")
def application_audio(
    application_id: UUID, request: Request, actor=Depends(admin), db=Depends(get_db)
):
    evidence = db.scalar(
        select(RegistrationEvidence).where(
            RegistrationEvidence.application_id == application_id,
            RegistrationEvidence.storage_key.is_not(None),
        )
    )
    if not evidence:
        missing()
    return accounts.audio(application_id, evidence.id, request, actor, db)


@router.post("/admin/registration-applications/{application_id}/decision")
def decide(
    application_id: UUID,
    data: Decision,
    request: Request,
    idempotency_key: str | None = Header(default=None),
    actor=Depends(admin),
    db=Depends(get_db),
):
    signature = fingerprint(request.app.state.settings.app_secret, data.model_dump())
    key, previous = idempotency(
        db, "decision:" + str(actor.id) + ":" + str(application_id), idempotency_key, signature
    )
    if previous:
        record = db.get(Application, application_id)
    else:
        record = registration.decide(db, application_id, actor, data, request.app.state.settings)
        db.add(Idempotency(key=key, fingerprint=signature, resource_id=record.id))
        db.commit()
    return result(request, application_view(db, record, detail=True))


@router.get("/me/profile")
def profile(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(request, profile_view(current_profile(db, user.id)))


@router.patch("/me/profile")
def patch_profile(
    request: Request, data: dict = Body(), user=Depends(current_user), db=Depends(get_db)
):
    validate("ProfilePatch", data)
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    previous = current_profile(db, user.id)
    saved = save_profile(
        db,
        user.id,
        internal_profile(data, previous.data if previous else None),
        data["expected_version"],
    )
    db.commit()
    return result(request, profile_view(saved))


@router.get("/me/profile/versions")
def versions(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(
        request,
        [
            profile_view(p)
            for p in db.scalars(
                select(ProfileVersion)
                .where(ProfileVersion.owner_id == user.id)
                .order_by(ProfileVersion.version.desc())
            )
        ],
    )


@router.post("/me/profile/parse")
def parse(
    request: Request,
    data: dict = Body(),
    user=Depends(current_user),
    db=Depends(get_db),
):
    validate("ProfileParseInput", data)
    proposed = extract_profile_values(data["text"])
    current = current_profile(db, user.id)
    snapshot = {"profile": {**(current.data if current else {}), **proposed}}
    mapping = {
        "province": "province_code",
        "year": "exam_year",
        "cities": "preferred_regions",
        "interests": "preferred_majors",
        "schools": "preferred_schools",
    }
    return result(
        request,
        {
            "proposed_changes": {mapping.get(key, key): value for key, value in proposed.items()},
            "missing_fields": [q["field"] for q in questions(snapshot)],
            "questions": ["请确认识别结果；未提及字段保持原值，不会自动保存。"],
        },
    )


@router.get("/schools")
def schools(
    request: Request,
    query: str = "",
    city: str = "",
    major: str = "",
    cursor: str | None = None,
    db=Depends(get_db),
):
    rows = [
        s
        for s in all_schools(db)
        if query in s["name"] + s["city"] + "".join(s["majors"])
        and (not city or s["city"] == city)
        and (not major or major in s["majors"])
    ]
    return result(request, page(rows, cursor))


@router.get("/schools/{school_id}")
def school(school_id: UUID, request: Request, db=Depends(get_db)):
    record = next((s for s in all_schools(db) if s["id"] == str(school_id)), None)
    if not record:
        missing()
    return result(request, record)


@router.get("/admission-units")
def units(
    request: Request, school_id: UUID | None = None, cursor: str | None = None, db=Depends(get_db)
):
    rows = sorted(active_units(db), key=lambda u: str(u.id))
    return result(
        request,
        page([unit_view(u) for u in rows if not school_id or u.school_id == school_id], cursor),
    )


@router.get("/admission-units/{unit_id}/history")
def unit_history(unit_id: UUID, request: Request, db=Depends(get_db)):
    from app.db.models import AdmissionUnit

    unit = db.get(AdmissionUnit, unit_id)
    if not unit:
        missing()
    return result(
        request,
        {
            "comparable": False,
            "reason": "须与考生位次口径匹配，单独历史接口不推断可比性",
            "items": [
                {
                    "year": h["year"],
                    "unit_type": "major",
                    "minimum_filing_rank": None,
                    "major_admission_rank": h["rank"],
                    "source_ids": [str(unit.source_id)],
                }
                for h in unit.data["history"]
            ],
        },
    )


@router.get("/evidence/{evidence_id}")
def evidence(evidence_id: UUID, request: Request, db=Depends(get_db)):
    return result(request, source_view(db, evidence_id))


@router.post("/recommendations", status_code=202)
def recommend(
    request: Request,
    data: dict = Body(),
    idempotency_key: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    validate("CreateRun", data)
    throttle(request, "recommendation")
    signature = fingerprint(request.app.state.settings.app_secret, data)
    key, previous = idempotency(db, "v4recommendation:" + str(user.id), idempotency_key, signature)
    if previous:
        return result(request, run_view(owned_run(db, previous.resource_id, user.id)))
    run = create_run(
        db,
        request.app.state.settings,
        user,
        RunInput(
            question=data["question"],
            profile_version_id=uuid(data["profile_version_id"])
            if data["profile_version_id"]
            else None,
        ),
        digest(idempotency_key),
    )
    snapshot = {
        **run.snapshot,
        "intent": data["intent"],
        "original_profile_version_id": str(run.profile_version_id)
        if run.profile_version_id
        else None,
    }
    run.snapshot = snapshot
    if questions(snapshot):
        run.status = "waiting_input"
        db.execute(delete(Job).where(Job.object_id == run.id, Job.task_type == "recommendation"))
        emit(db, run, "question", {"questions": questions(snapshot)})
    db.add(Idempotency(key=key, fingerprint=signature, resource_id=run.id))
    db.commit()
    return result(request, run_view(run))


@router.get("/recommendations/{run_id}")
def get_run(run_id: UUID, request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(request, run_view(owned_run(db, run_id, user.id)))


@router.post("/recommendations/{run_id}/answers", status_code=202)
def answer(
    run_id: UUID,
    request: Request,
    data: dict = Body(),
    idempotency_key: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    validate("RunAnswers", data)
    signature = fingerprint(request.app.state.settings.app_secret, data)
    key, previous = idempotency(
        db, "answer:" + str(user.id) + ":" + str(run_id), idempotency_key, signature
    )
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    run = owned_run(db, run_id, user.id, lock=True)
    if previous:
        return result(request, run_view(run))
    if run.status != "waiting_input" or data["expected_version"] != max(1, run.event_seq):
        raise DomainError(409, "RUN_VERSION_CONFLICT", "任务已变化，请刷新后重试。")
    current = current_profile(db, user.id)
    if current and current.id != run.profile_version_id:
        raise DomainError(
            409, "PROFILE_VERSION_CONFLICT", "当前画像已经更新，请基于新画像创建任务。"
        )
    values = dict(
        run.snapshot.get("profile")
        or {
            "province": "",
            "year": 2026,
            "score": None,
            "rank": None,
            "subjects": [],
            "cities": [],
            "interests": [],
            "budget": None,
            "acceptAdjustment": False,
            "consent": False,
        }
    )
    allowed = {q["field"] for q in questions(run.snapshot)}
    allowed |= {q["field"] for q in optional_questions(run.snapshot)}
    if set(data["answers"]) - allowed:
        raise DomainError(422, "INVALID_INPUT", "答案包含本次补问以外的字段。")
    try:
        for field, value in data["answers"].items():
            if field == "province_code":
                values["province"] = value
            elif field in {"rank", "exam_year", "score"}:
                values["year" if field == "exam_year" else field] = int(value)
            elif field == "budget":
                values["budget"] = float(value)
            elif field == "subjects":
                values[field] = [x for x in re.split(r"[,，、\s]+", value.strip()) if x]
            elif field in {"cities", "interests", "schools"}:
                values[field] = [x for x in re.split(r"[,，、]+", value.strip()) if x]
            elif field == "consent":
                values[field] = value.lower() in {"true", "是", "同意"}
            else:
                values[field] = value
        from app.modules.protocol.service import InternalProfile

        saved = save_profile(
            db, user.id, InternalProfile.model_validate(values), current.version if current else 0
        )
    except ValueError:
        raise DomainError(422, "INVALID_INPUT", "请核对补充答案的格式。") from None
    run.snapshot = {
        **run.snapshot,
        "profile": saved.data,
        "profile_history": [
            *run.snapshot["profile_history"],
            {
                "profile_version_id": str(run.profile_version_id)
                if run.profile_version_id
                else None,
                "profile": run.snapshot["profile"],
            },
        ],
    }
    run.profile_version_id = saved.id
    run.status = "waiting_input" if questions(run.snapshot) else "queued"
    emit(db, run, "status", {"status": run.status})
    if run.status == "queued":
        db.add(Job(task_type="recommendation", object_id=run.id))
    else:
        emit(db, run, "question", {"questions": questions(run.snapshot)})
    db.add(Idempotency(key=key, fingerprint=signature, resource_id=run.id))
    db.commit()
    return result(request, run_view(run))


@router.post("/recommendations/{run_id}/cancel", status_code=202)
def cancel(
    run_id: UUID,
    request: Request,
    data: dict = Body(),
    idempotency_key: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    validate("RunCancel", data)
    signature = fingerprint(request.app.state.settings.app_secret, data)
    key, previous = idempotency(
        db, "cancel:" + str(user.id) + ":" + str(run_id), idempotency_key, signature
    )
    run = owned_run(db, run_id, user.id, lock=True)
    if previous:
        return result(request, run_view(run))
    if data["expected_version"] != max(1, run.event_seq):
        raise DomainError(409, "RUN_VERSION_CONFLICT", "任务已更新，请刷新。")
    if run.status not in {"succeeded", "failed", "cancelled"}:
        run.status, run.cancelled = "cancelled", True
        emit(db, run, "done", {"status": "cancelled"})
    db.add(Idempotency(key=key, fingerprint=signature, resource_id=run.id))
    db.commit()
    return result(request, run_view(run))


@router.get("/recommendations/{run_id}/events")
def events(
    run_id: UUID,
    request: Request,
    last_event_id: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    return old_recommendations.events(run_id, request, last_event_id, user, db)


@router.post("/feedback", status_code=201)
def send_feedback(
    request: Request,
    data: dict = Body(),
    idempotency_key: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    validate("RecommendationFeedback", data)
    return feedback(FeedbackInput.model_validate(data), request, idempotency_key, user, db)


@router.get("/me/history")
def history(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(
        request,
        [
            run_view(r)
            for r in db.scalars(
                select(RecommendationRun)
                .where(RecommendationRun.owner_id == user.id)
                .order_by(RecommendationRun.created_at.desc())
            )
        ],
    )


@router.delete("/me/data")
def delete_data(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return content.delete_data(request, user, db)


@router.put("/me/favorites/{school_id}")
def favorite(school_id: UUID, request: Request, user=Depends(current_user), db=Depends(get_db)):
    return content.add_favorite(school_id, request, user, db)


@router.delete("/me/favorites/{school_id}")
def unfavorite(school_id: UUID, request: Request, user=Depends(current_user), db=Depends(get_db)):
    return content.remove_favorite(school_id, request, user, db)


@router.put("/me/plan")
def plan(request: Request, data: dict = Body(), user=Depends(current_user), db=Depends(get_db)):
    validate("Plan", data)
    if len(data["name"]) > 120 or any(len(e["id"]) > 100 for e in data["entries"]):
        raise DomainError(422, "PLAN_INVALID", "方案名称或条目编号过长。")
    record = content.plan_record(db, user)
    if data["id"] != str(record.id):
        missing()
    if data["version"] != record.version:
        raise DomainError(409, "PLAN_VERSION_CONFLICT", "方案已更新，请刷新。")
    if len(data["entries"]) > 40 or len({e["id"] for e in data["entries"]}) != len(data["entries"]):
        raise DomainError(422, "PLAN_INVALID", "条目重复或超过40项。")
    units_by_id = {str(u.id): u for u in active_units(db)}
    for e in data["entries"]:
        unit = units_by_id.get(e.get("admission_unit_id"))
        if (
            not unit
            or str(unit.school_id) != e["school_id"]
            or e.get("major_id") != str(unit.id)
            or e["major"] != unit.data["major"]
        ):
            raise DomainError(
                422, "PLAN_INVALID", "请选择当前招生单位和对应专业，不得只按名称提交。"
            )
        item_id = e.get("recommendation_item_id")
        if item_id:
            owned = db.scalars(
                select(RecommendationRun).where(RecommendationRun.owner_id == user.id)
            )
            if not any(
                any(
                    i["recommendation_item_id"] == item_id
                    and i["admission_unit_id"] == str(unit.id)
                    for g in ("items", "pending_confirmation")
                    for i in (r.result or {}).get(g, [])
                )
                for r in owned
            ):
                raise DomainError(422, "PLAN_INVALID", "推荐条目不属于本人或与招生单位不一致。")
    record.entries = [{**e, "schoolId": e["school_id"]} for e in data["entries"]]
    record.name, record.version = data["name"], record.version + 1
    db.commit()
    return result(request, plan_view(record))


@router.post("/plans/simulations")
def simulation(
    request: Request, data: dict = Body(), user=Depends(current_user), db=Depends(get_db)
):
    if set(data) != {"plan_id", "version"}:
        raise DomainError(422, "INVALID_INPUT", "模拟请求字段不正确。")
    record = content.plan_record(db, user)
    if data["plan_id"] != str(record.id):
        missing()
    if data["version"] != record.version:
        raise DomainError(409, "PLAN_VERSION_CONFLICT", "方案已更新。")
    profile = current_profile(db, user.id)
    if not profile:
        raise DomainError(422, "PROFILE_INCOMPLETE", "请先填写画像。")
    from app.modules.admissions.service import unit_view as domain_unit

    available = {str(u.id): u for u in active_units(db)}
    statuses = [
        rules(profile.data, domain_unit(available[e["admission_unit_id"]]))["eligibility"]["status"]
        if e.get("admission_unit_id") in available
        else "unknown"
        for e in record.entries
    ]
    status = (
        "fail"
        if "fail" in statuses
        else "pass"
        if statuses and all(s == "pass" for s in statuses)
        else "unknown"
    )
    db.commit()
    return result(
        request,
        {
            "eligible": True if status == "pass" else False if status == "fail" else None,
            "eligibility": {"status": status, "reason": "仅核对招生单位已知硬条件"},
            "warnings": ["未执行真实投档或完整顺序模拟"],
            "assessment": "不计算录取概率，请核对官方政策",
            "basis_year": profile.data["year"],
            "probabilities": None,
        },
    )


@router.get("/posts")
def posts(
    request: Request,
    school_id: UUID | None = None,
    topic: str = "",
    query: str = "",
    strong_only: bool = False,
    cursor: str | None = None,
    user=Depends(optional_user),
    db=Depends(get_db),
):
    rows = db.scalars(select(Post).order_by(Post.created_at, Post.id))
    items = [
        post_view(db, p, user)
        for p in rows
        if p.status == "published"
        and p.data.get("visibility", "public") == "public"
        and (not school_id or p.school_id == school_id)
        and (not topic or p.data["topic"] == topic)
        and query in p.data["title"] + p.data["body"]
        and not strong_only
    ]
    return result(request, page(items, cursor))


@router.get("/posts/{post_id}")
def post(post_id: UUID, request: Request, user=Depends(optional_user), db=Depends(get_db)):
    record = db.get(Post, post_id)
    if not record or not visible(record, user):
        missing()
    return result(request, post_view(db, record, user))


@router.post("/posts", status_code=201)
def create_post(
    request: Request,
    data: dict = Body(),
    idempotency_key: str | None = Header(default=None),
    user=Depends(current_user),
    db=Depends(get_db),
):
    validate("PostInput", data)
    throttle(request, "post")
    signature = fingerprint(request.app.state.settings.app_secret, data)
    key, previous = idempotency(db, "post:" + str(user.id), idempotency_key, signature)
    if previous:
        record = db.get(Post, previous.resource_id)
        if not record:
            missing()
        return result(request, post_view(db, record, user))
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    school_id = uuid(data["school_id"])
    if not db.get(School, school_id):
        missing()
    record = Post(owner_id=user.id, school_id=school_id, data=data)
    db.add(record)
    db.flush()
    db.add(PostRevision(post_id=record.id, version=1, data=data))
    db.add(Idempotency(key=key, fingerprint=signature, resource_id=record.id))
    db.commit()
    return result(request, post_view(db, record, user))


@router.get("/admin/reviews")
def reviews(
    request: Request, cursor: str | None = None, actor=Depends(reviewer), db=Depends(get_db)
):
    return result(
        request,
        page(
            [
                post_view(db, p, actor)
                for p in db.scalars(
                    select(Post).where(Post.status == "pending").order_by(Post.created_at, Post.id)
                )
            ],
            cursor,
        ),
    )


@router.post("/admin/reviews/{post_id}")
def review(
    post_id: UUID, data: Decision, request: Request, actor=Depends(reviewer), db=Depends(get_db)
):
    record = db.scalar(select(Post).where(Post.id == post_id).with_for_update())
    if not record:
        missing()
    if record.version != data.expected_version:
        raise DomainError(409, "POST_VERSION_CONFLICT", "帖子版本已更新。")
    if record.status != "pending":
        raise DomainError(409, "REVIEW_ALREADY_DECIDED", "帖子已处理。")
    from app.db.models import now

    record.status = "published" if data.decision == "approve" else "rejected"
    record.data = {
        **record.data,
        "review": {
            "actor_id": str(actor.id),
            "reason": data.reason,
            "decision": data.decision,
            "time": now().isoformat(),
        },
    }
    record.version += 1
    db.commit()
    return result(request, post_view(db, record, actor))


@router.post("/posts/{post_id}/feedback")
def post_feedback(
    post_id: UUID,
    data: PostFeedbackInput,
    request: Request,
    user=Depends(current_user),
    db=Depends(get_db),
):
    record = db.get(Post, post_id)
    if not record or not visible(record, user):
        missing()
    return content.feedback(post_id, data, request, user, db)


@router.get("/me/memories")
def memories(request: Request, user=Depends(current_user)):
    return result(request, [])


@router.get("/me/case-sharing-consent")
def sharing(request: Request, user=Depends(current_user)):
    return result(request, {"enabled": False, "available": False})


@router.post("/me/case-sharing-consent")
def share(user=Depends(current_user)):
    not_implemented()


@router.delete("/me/case-sharing-consent")
def unshare(request: Request, user=Depends(current_user)):
    return result(request, None)


@router.post("/chat/stream")
def chat(request: Request, data: dict = Body(), user=Depends(optional_user), db=Depends(get_db)):
    from app.modules.agent.router import ChatInput
    from app.modules.agent.router import chat as old_chat

    if set(data) - {"message", "conversation_id", "history", "profile_context"}:
        raise DomainError(422, "INVALID_INPUT", "对话字段不正确。")
    try:
        parsed = ChatInput(
            message=data.get("message", ""),
            conversationId=data.get("conversation_id"),
            history=data.get("history", []),
            profile_context=data.get("profile_context"),
        )
    except ValidationError:
        raise DomainError(422, "INVALID_INPUT", "对话内容或会话编号不正确。") from None
    return old_chat(parsed, request, user, db)


@router.post("/me/student-verification", status_code=202)
async def verification(request: Request, user=Depends(current_user), db=Depends(get_db)):
    from app.core.storage import blob_path, read_upload, save_blob, validate_document
    from app.db.models import Verification

    settings = request.app.state.settings
    async with request.form(max_files=1, max_fields=1) as form:
        if set(form) != {"school_id", "document"}:
            raise DomainError(422, "INVALID_INPUT", "材料字段不正确。")
        school_id = uuid(form["school_id"])
        if not db.get(School, school_id):
            missing()
        payload = await read_upload(form["document"], settings)
        mime = validate_document(payload)
    key = save_blob(settings, payload)
    try:
        record = Verification(owner_id=user.id, school_id=school_id, storage_key=key, mime=mime)
        db.add(record)
        db.commit()
    except Exception:
        db.rollback()
        blob_path(settings, key).unlink(missing_ok=True)
        raise
    return result(request, wire(content.verification_view(record)))


@router.patch("/posts/{post_id}")
def edit_post(
    post_id: UUID,
    request: Request,
    data: dict = Body(),
    user=Depends(current_user),
    db=Depends(get_db),
):
    validate("PostPatch", data)
    record = db.scalar(
        select(Post).where(Post.id == post_id, Post.owner_id == user.id).with_for_update()
    )
    if not record:
        missing()
    if record.version != data["expected_version"]:
        raise DomainError(409, "POST_VERSION_CONFLICT", "帖子已更新。")
    record.data = {**record.data, **{k: v for k, v in data.items() if k != "expected_version"}}
    record.status, record.version = "pending", record.version + 1
    db.add(PostRevision(post_id=record.id, version=record.version, data=record.data))
    db.commit()
    return result(request, post_view(db, record, user))


@router.delete("/posts/{post_id}")
def delete_post(
    post_id: UUID,
    request: Request,
    data: dict = Body(),
    user=Depends(current_user),
    db=Depends(get_db),
):
    from app.db.models import PostFeedback

    validate("ExpectedVersion", data)
    record = db.scalar(
        select(Post).where(Post.id == post_id, Post.owner_id == user.id).with_for_update()
    )
    if not record:
        missing()
    if record.version != data["expected_version"]:
        raise DomainError(409, "POST_VERSION_CONFLICT", "帖子已更新。")
    db.execute(delete(PostFeedback).where(PostFeedback.post_id == record.id))
    db.execute(delete(PostRevision).where(PostRevision.post_id == record.id))
    db.delete(record)
    db.commit()
    return result(request, None)


def unavailable_user(user=Depends(current_user)):
    not_implemented()


def unavailable_admin(actor=Depends(admin)):
    not_implemented()


for path, method in [("/me/memories/{memory_id}", "PATCH"), ("/me/memories/{memory_id}", "DELETE")]:
    router.add_api_route(path, unavailable_user, methods=[method])
for path, method in [
    ("/admin/student-verifications", "GET"),
    ("/admin/student-verifications/{verification_id}/document", "GET"),
    ("/admin/student-verifications/{verification_id}/decision", "POST"),
]:
    router.add_api_route(path, unavailable_admin, methods=[method])
