from uuid import UUID, uuid4

from pydantic import Field
from sqlalchemy import select

from app.core.errors import DomainError, missing
from app.core.security import fingerprint, idempotency
from app.db.models import (
    Idempotency,
    Job,
    ProfileVersion,
    RecommendationRun,
    RunEvent,
    School,
    User,
)
from app.modules.admissions.service import active_units, unit_view
from app.modules.community.schemas import StrictModel
from app.modules.profiles.service import (
    ProfileInput,
    current_profile,
    recommendation_missing,
    save_profile,
)
from app.modules.validation.service import validate_result


class LegacyRecommendation(StrictModel):
    riskPreference: int = Field(ge=0, le=100)


class RunInput(StrictModel):
    question: str = Field(min_length=1, max_length=4000)
    profile_version_id: UUID | None = None


class AnswerInput(StrictModel):
    expected_profile_version: int = Field(ge=0)
    profile: ProfileInput


def emit(db, run, kind, payload):
    if kind == "result":
        payload = {**payload, "validated": payload.get("validation", {}).get("status") == "pass"}
    run.event_seq += 1
    db.add(RunEvent(run_id=run.id, event_id=run.event_seq, event_type=kind, payload=payload))


def rules(profile, unit):
    data = unit
    subjects = profile.get("subjects") or []
    cities = profile.get("cities") or []
    interests = profile.get("interests") or []
    schools = profile.get("schools") or []
    budget = profile.get("budget")
    preferences = profile.get("preferences") or []
    failures, unknown = [], []
    if not profile.get("province"):
        unknown.append("省份待确认")
    elif profile.get("province") != data.get("province_code") or profile.get("year") != data.get(
        "exam_year"
    ):
        failures.append("省份或招生年份不在该招生单位范围")
    if profile.get("exam_category", "普通类") != data.get("exam_category"):
        failures.append("招生科类不匹配")
    required = data.get("required_subjects")
    if required is None:
        unknown.append("官方选科要求待确认")
    elif len(subjects) != 3:
        unknown.append("选科尚未完整确认")
    elif not set(required).issubset(subjects):
        failures.append("选科不满足官方要求")
    if data.get("tuition") is None:
        unknown.append("学费待确认")
    elif budget is None:
        unknown.append("学费预算待确认")
    elif data["tuition"] > budget:
        failures.append("学费超过已确认的年度学费预算上限")
    if profile.get("budget_scope") == "total":
        unknown.append("总预算还需核对住宿及生活费用")
    for preference in preferences:
        if preference.get("strength") == "hard":
            unknown.append(
                "硬性偏好需人工核对："
                + str(preference.get("field"))
                + "="
                + str(preference.get("value"))
            )
    if not data.get("campus"):
        unknown.append("校区待确认")
    if not profile.get("batch") or profile.get("batch") != data.get("batch"):
        unknown.append("考生批次口径待确认")
    unknown.extend(data.get("additional_requirements") or [])
    eligibility = "fail" if failures else "unknown" if unknown else "pass"
    cohort = profile.get("rank_cohort")
    history = [
        h
        for h in (data.get("history") or [])
        if h.get("comparable")
        and cohort
        and profile.get("rank")
        and h.get("rank_cohort") == cohort == data.get("rank_cohort")
    ]
    risk = {"status": "unknown", "reason": "暂无经确认的同口径可比历史；不计算录取概率"}
    if history:
        ranks = [h["rank"] for h in history]
        risk = {
            "status": "reference_only",
            "min_rank": min(ranks),
            "max_rank": max(ranks),
            "candidate_rank": profile.get("rank"),
            "years": [h["year"] for h in history],
            "reason": "仅展示同口径历史区间，计划和政策变化仍须核对；无经过校准的冲稳保阈值",
        }
    breakdown = []
    if cities:
        breakdown.append(
            {
                "dimension": "region",
                "value": int(
                    any(
                        value in {data.get("city"), data.get("school_province")} for value in cities
                    )
                ),
            }
        )
    if interests:
        breakdown.append(
            {
                "dimension": "major",
                "value": int(any(x in data.get("major", "") for x in interests)),
            }
        )
    if schools:
        breakdown.append(
            {
                "dimension": "school",
                "value": int(
                    any(
                        value in (data.get("school_name") or "") or value == data.get("school_id")
                        for value in schools
                    )
                ),
            }
        )
    match = sum(x["value"] for x in breakdown) / len(breakdown) if breakdown else None
    return {
        "recommendation_item_id": str(uuid4()),
        "admission_unit_id": data["id"],
        "school_id": data["school_id"],
        "school_name": data.get("school_name") or data.get("short_name"),
        "campus_id": None,
        "campus": data.get("campus"),
        "city": data.get("city"),
        "school_province": data.get("school_province"),
        "tuition": data.get("tuition"),
        "plan_count": data.get("plan_count"),
        "major": data.get("major", ""),
        "eligibility": {
            "status": eligibility,
            "missing_requirements": unknown,
            "failed_requirements": failures,
        },
        "historical_risk": risk,
        "preference_match": {
            "score": match,
            "coverage": len(breakdown) / 3,
            "breakdown": breakdown,
        },
        "reasons": ["条件判断来自已发布的官方资料版本", *failures],
        "evidence_ids": [data["source_id"]],
        "dataset_version": data["dataset_version"],
        "warnings": [*unknown, "仅供辅助选择，不执行真实填报，不预测精确录取概率"],
    }


OPTIONAL_LABELS = {
    "score": "分数",
    "cities": "城市偏好",
    "interests": "专业兴趣",
    "schools": "意向院校",
    "budget": "学费预算",
    "rank_cohort": "位次口径",
    "batch": "报考批次",
}

OPTIONAL_TEXTS = {
    "score": "分数可稍后补充，不影响先按位次与选科推荐",
    "cities": "补充城市偏好后，可按地域比较院校",
    "interests": "补充专业兴趣后，可优先展示匹配方向",
    "schools": "意向院校可稍后补充，先比较不同院校方向",
    "budget": "补充学费预算后，可排除超预算选项",
    "rank_cohort": "补充位次口径后，可使用同口径历史参考",
    "batch": "确认报考批次后，可校验招生单位批次",
}


def missing_optional_fields(profile) -> list[str]:
    missing = []
    if profile.get("score") is None:
        missing.append("score")
    if not profile.get("cities"):
        missing.append("cities")
    if not profile.get("interests"):
        missing.append("interests")
    if not profile.get("schools"):
        missing.append("schools")
    if profile.get("budget") is None:
        missing.append("budget")
    if not profile.get("rank_cohort"):
        missing.append("rank_cohort")
    if not profile.get("batch"):
        missing.append("batch")
    return missing


def missing_info(profile) -> list[dict]:
    return [
        {"field": field, "text": OPTIONAL_TEXTS[field], "required": False}
        for field in missing_optional_fields(profile)
    ]


def _unique_items(items, key, limit=4):
    seen = set()
    selected = []
    for item in items:
        value = key(item)
        if value in seen:
            continue
        seen.add(value)
        selected.append(item)
        if len(selected) >= limit:
            break
    return selected


def build_branches(profile, candidates) -> list[dict]:
    """When preferences are missing, show several transparent strategies.

    Each branch is a different ordering of the same verified/unknown rows,
    never a new claim. The UI must keep the missing-field and hard-condition
    warnings visible.
    """
    missing = missing_optional_fields(profile)
    if not missing or not candidates:
        return []
    labels = "、".join(OPTIONAL_LABELS[field] for field in missing)
    interests = profile.get("interests") or []
    cities = profile.get("cities") or []

    major_sorted = sorted(
        candidates,
        key=lambda item: (
            0 if any(value in (item.get("major") or "") for value in interests) else 1,
            item.get("major") or "",
            -(item.get("plan_count") or 0),
        ),
    )
    major_items = _unique_items(major_sorted, lambda item: item.get("major"), 4)

    city_sorted = sorted(
        candidates,
        key=lambda item: (
            0
            if any(value in {item.get("city"), item.get("school_province")} for value in cities)
            else 1,
            0 if item.get("city") not in (None, "", "待核对") else 1,
            item.get("city") or "",
            item.get("major") or "",
        ),
    )
    city_items = _unique_items(
        city_sorted, lambda item: (item.get("city"), item.get("school_id")), 4
    )

    cost_sorted = sorted(
        candidates,
        key=lambda item: (
            item.get("tuition") is None,
            item.get("tuition") or 0,
            item.get("school_id") or "",
            item.get("major") or "",
        ),
    )
    cost_items = _unique_items(
        cost_sorted, lambda item: (item.get("school_id"), item.get("major")), 4
    )

    return [
        {
            "branch_id": "major_first",
            "title": "按专业方向先看",
            "summary": f"当前缺少{labels}。先按专业名称和兴趣方向列出可比较的招生单位；这不是录取判断。",
            "pros": ["先锁定专业方向，减少跨专业比较", "同一专业可横向比较院校和计划数"],
            "cons": ["可能忽略城市和学费差异", "选科/批次未确认时，专业硬条件仍待核对"],
            "missing_fields": missing,
            "item_ids": [item["recommendation_item_id"] for item in major_items],
        },
        {
            "branch_id": "city_first",
            "title": "按地域先看",
            "summary": f"当前缺少{labels}。把城市明确或与你偏好接近的院校排在前面；城市为“待核对”的行不会被当成已确认。",
            "pros": ["优先考虑生活、实习和就业地域", "适合先圈定城市再比较专业"],
            "cons": ["城市数据待核对时只能作为线索", "可能牺牲专业匹配和学费优势"],
            "missing_fields": missing,
            "item_ids": [item["recommendation_item_id"] for item in city_items],
        },
        {
            "branch_id": "cost_first",
            "title": "按学费成本先看",
            "summary": f"当前缺少{labels}。先展示已知学费较低的招生单位；学费未知的记录不会被当成便宜。",
            "pros": ["优先控制学费支出", "适合预算敏感的家庭先做排除"],
            "cons": ["学费未知的行无法比较", "低学费不等于更适合，仍需核对选科、批次和城市"],
            "missing_fields": missing,
            "item_ids": [item["recommendation_item_id"] for item in cost_items],
        },
    ]


def evaluate_snapshot(snapshot):
    profile = snapshot.get("profile")
    needed = recommendation_missing(profile)
    if needed:
        return {
            "items": [],
            "pending_confirmation": [],
            "excluded": [],
            "branches": [],
            "missing_info": [],
            "questions": [text for _, text in needed],
        }
    if profile.get("province") != "浙江" or profile.get("year") != 2026:
        raise DomainError(
            422, "UNSUPPORTED_EXAM_MODE", "首版仅覆盖浙江 2026 普通类，请勿跨省套用规则。"
        )
    results = [rules(profile, unit) for unit in snapshot["units"]]
    eligible = [r for r in results if r["eligibility"]["status"] == "pass"]
    pending = [r for r in results if r["eligibility"]["status"] == "unknown"]
    excluded = [r for r in results if r["eligibility"]["status"] == "fail"]

    def rank_key(item):
        return (
            -(item["preference_match"]["score"] or 0),
            len(item["eligibility"]["missing_requirements"]),
            abs(profile["rank"] - item["historical_risk"].get("max_rank", profile["rank"])),
            -(item.get("plan_count") or 0),
            item.get("major") or "",
        )

    eligible.sort(key=rank_key)
    pending.sort(key=rank_key)
    pool = sorted([*eligible, *pending], key=rank_key)[:200]
    limit = 30
    eligible, pending, excluded = eligible[:limit], pending[:limit], excluded[:limit]
    branches = build_branches(profile, pool)
    pool_by_id = {item["recommendation_item_id"]: item for item in pool}
    shown_ids = {item["recommendation_item_id"] for item in [*eligible, *pending]}
    for branch in branches:
        for item_id in branch["item_ids"]:
            if item_id in shown_ids or item_id not in pool_by_id:
                continue
            item = pool_by_id[item_id]
            (eligible if item["eligibility"]["status"] == "pass" else pending).append(item)
            shown_ids.add(item_id)
    output = {
        "items": eligible,
        "pending_confirmation": pending,
        "excluded": excluded,
        "branches": branches,
        "missing_info": missing_info(profile),
        "questions": [],
        "rule_version": "zhejiang-ordinary-major-m1-v1",
        "probabilities": None,
        "warnings": [] if results else ["当前没有已发布的官方招生资料，请先导入并复核数据。"],
    }
    if len(results) > limit * 2:
        output["warnings"].append(
            f"候选较多，当前仅展示最接近的前 {limit * 2} 条；补充偏好可缩小范围。"
        )
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
    school_data = {str(s.id): s.data for s in db.scalars(select(School))}
    units = []
    for unit in active_units(db):
        school = school_data.get(str(unit.school_id), {})
        units.append(
            {
                **unit_view(unit),
                "school_province": school.get("province"),
                "school_name": school.get("name") or unit.data.get("school_name"),
                "city": school.get("city") or unit.data.get("city"),
            }
        )
    needed = recommendation_missing(profile.data if profile else None)
    run = RecommendationRun(
        owner_id=actor.id,
        profile_version_id=profile.id if profile else None,
        snapshot={
            "question": data.question,
            "profile": profile.data if profile else None,
            "profile_history": [],
            "units": units,
        },
        status="waiting_input" if needed else "queued",
        event_seq=0,
    )
    db.add(run)
    db.flush()
    emit(db, run, "status", {"status": run.status})
    if not needed:
        db.add(Job(task_type="recommendation", object_id=run.id))
    else:
        emit(db, run, "question", {"questions": [text for _, text in needed]})
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
    needed = recommendation_missing(profile.data)
    run.snapshot, run.profile_version_id, run.status = (
        snapshot,
        profile.id,
        "waiting_input" if needed else "queued",
    )
    emit(db, run, "status", {"status": run.status})
    if not needed:
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
