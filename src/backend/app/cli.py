import argparse
import getpass
import os
from datetime import timedelta

from sqlalchemy import create_engine, delete, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.security import hasher, validate_email, validate_nickname
from app.core.storage import blob_path
from app.db.models import (
    Application,
    IdentityClaim,
    RateBucket,
    RegistrationEvidence,
    SessionToken,
    User,
    now,
    user_id_sequence,
)


def create_admin(db, nickname, email, password):
    nickname = validate_nickname(nickname)
    email_key = validate_email(email)
    if not 8 <= len(password) <= 256:
        raise ValueError("Password must contain 8–256 characters")
    user = User(
        user_id=f"U{db.scalar(user_id_sequence.next_value()):010d}",
        nickname=nickname,
        nickname_key=nickname.lower(),
        email=email,
        email_key=email_key,
        password_hash=hasher.hash(password),
        role="admin",
    )
    db.add(user)
    db.flush()
    for kind, value in (
        ("user_id", user.user_id),
        ("nickname", user.nickname_key),
        ("email", email_key),
    ):
        db.add(IdentityClaim(claim_type=kind, claim_value=value, state="active", user_pk=user.id))
    db.flush()
    return user


def cleanup(db, settings):
    cutoff = now() - timedelta(days=settings.evidence_retention_days)
    records = list(
        db.scalars(
            select(RegistrationEvidence)
            .join(Application)
            .where(
                Application.status.in_(["approved", "rejected"]), Application.reviewed_at < cutoff
            )
        )
    )
    keys = [row.storage_key for row in records if row.storage_key]
    for row in records:
        db.delete(row)
    db.execute(delete(SessionToken).where(SessionToken.expires_at < now()))
    db.execute(delete(RateBucket).where(RateBucket.expires_at < now()))
    db.commit()
    for key in keys:
        blob_path(settings, key).unlink(missing_ok=True)
    return len(records)


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    admin = commands.add_parser("create-admin")
    admin.add_argument("--nickname", required=True)
    admin.add_argument("--email", required=True)
    commands.add_parser("cleanup")
    args = parser.parse_args()
    settings = Settings()
    engine = create_engine(settings.database_url, hide_parameters=True)
    try:
        with Session(engine) as db:
            if args.command == "create-admin":
                password = os.environ.get("NV_ADMIN_PASSWORD") or getpass.getpass(
                    "Admin password: "
                )
                user = create_admin(db, args.nickname, args.email, password)
                db.commit()
                print("Created administrator:", user.user_id)
            else:
                print("Removed expired terminal-application evidence:", cleanup(db, settings))
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
