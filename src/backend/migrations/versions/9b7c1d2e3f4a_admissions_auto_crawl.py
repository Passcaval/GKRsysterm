"""admissions auto crawl staging

Revision ID: 9b7c1d2e3f4a
Revises: 0cea5c2a1ab2
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "9b7c1d2e3f4a"
down_revision = "0cea5c2a1ab2"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "crawl_runs",
        sa.Column("trigger_type", sa.String(length=16), nullable=False),
        sa.Column("triggered_by", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("config_fingerprint", sa.String(length=64), nullable=False),
        sa.Column("config_snapshot", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("model_name", sa.String(length=80), nullable=True),
        sa.Column("prompt_version", sa.String(length=80), nullable=True),
        sa.Column("progress", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("rows", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("pages_summary", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("warnings", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("errors", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("import_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("review_payload", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_by", sa.Uuid(), nullable=True),
        sa.Column("review_reason", sa.Text(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("trigger_type IN ('startup','admin')"),
        sa.CheckConstraint(
            "status IN ('queued','running','awaiting_review','approved','publishing',"
            "'succeeded','partial','rejected','failed','cancelled')"
        ),
        sa.ForeignKeyConstraint(["triggered_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["reviewed_by"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_crawl_runs_status"), "crawl_runs", ["status"], unique=False)
    op.create_index(
        "ix_crawl_runs_created_at", "crawl_runs", ["created_at"], unique=False
    )
    op.create_index(
        "ix_crawl_runs_fingerprint_status",
        "crawl_runs",
        ["config_fingerprint", "status"],
        unique=False,
    )

    op.create_table(
        "crawl_pages",
        sa.Column("crawl_run_id", sa.Uuid(), nullable=False),
        sa.Column("url", sa.String(length=2000), nullable=False),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("http_status", sa.Integer(), nullable=True),
        sa.Column("content_type", sa.String(length=100), nullable=True),
        sa.Column("content_hash", sa.String(length=64), nullable=True),
        sa.Column("storage_key", sa.String(length=100), nullable=True),
        sa.Column("title", sa.String(length=300), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("text_chars", sa.Integer(), nullable=False),
        sa.Column("row_count", sa.Integer(), nullable=False),
        sa.Column("rows", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('pending','fetched','extracted','skipped','failed')"),
        sa.ForeignKeyConstraint(["crawl_run_id"], ["crawl_runs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("crawl_run_id", "content_hash"),
    )
    op.create_index(
        "ix_crawl_pages_run_url", "crawl_pages", ["crawl_run_id", "url"], unique=False
    )


def downgrade():
    op.drop_index("ix_crawl_pages_run_url", table_name="crawl_pages")
    op.drop_table("crawl_pages")
    op.drop_index("ix_crawl_runs_fingerprint_status", table_name="crawl_runs")
    op.drop_index("ix_crawl_runs_created_at", table_name="crawl_runs")
    op.drop_index(op.f("ix_crawl_runs_status"), table_name="crawl_runs")
    op.drop_table("crawl_runs")
