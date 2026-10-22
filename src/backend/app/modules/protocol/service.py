"""v0.4 wire DTOs; domain snapshots remain independent from browser naming."""

import re
from copy import deepcopy
from uuid import UUID

from pydantic import Field, model_validator
from sqlalchemy import select

from app.core.errors import DomainError, missing
from app.db.models import RegistrationEvidence, Source, User
from app.modules.community.registration import public_status
from app.modules.community.router import verified
from app.modules.profiles.service import ProfileInput, recommendation_missing


def wire(value):
    if isinstance(value, list):
        return [wire(v) for v in value]
    if isinstance(value, dict):
        return {
            re.sub(r"[A-Z]", lambda m: "_" + m[0].lower(), k): wire(v) for k, v in value.items()
        }
    return value


def page(items, cursor=None, limit=30):
    try:
        offset = int(cursor or "0")
        if offset < 0:
            raise ValueError()
    except ValueError:
        raise DomainError(422, "CURSOR_INVALID", "分页游标不正确。") from None
    return {
        "items": items[offset : offset + limit],
        "next_cursor": str(offset + limit) if offset + limit < len(items) else None,
    }


def user_view(db, user):
    permissions = []
    if user.role in {"reviewer", "admin"}:
        permissions.append("content:review")
    if user.role == "admin":
        permissions.extend(["registration:review", "admissions:import"])
    return {
        "id": str(user.id),
        "user_id": user.user_id,
        "nickname": user.nickname,
        "email": user.email,
        "email_verified": user.email_verified,
        "role": user.role,
        "student_verified": verified(db, user),
        "permissions": permissions,
    }


def application_view(db, application, *, detail=False):
    output = {
        **public_status(application),
        "created_at": application.created_at.isoformat(),
        "reviewed_at": application.reviewed_at.isoformat() if application.reviewed_at else None,
    }
    if detail:
        evidence = list(
            db.scalars(
                select(RegistrationEvidence).where(
                    RegistrationEvidence.application_id == application.id
                )
            )
        )
        # Terminal temporary identifiers have been purged. Approved users retain their formal identity.
        formal = (
            db.scalar(select(User).where(User.user_id == application.reserved_user_id))
            if application.status == "approved"
            else None
        )
        output.update(
            nickname=application.nickname or (formal.nickname if formal else ""),
            email=application.email or (formal.email if formal else ""),
            evidence_text="\n".join(e.text_content for e in evidence if e.text_content),
            has_audio=any(e.storage_key for e in evidence),
        )
    return output


class InternalProfile(ProfileInput):
    province: str = Field(default="", max_length=30)
    score: int | None = Field(default=None, ge=0, le=900)
    rank: int | None = Field(default=None, ge=1, le=5000000)
    subjects: list[str] = Field(default_factory=list, max_length=3)
    budget: float | None = Field(default=None, ge=0, le=10000000, allow_inf_nan=False)
    exam_category: str = "普通类"
    budget_scope: str = "tuition"
    preferences: list[dict] = Field(default_factory=list, max_length=50)

    @model_validator(mode="after")
    def unique_subjects(self):
        if len(set(self.subjects)) != len(self.subjects) or set(self.subjects) - {
            "物理",
            "化学",
            "生物",
            "历史",
            "地理",
            "政治",
            "技术",
        }:
            raise ValueError("Invalid subjects")
        return self


def profile_view(record):
    if not record:
        return None
    p = record.data
    return {
        "province_code": p["province"] or None,
        "exam_year": p["year"],
        "exam_category": p.get("exam_category", "普通类"),
        "subjects": p["subjects"],
        "score": p["score"],
        "rank": p["rank"],
        "rank_cohort": p.get("rank_cohort"),
        "budget": {
            "amount": p["budget"],
            "currency": "CNY",
            "period": "year",
            "scope": p.get("budget_scope", "tuition"),
        },
        "preferred_regions": p["cities"],
        "preferred_majors": p["interests"],
        "preferred_schools": p.get("schools", []),
        "accept_adjustment": p["acceptAdjustment"],
        "consent": p["consent"],
        "preferences": p.get("preferences", []),
        "version": record.version,
        "profile_version_id": str(record.id),
    }


def internal_profile(raw, existing=None):
    p = deepcopy(
        existing
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
    mapping = {
        "province_code": "province",
        "exam_year": "year",
        "preferred_regions": "cities",
        "preferred_majors": "interests",
        "preferred_schools": "schools",
        "accept_adjustment": "acceptAdjustment",
    }
    for key, value in raw.items():
        if key == "expected_version":
            continue
        if key == "budget":
            p["budget"], p["budget_scope"] = value["amount"], value["scope"]
        else:
            p[mapping.get(key, key)] = value if key != "province_code" else value or ""
    try:
        return InternalProfile.model_validate(p)
    except ValueError:
        raise DomainError(
            422, "PROFILE_INVALID", "请核对画像字段，并确认同意用于本次推荐。"
        ) from None


def required_questions(snapshot):
    """Fields that block a personalised recommendation.

    Province, exam year, rank, three subjects and consent are required.
    Score and preferences remain optional so a first recommendation can run
    before the student has decided where or what to study.
    """
    p = snapshot.get("profile") or {}
    if snapshot.get("intent", "risk") == "campus_life":
        return []
    missing_fields = recommendation_missing(p)
    return [{"field": field, "text": text, "required": True} for field, text in missing_fields]


def optional_questions(snapshot):
    p = snapshot.get("profile") or {}
    missing_fields = []
    if p.get("score") is None:
        missing_fields.append(("score", "分数可稍后补充，不影响先按位次与选科推荐"))
    if not p.get("cities"):
        missing_fields.append(("cities", "补充城市偏好后，可按地域比较院校"))
    if not p.get("interests"):
        missing_fields.append(("interests", "补充专业兴趣后，可优先展示匹配方向"))
    if not p.get("schools"):
        missing_fields.append(("schools", "意向院校可稍后补充，先比较不同院校方向"))
    if p.get("budget") is None:
        missing_fields.append(("budget", "补充学费预算后，可排除超预算选项"))
    if not p.get("rank_cohort"):
        missing_fields.append(("rank_cohort", "补充位次口径后，可使用同口径历史参考"))
    if not p.get("batch"):
        missing_fields.append(("batch", "确认报考批次后，可校验招生单位批次"))
    return [{"field": field, "text": text, "required": False} for field, text in missing_fields]


def questions(snapshot):
    return required_questions(snapshot)


def run_view(run):
    output = run.result or {}
    items = deepcopy([*output.get("items", []), *output.get("pending_confirmation", [])])
    for item in items:
        item["major_id"] = item["admission_unit_id"]
        item["historical_risk"]["status"] = "unknown"
        preference = item["preference_match"]
        preference["score"] = (
            None if preference["score"] is None else round(preference["score"] * 100)
        )
        preference["breakdown"] = [
            {"label": b["dimension"], "score": b["value"] * 100} for b in preference["breakdown"]
        ]
    return {
        "run_id": str(run.id),
        "status": run.status,
        "version": max(1, run.event_seq),
        "question": run.snapshot["question"],
        "profile_version_id": str(run.profile_version_id) if run.profile_version_id else None,
        "original_profile_version_id": run.snapshot.get("original_profile_version_id"),
        "data_version": ",".join(sorted({u["dataset_version"] for u in run.snapshot["units"]}))
        or None,
        "rule_version": output.get("rule_version"),
        "created_at": run.created_at.isoformat(),
        "questions": questions(run.snapshot) if run.status == "waiting_input" else [],
        "items": items,
        "branches": deepcopy(output.get("branches", [])),
        "missing_info": optional_questions(run.snapshot),
        "validation": {
            "status": "passed"
            if output.get("validation", {}).get("status") == "pass"
            else "failed"
            if run.status == "failed"
            else "pending",
            "summary": "仅核对官方资料与已知条件，不计算录取概率",
        },
        "last_event_id": run.event_seq,
        "summary": "；".join(output.get("warnings", [])),
        "error": "任务失败，请核对输入与服务状态。" if run.status == "failed" else None,
    }


def unit_view(unit):
    d = unit.data
    return {
        "id": str(unit.id),
        "school_id": str(unit.school_id),
        "campus_id": None,
        "campus_name": d["campus"],
        "unit_type": d["unit_type"],
        "province_code": d["province_code"],
        "exam_year": d["exam_year"],
        "exam_category": d["exam_category"],
        "batch": d["batch"],
        "code": unit.unit_code,
        "majors": [{"id": str(unit.id), "name": d["major"]}],
        "required_subjects": d["required_subjects"] or [],
        "requirements_known": d["required_subjects"] is not None,
        "data_version": str(unit.import_id),
        "source_ids": [str(unit.source_id)],
    }


def source_view(db, source_id):
    item = db.get(Source, UUID(str(source_id)))
    if not item:
        missing()
    return {
        "id": str(item.id),
        **wire(
            {key: value for key, value in item.data.items() if key not in {"body", "query_hash"}}
        ),
        "content_hash": item.content_hash,
        "version": item.content_hash,
        "support_status": "unverified",
        "freshness": "unknown",
    }
