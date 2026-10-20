"""Typed public wire contract for the national catalog extension."""

from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel, Field

T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    data: T
    request_id: str


class ConfigView(BaseModel):
    enabled: bool
    auto_start: bool
    model_configured: bool
    model_name: str | None
    publication_url: str
    scope: str
    config_fingerprint: str


class OfficialCounts(BaseModel):
    ordinary: int
    adult: int
    total: int


class ChangeCounts(BaseModel):
    new: int
    changed: int
    unchanged: int
    conflict: int


class Summary(BaseModel):
    id: str
    status: Literal[
        "queued",
        "fetching",
        "analysis_pending",
        "analyzing",
        "awaiting_review",
        "published",
        "rejected",
        "failed",
    ]
    version: int
    trigger_type: str
    created_at: str
    counts: ChangeCounts
    official_counts: OfficialCounts | None
    error: str | None
    review: dict[str, Any]


class Page(BaseModel):
    items: list[Summary]
    next_offset: int | None


class Change(BaseModel):
    identifier: str
    name: str
    kind: Literal["new", "changed", "unchanged", "conflict"]
    before: dict[str, Any]
    after: dict[str, str]
    school_id: str | None
    baseline_hash: str | None


class RawSnapshot(BaseModel):
    url: str
    label: str
    content_hash: str


class Snapshot(BaseModel):
    counts: OfficialCounts | None = None
    as_of: str | None = None
    title: str | None = None
    publication_url: str | None = None
    scope_note: str | None = None
    content_hash: str | None = None
    snapshots: list[RawSnapshot] = Field(default_factory=list)


class Batch(BaseModel):
    offset: int
    count: int
    summary: str
    warnings: list[str]


class Analysis(BaseModel):
    rows_analyzed: int = 0
    model_name: str | None = None
    batches: list[Batch] = Field(default_factory=list)
    usage: dict[str, int] = Field(default_factory=dict)
    finished_at: str | None = None


class Detail(Summary):
    snapshot: Snapshot
    analysis: Analysis
    changes: list[Change]
    total: int
    next_offset: int | None
