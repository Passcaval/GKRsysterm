from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Sequence,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def now():
    return datetime.now(UTC)


class Base(DeclarativeBase):
    pass


user_id_sequence = Sequence("public_user_id_seq", metadata=Base.metadata)


class Entity:
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)


class User(Entity, Base):
    __tablename__ = "users"
    user_id: Mapped[str] = mapped_column(String(24), unique=True)
    nickname: Mapped[str] = mapped_column(String(5))
    nickname_key: Mapped[str] = mapped_column(String(5), unique=True)
    email: Mapped[str] = mapped_column(String(254))
    email_key: Mapped[str] = mapped_column(String(254), unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(24), default="student")
    active: Mapped[bool] = mapped_column(default=True)
    email_verified: Mapped[bool] = mapped_column(default=False)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("role IN ('student','contributor','reviewer','admin')"),)


class Application(Entity, Base):
    __tablename__ = "registration_applications"
    reserved_user_id: Mapped[str] = mapped_column(String(24), unique=True)
    nickname: Mapped[str | None] = mapped_column(String(5))
    nickname_key: Mapped[str | None] = mapped_column(String(5))
    email: Mapped[str | None] = mapped_column(String(254))
    email_key: Mapped[str | None] = mapped_column(String(254))
    password_hash: Mapped[str | None] = mapped_column(Text)
    status_token_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    version: Mapped[int] = mapped_column(default=1)
    reason: Mapped[str | None] = mapped_column(Text)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (CheckConstraint("status IN ('pending','approved','rejected')"),)


class IdentityClaim(Base):
    __tablename__ = "identity_claims"
    claim_type: Mapped[str] = mapped_column(String(16), primary_key=True)
    claim_value: Mapped[str] = mapped_column(String(254), primary_key=True)
    state: Mapped[str] = mapped_column(String(16))
    application_id: Mapped[UUID | None] = mapped_column(ForeignKey("registration_applications.id"))
    user_pk: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    __table_args__ = (
        CheckConstraint("claim_type IN ('user_id','nickname','email')"),
        CheckConstraint(
            "(state = 'reserved' AND application_id IS NOT NULL AND user_pk IS NULL) OR "
            "(state = 'active' AND application_id IS NULL AND user_pk IS NOT NULL)"
        ),
    )


class RegistrationEvidence(Entity, Base):
    __tablename__ = "registration_evidence"
    application_id: Mapped[UUID] = mapped_column(
        ForeignKey("registration_applications.id"), index=True
    )
    text_content: Mapped[str | None] = mapped_column(Text)
    storage_key: Mapped[str | None] = mapped_column(String(100))
    mime: Mapped[str | None] = mapped_column(String(80))
    size: Mapped[int | None]
    duration: Mapped[float | None]


class ReviewEvent(Entity, Base):
    __tablename__ = "registration_review_events"
    application_id: Mapped[UUID] = mapped_column(ForeignKey("registration_applications.id"))
    admin_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    decision: Mapped[str] = mapped_column(String(16))
    reason: Mapped[str | None] = mapped_column(Text)


class Notification(Base):
    __tablename__ = "admin_notifications"
    application_id: Mapped[UUID] = mapped_column(
        ForeignKey("registration_applications.id"), primary_key=True
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SessionToken(Base):
    __tablename__ = "sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class RateBucket(Base):
    __tablename__ = "rate_buckets"
    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    count: Mapped[int]
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class Idempotency(Base):
    __tablename__ = "idempotency_keys"
    key: Mapped[str] = mapped_column(String(160), primary_key=True)
    fingerprint: Mapped[str] = mapped_column(String(64))
    resource_id: Mapped[UUID]


class ProfileVersion(Entity, Base):
    __tablename__ = "profile_versions"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    version: Mapped[int]
    data: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("owner_id", "version"),)


class Plan(Base):
    __tablename__ = "plans"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    id: Mapped[UUID] = mapped_column(unique=True, default=uuid4)
    version: Mapped[int] = mapped_column(default=1)
    name: Mapped[str] = mapped_column(String(120), default="我的志愿草案")
    entries: Mapped[list] = mapped_column(JSONB, default=list)


class Source(Entity, Base):
    __tablename__ = "source_versions"
    content_hash: Mapped[str] = mapped_column(String(64), unique=True)
    data: Mapped[dict] = mapped_column(JSONB)


class School(Base):
    __tablename__ = "schools"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
    code: Mapped[str] = mapped_column(String(30), unique=True)
    data: Mapped[dict] = mapped_column(JSONB)


class SchoolCatalogRun(Entity, Base):
    __tablename__ = "school_catalog_runs"
    trigger_type: Mapped[str] = mapped_column(String(16))
    triggered_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(24), default="queued")
    version: Mapped[int] = mapped_column(default=1)
    config_fingerprint: Mapped[str] = mapped_column(String(64), index=True)
    config_snapshot: Mapped[dict] = mapped_column(JSONB)
    snapshot: Mapped[dict] = mapped_column(JSONB, default=dict)
    changes: Mapped[list] = mapped_column(JSONB, default=list)
    analysis: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(String(500))
    reviewed_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    review: Mapped[dict] = mapped_column(JSONB, default=dict)
    __table_args__ = (
        CheckConstraint(
            "status IN ('queued','fetching','analysis_pending','analyzing',"
            "'awaiting_review','published','rejected','failed')"
        ),
    )


class SchoolCatalogRevision(Entity, Base):
    __tablename__ = "school_catalog_revisions"
    school_id: Mapped[UUID] = mapped_column(ForeignKey("schools.id"), index=True)
    run_id: Mapped[UUID] = mapped_column(ForeignKey("school_catalog_runs.id"))
    source_id: Mapped[UUID] = mapped_column(ForeignKey("source_versions.id"))
    identifier: Mapped[str] = mapped_column(String(10))
    before: Mapped[dict] = mapped_column(JSONB)
    after: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("run_id", "identifier"),)


class AdmissionUnit(Entity, Base):
    __tablename__ = "admission_units"
    school_id: Mapped[UUID] = mapped_column(ForeignKey("schools.id"), index=True)
    source_id: Mapped[UUID] = mapped_column(ForeignKey("source_versions.id"))
    import_id: Mapped[UUID] = mapped_column(ForeignKey("import_batches.id"))
    unit_code: Mapped[str] = mapped_column(String(40))
    data: Mapped[dict] = mapped_column(JSONB)
    active: Mapped[bool] = mapped_column(default=True)
    __table_args__ = (UniqueConstraint("import_id", "school_id", "unit_code"),)


class ImportBatch(Entity, Base):
    __tablename__ = "import_batches"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    fingerprint: Mapped[str] = mapped_column(String(64), unique=True)
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    errors: Mapped[list] = mapped_column(JSONB, default=list)


class Favorite(Base):
    __tablename__ = "favorites"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), primary_key=True)
    school_id: Mapped[UUID] = mapped_column(ForeignKey("schools.id"), primary_key=True)


class Post(Entity, Base):
    __tablename__ = "posts"
    owner_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"), index=True)
    school_id: Mapped[UUID] = mapped_column(ForeignKey("schools.id"))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    version: Mapped[int] = mapped_column(default=1)
    data: Mapped[dict] = mapped_column(JSONB)


class PostRevision(Entity, Base):
    __tablename__ = "post_revisions"
    post_id: Mapped[UUID] = mapped_column(ForeignKey("posts.id"))
    version: Mapped[int]
    data: Mapped[dict] = mapped_column(JSONB)
    __table_args__ = (UniqueConstraint("post_id", "version"),)


class Verification(Entity, Base):
    __tablename__ = "student_verifications"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    school_id: Mapped[UUID] = mapped_column(ForeignKey("schools.id"))
    storage_key: Mapped[str] = mapped_column(String(100))
    mime: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(20), default="pending")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PostFeedback(Entity, Base):
    __tablename__ = "post_feedback"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    post_id: Mapped[UUID] = mapped_column(ForeignKey("posts.id"))
    kind: Mapped[str] = mapped_column(String(20))
    reason: Mapped[str] = mapped_column(Text)
    __table_args__ = (UniqueConstraint("owner_id", "post_id", "kind"),)


class RecommendationRun(Entity, Base):
    __tablename__ = "recommendation_runs"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    profile_version_id: Mapped[UUID | None] = mapped_column(ForeignKey("profile_versions.id"))
    snapshot: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(24), default="queued")
    result: Mapped[dict | None] = mapped_column(JSONB)
    cancelled: Mapped[bool] = mapped_column(default=False)
    event_seq: Mapped[int] = mapped_column(default=0)


class RunEvent(Base):
    __tablename__ = "run_events"
    run_id: Mapped[UUID] = mapped_column(ForeignKey("recommendation_runs.id"), primary_key=True)
    event_id: Mapped[int] = mapped_column(primary_key=True)
    event_type: Mapped[str] = mapped_column(String(24))
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now)
    payload: Mapped[dict] = mapped_column(JSONB)


class Job(Entity, Base):
    __tablename__ = "jobs"
    task_type: Mapped[str] = mapped_column(String(40))
    object_id: Mapped[UUID]
    source_version: Mapped[int] = mapped_column(default=1)
    processor_version: Mapped[str] = mapped_column(String(40), default="m1-v1")
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    attempts: Mapped[int] = mapped_column(default=0)
    lease_token: Mapped[str | None] = mapped_column(String(64))
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(String(100))
    __table_args__ = (
        UniqueConstraint("task_type", "object_id", "source_version", "processor_version"),
    )


class Feedback(Entity, Base):
    __tablename__ = "feedback_events"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"))
    run_id: Mapped[UUID] = mapped_column(ForeignKey("recommendation_runs.id"))
    recommendation_item_id: Mapped[str] = mapped_column(String(40))
    profile_version_id: Mapped[UUID | None] = mapped_column(ForeignKey("profile_versions.id"))
    kind: Mapped[str] = mapped_column(String(30))
    reason: Mapped[str] = mapped_column(Text)


class Conversation(Entity, Base):
    __tablename__ = "conversations"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)


class ConversationMessage(Entity, Base):
    __tablename__ = "conversation_messages"
    conversation_id: Mapped[UUID] = mapped_column(ForeignKey("conversations.id"), index=True)
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    role: Mapped[str] = mapped_column(String(16))
    content: Mapped[str] = mapped_column(Text)
    source_ids: Mapped[list] = mapped_column(JSONB, default=list)
    model_name: Mapped[str | None] = mapped_column(String(80))
    __table_args__ = (
        CheckConstraint("role IN ('user','assistant')"),
        Index(
            "ix_conversation_messages_conversation_created",
            "conversation_id",
            "created_at",
        ),
    )


class ChatProfileSignal(Entity, Base):
    """A chat-derived profile change awaiting explicit confirmation."""

    __tablename__ = "chat_profile_signals"
    owner_id: Mapped[UUID] = mapped_column(ForeignKey("users.id"), index=True)
    conversation_id: Mapped[UUID] = mapped_column(ForeignKey("conversations.id"), index=True)
    message_id: Mapped[UUID] = mapped_column(ForeignKey("conversation_messages.id"), index=True)
    changes: Mapped[list] = mapped_column(JSONB, default=list)
    source_ids: Mapped[list] = mapped_column(JSONB, default=list)
    query_text: Mapped[str] = mapped_column(String(500))
    status: Mapped[str] = mapped_column(String(16), default="proposed", index=True)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        CheckConstraint("status IN ('proposed','confirmed','rejected')"),
        Index("ix_chat_profile_signals_owner_status", "owner_id", "status"),
    )


class CrawlRun(Entity, Base):
    """A staged auto-crawl run. Nothing is published until an admin reviews it."""

    __tablename__ = "crawl_runs"
    trigger_type: Mapped[str] = mapped_column(String(16))
    triggered_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    config_fingerprint: Mapped[str] = mapped_column(String(64))
    config_snapshot: Mapped[dict] = mapped_column(JSONB)
    model_name: Mapped[str | None] = mapped_column(String(80))
    prompt_version: Mapped[str | None] = mapped_column(String(80))
    progress: Mapped[dict] = mapped_column(JSONB, default=dict)
    rows: Mapped[list] = mapped_column(JSONB, default=list)
    pages_summary: Mapped[dict] = mapped_column(JSONB, default=dict)
    warnings: Mapped[list] = mapped_column(JSONB, default=list)
    errors: Mapped[list] = mapped_column(JSONB, default=list)
    import_ids: Mapped[list] = mapped_column(JSONB, default=list)
    review_payload: Mapped[dict | None] = mapped_column(JSONB)
    version: Mapped[int] = mapped_column(default=1)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    review_reason: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("trigger_type IN ('startup','admin')"),
        CheckConstraint(
            "status IN ('queued','running','awaiting_review','approved','publishing',"
            "'succeeded','partial','rejected','failed','cancelled')"
        ),
        Index("ix_crawl_runs_fingerprint_status", "config_fingerprint", "status"),
        Index("ix_crawl_runs_created_at", "created_at"),
    )


class CrawlPage(Entity, Base):
    __tablename__ = "crawl_pages"
    crawl_run_id: Mapped[UUID] = mapped_column(ForeignKey("crawl_runs.id"))
    url: Mapped[str] = mapped_column(String(2000))
    depth: Mapped[int] = mapped_column(default=0)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    http_status: Mapped[int | None]
    content_type: Mapped[str | None] = mapped_column(String(100))
    content_hash: Mapped[str | None] = mapped_column(String(64))
    storage_key: Mapped[str | None] = mapped_column(String(100))
    title: Mapped[str | None] = mapped_column(String(300))
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    text_chars: Mapped[int] = mapped_column(default=0)
    row_count: Mapped[int] = mapped_column(default=0)
    rows: Mapped[list] = mapped_column(JSONB, default=list)
    error: Mapped[str | None] = mapped_column(Text)
    __table_args__ = (
        CheckConstraint("status IN ('pending','fetched','extracted','skipped','failed')"),
        UniqueConstraint("crawl_run_id", "content_hash"),
        Index("ix_crawl_pages_run_url", "crawl_run_id", "url"),
    )
