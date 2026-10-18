from uuid import UUID, uuid4

from pydantic import Field
from sqlalchemy import select

from app.core.errors import DomainError, missing
from app.core.security import fingerprint, idempotency
from app.db.models import Idempotency, Job, ProfileVersion, RecommendationRun, RunEvent, User
from app.modules.admissions.service import active_units, unit_view
from app.modules.community.schemas import StrictModel
from app.modules.profiles.service import ProfileInput, current_profile, save_profile
from app.modules.validation.service import validate_result


class LegacyRecommendation(StrictModel):
    riskPreference: int = Field(ge=0, le=100)


class RunInput(StrictModel):
    question: str = Field(min_length=1, max_length=3000)
    profile_version_id: UUID | None = None


class AnswerInput(StrictModel):
    expected_profile_version: int = Field(ge=0)
    profile: ProfileInput


def emit(db, run, kind, payload):
    run.event_seq += 1
    db.add(RunEvent(run_id=run.id, event_id=run.event_seq, event_type=kind, payload=payload))


def rules(profile, unit):
    data = unit
    failures, unknown = [], []
    if profile["province"] != data["province_code"] or profile["year"] != data["exam_year"]:
        failures.append("省份或招生年份不在该招生单位范围")
    required = data["required_subjects"]
    if required is None:
        unknown.append("官方选科要求待确认")
    elif not set(required).issubset(profile["subjects"]):
        failures.append("选科不满足官方要求")
    if data["tuition"] is None:
        unknown.append("学费待确认")
    elif data["tuition"] > profile["budget"]:
        failures.append("学费超过已确认的年度学费预算上限")
    if not data["campus"]:
        unknown.append("校区待确认")
    if not profile.get("batch") or profile["batch"] != data["batch"]:
        unknown.append("考生批次口径待确认")
    unknown.extend(data["additional_requirements"])
    eligibility = "fail" if failures else "unknown" if unknown else "pass"
    cohort = profile.get("rank_cohort")
    history = [
        h
        for h in data["history"]
        if h["comparable"] and cohort and h["rank_cohort"] == cohort == data["rank_cohort"]
    ]
    risk = {"status": "unknown", "reason": "暂无经确认的同口径可比历史；不计算录取概率"}
    if history:
        ranks = [h["rank"] for h in history]
        risk = {
            "status": "reference_only",
            "min_rank": min(ranks),
            "max_rank": max(ranks),
            "candidate_rank": profile["rank"],
            "years": [h["year"] for h in history],
            "reason": "仅展示同口径历史区间，计划和政策变化仍须核对；无经过校准的冲稳保阈值",
        }
    breakdown = []
    if profile["cities"]:
        breakdown.append({"dimension": "city", "value": int(data["city"] in profile["cities"])})
    if profile["interests"]:
        breakdown.append(
            {
                "dimension": "major",
                "value": int(any(x in data["major"] for x in profile["interests"])),
            }
        )
    match = sum(x["value"] for x in breakdown) / len(breakdown) if breakdown else None
    return {
        "recommendation_item_id": str(uuid4()),
        "admission_unit_id": data["id"],
        "school_id": data["school_id"],
        "campus_id": None,
        "campus": data["campus"],
        "major": data["major"],
        "eligibility": {
            "status": eligibility,
            "missing_requirements": unknown,
            "failed_requirements": failures,
        },
        "historical_risk": risk,
        "preference_match": {
            "score": match,
            "coverage": len(breakdown) / 2,
            "breakdown": breakdown,
        },
        "reasons": ["条件判断来自已发布的官方资料版本", *failures],
        "evidence_ids": [data["source_id"]],
        "dataset_version": data["dataset_version"],
        "warnings": [*unknown, "仅供辅助选择，不执行真实填报，不预测精确录取概率"],
    }


def evaluate_snapshot(snapshot):
    profile = snapshot.get("profile")
    if not profile:
        return {
            "items": [],
            "pending_confirmation": [],
            "excluded": [],
            "questions": ["请补充考生画像、省份、年份、选科和位次。"],
        }
    if profile["province"] != "浙江" or profile["year"] != 2026:
        raise DomainError(
            422, "UNSUPPORTED_EXAM_MODE", "首版仅覆盖浙江 2026 普通类，请勿跨省套用规则。"
        )
    results = [rules(profile, unit) for unit in snapshot["units"]]
    eligible = [r for r in results if r["eligibility"]["status"] == "pass"]
    eligible.sort(key=lambda r: r["preference_match"]["score"] or 0, reverse=True)
    output = {
        "items": eligible,
        "pending_confirmation": [r for r in results if r["eligibility"]["status"] == "unknown"],
        "excluded": [r for r in results if r["eligibility"]["status"] == "fail"],
        "questions": [],
        "rule_version": "zhejiang-ordinary-major-m1-v1",
        "probabilities": None,
        "warnings": [] if results else ["当前没有已发布的官方招生资料，请先导入并复核数据。"],
    }
    output["validation"] = validate_result(snapshot, output)
    return output


def create_run(db, settings, actor, data, key):
    scoped, previous = idempotency(
        db,
        "recommendation:" + str(actor.id),
        key,
        fingerprint(settings.app_secret, data.model_dump()),
    )
    if previous:
        return owned_run(db, previous.resource_id, actor.id)
    # Same owner lock as profile/deletion protects snapshot construction.
    db.scalar(select(User).where(User.id == actor.id).with_for_update())
    profile = current_profile(db, actor.id)
    if data.profile_version_id:
        profile = db.scalar(
            select(ProfileVersion).where(
                ProfileVersion.id == data.profile_version_id, ProfileVersion.owner_id == actor.id
            )
        )
        if not profile:
            missing()
    run = RecommendationRun(
        owner_id=actor.id,
        profile_version_id=profile.id if profile else None,
        snapshot={
            "question": data.question,
            "profile": profile.data if profile else None,
            "profile_history": [],
            "units": [unit_view(u) for u in active_units(db)],
        },
        status="queued" if profile else "waiting_input",
        event_seq=0,
    )
    db.add(run)
    db.flush()
    emit(db, run, "status", {"status": run.status})
    if profile:
        db.add(Job(task_type="recommendation", object_id=run.id))
    else:
        emit(db, run, "question", {"questions": ["请补充省份、年份、选科及位次等考生画像。"]})
    db.add(
        Idempotency(
            key=scoped,
            fingerprint=fingerprint(settings.app_secret, data.model_dump()),
            resource_id=run.id,
        )
    )
    return run


def owned_run(db, run_id, owner_id, lock=False):
    query = select(RecommendationRun).where(
        RecommendationRun.id == run_id, RecommendationRun.owner_id == owner_id
    )
    run = db.scalar(query.with_for_update() if lock else query)
    if not run:
        missing()
    return run


def answer_run(db, actor, run_id, answer):
    # Consistent owner -> run locking order with deletion and run creation.
    db.scalar(select(User).where(User.id == actor.id).with_for_update())
    run = owned_run(db, run_id, actor.id, lock=True)
    if run.status != "waiting_input":
        raise DomainError(409, "RUN_STATE_CONFLICT", "当前任务不接受补充答案。")
    profile = save_profile(db, actor.id, answer.profile, answer.expected_profile_version)
    snapshot = dict(run.snapshot)
    snapshot["profile_history"] = [
        *snapshot["profile_history"],
        {
            "profile_version_id": str(run.profile_version_id) if run.profile_version_id else None,
            "profile": snapshot["profile"],
        },
    ]
    snapshot["profile"] = profile.data
    run.snapshot, run.profile_version_id, run.status = snapshot, profile.id, "queued"
    emit(db, run, "status", {"status": "queued"})
    db.add(Job(task_type="recommendation", object_id=run.id))
    return run


def run_view(run):
    return {
        "run_id": str(run.id),
        "status": run.status,
        "profile_version_id": str(run.profile_version_id) if run.profile_version_id else None,
        "result": run.result,
        "last_event_id": run.event_seq,
        "questions": ["请补充考生画像。"] if run.status == "waiting_input" else [],
    }
