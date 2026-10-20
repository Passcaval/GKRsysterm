"""chat-derived profile signals

Revision ID: b2d3e4f5a6c7
Revises: a1c2d3e4f5b6
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "b2d3e4f5a6c7"
down_revision = "a1c2d3e4f5b6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "chat_profile_signals",
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=False),
        sa.Column("changes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("source_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("query_text", sa.String(length=500), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("status IN ('proposed','confirmed','rejected')"),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.ForeignKeyConstraint(["message_id"], ["conversation_messages.id"]),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_chat_profile_signals_owner_id"),
        "chat_profile_signals",
        ["owner_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_chat_profile_signals_conversation_id"),
        "chat_profile_signals",
        ["conversation_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_chat_profile_signals_message_id"),
        "chat_profile_signals",
        ["message_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_chat_profile_signals_status"),
        "chat_profile_signals",
        ["status"],
        unique=False,
    )
    op.create_index(
        "ix_chat_profile_signals_owner_status",
        "chat_profile_signals",
        ["owner_id", "status"],
        unique=False,
    )


def downgrade():
    op.drop_index(
        "ix_chat_profile_signals_owner_status", table_name="chat_profile_signals"
    )
    op.drop_index(
        op.f("ix_chat_profile_signals_status"), table_name="chat_profile_signals"
    )
    op.drop_index(
        op.f("ix_chat_profile_signals_message_id"), table_name="chat_profile_signals"
    )
    op.drop_index(
        op.f("ix_chat_profile_signals_conversation_id"),
        table_name="chat_profile_signals",
    )
    op.drop_index(
        op.f("ix_chat_profile_signals_owner_id"), table_name="chat_profile_signals"
    )
    op.drop_table("chat_profile_signals")
