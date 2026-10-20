"""chat conversation messages

Revision ID: a1c2d3e4f5b6
Revises: 9b7c1d2e3f4a
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "a1c2d3e4f5b6"
down_revision = "9b7c1d2e3f4a"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "conversation_messages",
        sa.Column("conversation_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=16), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source_ids", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("model_name", sa.String(length=80), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("role IN ('user','assistant')"),
        sa.ForeignKeyConstraint(["conversation_id"], ["conversations.id"]),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_conversation_messages_conversation_id"),
        "conversation_messages",
        ["conversation_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_conversation_messages_owner_id"),
        "conversation_messages",
        ["owner_id"],
        unique=False,
    )
    op.create_index(
        "ix_conversation_messages_conversation_created",
        "conversation_messages",
        ["conversation_id", "created_at"],
        unique=False,
    )


def downgrade():
    op.drop_index(
        "ix_conversation_messages_conversation_created",
        table_name="conversation_messages",
    )
    op.drop_index(
        op.f("ix_conversation_messages_owner_id"), table_name="conversation_messages"
    )
    op.drop_index(
        op.f("ix_conversation_messages_conversation_id"),
        table_name="conversation_messages",
    )
    op.drop_table("conversation_messages")
