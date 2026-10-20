import hashlib
import json
from datetime import datetime
from typing import Literal
from urllib.parse import urlparse
from uuid import UUID

from pydantic import Field, model_validator
from sqlalchemy import select

from app.core.errors import DomainError
from app.core.security import advisory_lock
from app.db.models import AdmissionUnit, ImportBatch, Job, School, Source
from app.modules.community.schemas import StrictModel

VOLATILE_IMPORT_FIELDS = {
    "crawl_run_id",
    "crawl_page_id",
    "config_fingerprint",
    "raw_content_hash",
    "model_name",
    "prompt_version",
    "confidence",
    "published_at_source",
    "retrieved_at",
}


class HistoryRow(StrictModel):
    year: int = Field(ge=2000, le=2035)
    rank: int = Field(gt=0)
    score: int = Field(ge=0, le=900)
    rank_cohort: str
    comparable: bool


class AdmissionRow(StrictModel):
    school_code: str = Field(min_length=1, max_length=30)
    school_name: str = Field(min_length=1, max_length=100)
    short_name: str = Field(min_length=1, max_length=20)
    city: str = Field(min_length=1, max_length=30)
    school_province: str = Field(min_length=1, max_length=30)
    unit_code: str = Field(min_length=1, max_length=40)
    unit_type: Literal["major"] = "major"
    province_code: Literal["浙江"]
    exam_year: Literal[2026]
    exam_category: Literal["普通类"] = "普通类"
    batch: str = Field(min_length=1, max_length=30)
    rank_cohort: str = Field(min_length=1, max_length=80)
    campus: str | None = Field(default=None, max_length=100)
    major: str = Field(min_length=1, max_length=100)
    required_subjects: list[str] | None
    tuition: float | None = Field(ge=0, allow_inf_nan=False)
    plan_count: int | None = Field(default=None, ge=0)
    additional_requirements: list[str] = Field(default_factory=list, max_length=30)
    history: list[HistoryRow] = Field(default_factory=list, max_length=10)
    description: str = Field(default="", max_length=3000)

    @model_validator(mode="after")
    def consistent(self):
        if self.required_subjects is not None and (
            len(set(self.required_subjects)) != len(self.required_subjects)
            or set(self.required_subjects)
            - {"物理", "化学", "生物", "历史", "地理", "政治", "技术"}
        ):
            raise ValueError("Invalid subject requirement")
        if any(h.year >= self.exam_year for h in self.history):
            raise ValueError("Historical data must predate the admission year")
        return self


class ImportInput(StrictModel):
    source_url: str = Field(max_length=2000)
    source_title: str = Field(min_length=1, max_length=200)
    published_at: datetime
    locator: str = Field(min_length=1, max_length=200)
    reviewed: Literal[True]
    rows: list[AdmissionRow] = Field(min_length=1, max_length=1000)
    supersedes_import_id: UUID | None = None

    # Optional provenance for crawler-origin batches; manual imports leave these empty.
    origin: Literal["manual", "crawl"] = "manual"
    crawl_run_id: UUID | None = None
    crawl_page_id: UUID | None = None
    config_fingerprint: str | None = Field(default=None, max_length=64)
    raw_content_hash: str | None = Field(default=None, max_length=64)
    model_name: str | None = Field(default=None, max_length=80)
    prompt_version: str | None = Field(default=None, max_length=80)
    confidence: float | None = Field(default=None, ge=0, le=1)
    published_at_source: Literal["official", "retrieved"] | None = None
    retrieved_at: datetime | None = None

    @model_validator(mode="after")
    def timezone_required(self):
        if self.published_at.utcoffset() is None:
            raise ValueError("Publication time requires a timezone")
        if self.retrieved_at is not None and self.retrieved_at.utcoffset() is None:
            raise ValueError("Retrieval time requires a timezone")
        return self


def enqueue_import(db, settings, actor, payload, admission_config=None):
    if admission_config is not None:
        try:
            admission_config.require_allowed_url(payload.source_url)
        except ValueError as exc:
            raise DomainError(422, "SOURCE_INVALID", f"来源不在允许列表：{exc}") from None
    else:
        url = urlparse(payload.source_url)
        host = (url.hostname or "").lower()
        if (
            url.scheme != "https"
            or url.username
            or url.password
            or not (
                host in settings.source_hosts
                or host.endswith(".edu.cn")
                or host.endswith(".gov.cn")
            )
        ):
            raise DomainError(
                422, "SOURCE_INVALID", "须提供允许的官方 HTTPS 来源；不会自动抓取该 URL。"
            )
    data = payload.model_dump(mode="json")
    # Crawl metadata is provenance, not identity: identical rows from a new run
    # must reuse the existing ImportBatch instead of creating a duplicate.
    canonical = payload.model_dump(mode="json", exclude=VOLATILE_IMPORT_FIELDS)
    content_hash = hashlib.sha256(
        json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()
    advisory_lock(db, "import:" + content_hash)
    previous = db.scalar(select(ImportBatch).where(ImportBatch.fingerprint == content_hash))
    if previous:
        return previous
    batch = ImportBatch(owner_id=actor.id, fingerprint=content_hash, payload=data)
    db.add(batch)
    db.flush()
    db.add(Job(task_type="import", object_id=batch.id))
    return batch


def process_import(db, batch):
    # Publication is atomic. No partially imported batch can appear in queries.
    payload = ImportInput.model_validate(batch.payload)
    keys = [(r.school_code, r.unit_code) for r in payload.rows]
    if len(keys) != len(set(keys)):
        raise DomainError(422, "DUPLICATE_UNIT", "批次包含重复招生单位。")
    advisory_lock(db, "admissions:publish")
    source = db.scalar(select(Source).where(Source.content_hash == batch.fingerprint))
    if not source:
        origin_text = "自动抓取、管理员审核后发布" if payload.origin == "crawl" else "人工复核导入"
        source_data = {
            "kind": "official",
            "title": payload.source_title,
            "url": payload.source_url,
            "year": payload.rows[0].exam_year,
            "retrievedAt": (payload.retrieved_at or batch.created_at).isoformat(),
            "excerpt": f"{origin_text}；位置：{payload.locator}",
            "published_at": payload.published_at.isoformat(),
            "published_at_source": payload.published_at_source or "official",
            "locator": payload.locator,
            "origin": payload.origin,
        }
        for key in (
            "config_fingerprint",
            "raw_content_hash",
            "model_name",
            "prompt_version",
            "confidence",
        ):
            value = getattr(payload, key)
            if value is not None:
                source_data[key] = value
        for key in ("crawl_run_id", "crawl_page_id"):
            value = getattr(payload, key)
            if value is not None:
                source_data[key] = str(value)
        source = Source(content_hash=batch.fingerprint, data=source_data)
        db.add(source)
        db.flush()
    for row in payload.rows:
        school = db.scalar(select(School).where(School.code == row.school_code))
        if not school:
            school = School(
                code=row.school_code,
                data={
                    "name": row.school_name,
                    "short": row.short_name,
                    "city": row.city,
                    "province": row.school_province,
                },
            )
            db.add(school)
            db.flush()
        elif school.data["name"] != row.school_name:
            raise DomainError(409, "SCHOOL_CONFLICT", "同院校代码对应不同名称，须人工核对。")
        previous = list(
            db.scalars(
                select(AdmissionUnit).where(
                    AdmissionUnit.school_id == school.id,
                    AdmissionUnit.unit_code == row.unit_code,
                    AdmissionUnit.active.is_(True),
                )
            )
        )
        for old in previous:
            if old.import_id != payload.supersedes_import_id:
                raise DomainError(
                    409, "SOURCE_CONFLICT", "已有当前版本；须人工确认并指定被替代的导入批次。"
                )
            # Current scope is Zhejiang 2026 ordinary-major; versions remain queryable by runs.
            old.active = False
        db.add(
            AdmissionUnit(
                school_id=school.id,
                source_id=source.id,
                import_id=batch.id,
                unit_code=row.unit_code,
                data=row.model_dump(mode="json"),
            )
        )
    batch.status = "published"


def active_units(db):
    return list(db.scalars(select(AdmissionUnit).where(AdmissionUnit.active.is_(True))))


def school_views(db, units=None):
    units = active_units(db) if units is None else units
    grouped: dict = {}
    for unit in units:
        grouped.setdefault(unit.school_id, []).append(unit)
    views = []
    for school in db.scalars(select(School).order_by(School.code)):
        group = grouped.get(school.id, [])
        # A legacy School requires rank and tuition numbers. Do not fabricate zeroes.
        complete = [
            u
            for u in group
            if u.data["tuition"] is not None
            and u.data["history"]
            and u.data["required_subjects"] is not None
        ]
        if not complete:
            continue
        first = complete[0].data
        history = sorted(first["history"], key=lambda h: h["year"])
        views.append(
            {
                "id": str(school.id),
                **school.data,
                "level": "待核对",
                "type": "待核对",
                "rank": history[-1]["rank"],
                "tuition": first["tuition"],
                "majors": list(dict.fromkeys(u.data["major"] for u in group)),
                "requiredSubjects": first["required_subjects"] or [],
                "description": first["description"],
                "color": "#d9b56d",
                "x": 50,
                "y": 50,
                "sourceIds": list(dict.fromkeys(str(u.source_id) for u in group)),
                "history": [{k: h[k] for k in ("year", "rank", "score")} for h in history],
            }
        )
    return views


def unit_view(unit):
    return {
        "id": str(unit.id),
        "school_id": str(unit.school_id),
        "source_id": str(unit.source_id),
        "dataset_version": str(unit.import_id),
        **unit.data,
    }
