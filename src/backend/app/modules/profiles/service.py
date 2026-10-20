from typing import Literal

from pydantic import Field, model_validator
from sqlalchemy import select

from app.core.errors import DomainError
from app.db.models import ProfileVersion, User
from app.modules.community.schemas import StrictModel


class ProfileInput(StrictModel):
    province: str = Field(min_length=1, max_length=30)
    year: int = Field(ge=2024, le=2035)
    score: int = Field(ge=0, le=900)
    rank: int = Field(ge=1, le=5000000)
    # Only province, year, score and rank are required for a recommendation.
    # The remaining fields are optional and are surfaced as follow-up prompts
    # when absent; recommendations still run in an explicitly "unknown" state.
    subjects: list[Literal["物理", "化学", "生物", "历史", "地理", "政治", "技术"]] = Field(
        default_factory=list, max_length=3
    )
    cities: list[str] = Field(default_factory=list, max_length=30)
    interests: list[str] = Field(default_factory=list, max_length=30)
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
    record = ProfileVersion(owner_id=owner_id, version=version + 1, data=profile.model_dump())
    db.add(record)
    db.flush()
    return record


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
