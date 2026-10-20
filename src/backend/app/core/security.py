import hashlib
import hmac
import json
import re
import secrets
import unicodedata
from datetime import timedelta

import regex
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import Depends, Request
from sqlalchemy import select, text
from sqlalchemy.dialects.postgresql import insert

from app.core.errors import DomainError
from app.db.models import Idempotency, RateBucket, SessionToken, User, now
from app.db.session import get_db

hasher = PasswordHasher(time_cost=2, memory_cost=19456, parallelism=1)
DUMMY_HASH = hasher.hash(secrets.token_urlsafe(32))
EMAIL = re.compile(
    r"[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+",
    re.ASCII,
)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def fingerprint(secret: str, data) -> str:
    return hmac.new(
        secret.encode(),
        json.dumps(data, sort_keys=True, ensure_ascii=False, default=str).encode(),
        hashlib.sha256,
    ).hexdigest()


def validate_nickname(value: str) -> str:
    value = unicodedata.normalize("NFC", value)
    if not regex.fullmatch(r"[\p{Unified_Ideograph}A-Za-z]{1,5}", value):
        raise DomainError(
            422, "NICKNAME_INVALID", "昵称须为 1–5 个汉字或英文字母，请重新输入。", "nickname"
        )
    return value


def validate_email(value: str, field="email") -> str:
    local = value.split("@")[0]
    if (
        len(value) > 254
        or len(local) > 64
        or not EMAIL.fullmatch(value)
        or local.startswith(".")
        or local.endswith(".")
        or ".." in local
    ):
        raise DomainError(422, "EMAIL_INVALID", "邮箱格式不正确，请重新输入。", field)
    return value.lower()


def verify_password(encoded, password):
    try:
        return hasher.verify(encoded or DUMMY_HASH, password)
    except VerificationError:
        return False


def optional_user(request: Request, db=Depends(get_db)):
    token = request.cookies.get("nv_session")
    if not token:
        return None
    return db.scalar(
        select(User)
        .join(SessionToken, SessionToken.user_id == User.id)
        .where(
            SessionToken.token_hash == digest(token),
            SessionToken.expires_at > now(),
            User.active.is_(True),
        )
    )


def current_user(user=Depends(optional_user)):
    if user is None:
        raise DomainError(401, "SESSION_EXPIRED", "请先登录。")
    return user


def admin(user=Depends(current_user)):
    if user.role != "admin":
        raise DomainError(403, "ROLE_REQUIRED", "需要管理员权限。")
    return user


def reviewer(user=Depends(current_user)):
    if user.role not in {"admin", "reviewer"}:
        raise DomainError(403, "ROLE_REQUIRED", "需要内容审核权限。")
    return user


def advisory_lock(db, key: str):
    lock_id = int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big", signed=True)
    db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": lock_id})


def idempotency(db, namespace: str, key: str | None, signature: str):
    if not key:
        raise DomainError(422, "IDEMPOTENCY_KEY_REQUIRED", "请提供 Idempotency-Key。")
    if len(key) > 128 or not key.isascii():
        raise DomainError(422, "INVALID_INPUT", "幂等键格式不正确。")
    scoped = digest(namespace + ":" + key)
    advisory_lock(db, scoped)
    previous = db.get(Idempotency, scoped)
    if previous and not hmac.compare_digest(previous.fingerprint, signature):
        raise DomainError(409, "IDEMPOTENCY_CONFLICT", "同一幂等键不能用于不同内容。")
    return scoped, previous


def throttle(request: Request, kind: str):
    settings = request.app.state.settings
    # Do not trust arbitrary X-Forwarded-For from clients.
    address = request.client.host if request.client else "unknown"
    window = int(now().timestamp()) // 60
    key = digest(f"{kind}:{address}:{window}")
    limit = {
        "registration": settings.registration_rate_limit,
        "crawl": settings.crawl_rate_limit,
        "chat": settings.chat_rate_limit,
    }.get(kind, settings.auth_rate_limit)
    with request.app.state.sessions.begin() as db:
        count = db.scalar(
            insert(RateBucket)
            .values(key=key, count=1, expires_at=now() + timedelta(minutes=2))
            .on_conflict_do_update(
                index_elements=[RateBucket.key], set_={"count": RateBucket.count + 1}
            )
            .returning(RateBucket.count)
        )
    if count > limit:
        raise DomainError(429, "RATE_LIMITED", "请求过于频繁，请稍后重试。")
