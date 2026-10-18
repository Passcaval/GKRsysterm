import hmac
from uuid import UUID, uuid4

from sqlalchemy import delete, select

from app.core.errors import DomainError, missing
from app.core.security import (
    digest,
    fingerprint,
    hasher,
    idempotency,
    validate_email,
    validate_nickname,
)
from app.db.models import (
    Application,
    Idempotency,
    IdentityClaim,
    Notification,
    RegistrationEvidence,
    ReviewEvent,
    User,
    now,
    user_id_sequence,
)


def status_token(settings, application_id):
    return fingerprint(settings.app_secret, ["registration-status", str(application_id)])


def public_status(application):
    return {
        "application_id": str(application.id),
        "reserved_user_id": application.reserved_user_id,
        "status": application.status,
        "version": application.version,
        "reason": application.reason,
    }


def submit(db, settings, data, key, audio_hash, audio_info=None):
    nickname = validate_nickname(data.nickname)
    email_key = validate_email(data.email)
    if not (data.evidence_text and data.evidence_text.strip()) and not audio_info:
        raise DomainError(422, "EVIDENCE_REQUIRED", "请提供文字或语音审核证据。")
    signature = fingerprint(settings.app_secret, [data.model_dump(), audio_hash])
    scoped, previous = idempotency(db, "registration", key, signature)
    if previous:
        app = db.get(Application, previous.resource_id)
        return app, status_token(settings, app.id), False
    application_id = uuid4()
    token = status_token(settings, application_id)
    app = Application(
        id=application_id,
        reserved_user_id=f"U{db.scalar(user_id_sequence.next_value()):010d}",
        nickname=nickname,
        nickname_key=nickname.lower(),
        email=data.email,
        email_key=email_key,
        password_hash=hasher.hash(data.password),
        status_token_hash=digest(token),
        status="pending",
    )
    db.add(app)
    db.flush()
    for kind, value in (
        ("user_id", app.reserved_user_id),
        ("nickname", app.nickname_key),
        ("email", email_key),
    ):
        db.add(
            IdentityClaim(
                claim_type=kind, claim_value=value, state="reserved", application_id=app.id
            )
        )
    db.add(
        RegistrationEvidence(
            application_id=app.id, text_content=data.evidence_text, **(audio_info or {})
        )
    )
    db.add(Notification(application_id=app.id))
    db.add(Idempotency(key=scoped, fingerprint=signature, resource_id=app.id))
    db.flush()
    return app, token, True


def lookup(db, application_id: UUID, token: str | None):
    app = db.get(Application, application_id)
    if app is None or not token or not hmac.compare_digest(app.status_token_hash, digest(token)):
        missing()
    return app


def decide(db, application_id, actor, decision, settings):
    app = db.scalar(select(Application).where(Application.id == application_id).with_for_update())
    if app is None:
        missing()
    target = "approved" if decision.decision == "approve" else "rejected"
    if app.status != "pending":
        if app.status == target and app.version == decision.expected_version + 1:
            return app
        raise DomainError(409, "REVIEW_ALREADY_DECIDED", "申请已处理，请刷新。")
    if app.version != decision.expected_version:
        raise DomainError(409, "VERSION_CONFLICT", "申请版本已更新。")
    claims = list(
        db.scalars(
            select(IdentityClaim).where(IdentityClaim.application_id == app.id).with_for_update()
        )
    )
    expected = {
        ("user_id", app.reserved_user_id),
        ("nickname", app.nickname_key),
        ("email", app.email_key),
    }
    if {(c.claim_type, c.claim_value) for c in claims} != expected or any(
        c.state != "reserved" for c in claims
    ):
        raise DomainError(409, "IDENTITY_CONFLICT", "申请标识占用异常，请核查。")
    if target == "approved":
        from app.core.storage import blob_path, validate_audio

        evidence = list(
            db.scalars(
                select(RegistrationEvidence).where(RegistrationEvidence.application_id == app.id)
            )
        )
        if not evidence or not any(
            (e.text_content and e.text_content.strip()) or e.storage_key for e in evidence
        ):
            raise DomainError(422, "EVIDENCE_REQUIRED", "审核证据缺失，不能批准。")
        for item in evidence:
            if item.storage_key:
                path = blob_path(settings, item.storage_key)
                if not path.is_file():
                    raise DomainError(422, "EVIDENCE_MISSING", "原始语音材料缺失，不能批准。")
                validate_audio(path.read_bytes())
        user = User(
            user_id=app.reserved_user_id,
            nickname=app.nickname,
            nickname_key=app.nickname_key,
            email=app.email,
            email_key=app.email_key,
            password_hash=app.password_hash,
            role="student",
            email_verified=False,
        )
        db.add(user)
        db.flush()
        for claim in claims:
            claim.state, claim.application_id, claim.user_pk = "active", None, user.id
    else:
        db.execute(
            delete(IdentityClaim).where(
                IdentityClaim.application_id == app.id, IdentityClaim.state == "reserved"
            )
        )
    app.status, app.version, app.reviewed_at = target, app.version + 1, now()
    app.reason = decision.reason if target == "rejected" else None
    app.password_hash = app.nickname = app.nickname_key = app.email = app.email_key = None
    db.add(
        ReviewEvent(
            application_id=app.id,
            admin_id=actor.id,
            decision=decision.decision,
            reason=decision.reason,
        )
    )
    notification = db.get(Notification, app.id)
    notification.read_at = now()
    db.flush()
    return app
