from typing import Literal

from pydantic import Field, model_validator
from sqlalchemy import select

from app.core.errors import DomainError
from app.db.models import ChatProfileSignal, ProfileVersion, User
from app.modules.community.schemas import StrictModel


class ProfileInput(StrictModel):
    province: str = Field(min_length=1, max_length=30)
    year: int = Field(ge=2024, le=2035)
    score: int | None = Field(default=None, ge=0, le=900)
    rank: int = Field(ge=1, le=5000000)
    # Drafts may omit subjects; personalised runs require three confirmed subjects.
    # Score and preferences can be added after the initial rank-based recommendation.
    subjects: list[Literal["物理", "化学", "生物", "历史", "地理", "政治", "技术"]] = Field(
        default_factory=list, max_length=3
    )
    cities: list[str] = Field(default_factory=list, max_length=30)
    interests: list[str] = Field(default_factory=list, max_length=30)
    schools: list[str] = Field(default_factory=list, max_length=30)
    budget: float | None = Field(default=None, ge=0, le=10000000, allow_inf_nan=False)
    acceptAdjustment: bool = False
    consent: Literal[True]
    rank_cohort: str | None = Field(default=None, max_length=80)
    batch: str | None = Field(default=None, max_length=30)

    @model_validator(mode="after")
    def unique_subjects(self):
        if len(set(self.subjects)) != len(self.subjects):
            raise ValueError("Subjects must be distinct")
        return self


class ProfilePatch(StrictModel):
    expected_version: int = Field(ge=0)
    profile: ProfileInput


CHAT_PROFILE_DEFAULTS = {
    "province": "",
    "year": 2026,
    "score": None,
    "rank": None,
    "subjects": [],
    "cities": [],
    "interests": [],
    "schools": [],
    "budget": None,
    "acceptAdjustment": False,
    "consent": False,
    "rank_cohort": None,
    "batch": None,
}


def recommendation_missing(profile: dict | None) -> list[tuple[str, str]]:
    p = profile or {}
    missing = []
    if not p.get("province"):
        missing.append(("province_code", "请填写生源省份，例如浙江"))
    if not p.get("year"):
        missing.append(("exam_year", "请填写报考年份"))
    if len(p.get("subjects") or []) != 3:
        missing.append(("subjects", "请选择三门选考科目"))
    if p.get("rank") is None:
        missing.append(("rank", "请填写省内位次"))
    if not p.get("consent"):
        missing.append(("consent", "是否同意将画像用于本次推荐？填写 true"))
    return missing


def current_profile(db, owner_id):
    return db.scalar(
        select(ProfileVersion)
        .where(ProfileVersion.owner_id == owner_id)
        .order_by(ProfileVersion.version.desc())
        .limit(1)
    )


def save_profile(db, owner_id, profile, expected_version=None):
    # Serialize first creation as well as updates; all writers acquire this lock.
    db.scalar(select(User).where(User.id == owner_id).with_for_update())
    current = current_profile(db, owner_id)
    version = current.version if current else 0
    if expected_version is not None and version != expected_version:
        raise DomainError(409, "PROFILE_VERSION_CONFLICT", "画像已更新，请刷新后重试。")
    payload = profile.model_dump() if hasattr(profile, "model_dump") else dict(profile)
    record = ProfileVersion(owner_id=owner_id, version=version + 1, data=payload)
    db.add(record)
    db.flush()
    return record


def merge_chat_values(base: dict | None, changes) -> dict:
    values = {**CHAT_PROFILE_DEFAULTS, **(base or {})}
    allowed = {"province", "year", "score", "rank", "subjects", "cities", "interests", "schools"}
    for change in changes:
        field = change.get("field")
        if field in allowed:
            values[field] = change.get("new")
    return values


def apply_chat_changes(db, owner_id, changes):
    """Merge explicit chat facts into a draft profile without requiring a form.

    The saved row is still an ordinary ProfileVersion.  Recommendations keep
    checking for province/year/rank/subjects/consent, so a partial chat profile
    is a draft, not a completed application.
    """
    db.scalar(select(User).where(User.id == owner_id).with_for_update())
    current = current_profile(db, owner_id)
    values = merge_chat_values(current.data if current else None, changes)
    return save_profile(db, owner_id, values, current.version if current else 0)


def conversation_profile(db, conversation_id) -> dict:
    """Profile facts stated inside one conversation, independent of other chats."""
    values: dict = {}
    signals = db.scalars(
        select(ChatProfileSignal)
        .where(
            ChatProfileSignal.conversation_id == conversation_id,
            ChatProfileSignal.status == "confirmed",
        )
        .order_by(ChatProfileSignal.created_at, ChatProfileSignal.id)
    )
    for signal in signals:
        values = merge_chat_values(values, signal.changes or [])
    return values or dict(CHAT_PROFILE_DEFAULTS)


def profile_view(record):
    return (
        {
            "profile_version_id": str(record.id),
            "version": record.version,
            "profile": record.data,
            "created_at": record.created_at.isoformat(),
        }
        if record
        else None
    )
