import hashlib
import re
import secrets
from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, Header, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy import delete, func, select
from starlette.datastructures import UploadFile

from app.core.errors import DomainError, missing, result
from app.core.security import admin, current_user, digest, throttle, validate_email, verify_password
from app.core.storage import blob_path, read_upload, save_blob, validate_audio
from app.db.models import (
    Application,
    RegistrationEvidence,
    ReviewEvent,
    SessionToken,
    User,
    Verification,
    now,
)
from app.db.session import get_db
from app.modules.community import registration
from app.modules.community.schemas import Decision, Login, Registration

router = APIRouter(prefix="/api/v1", tags=["accounts"])


def verified(db, user):
    return bool(
        db.scalar(
            select(Verification.id)
            .where(
                Verification.owner_id == user.id,
                Verification.status == "approved",
                Verification.expires_at > now(),
            )
            .limit(1)
        )
    )


def user_view(db, user):
    return {
        "id": str(user.id),
        "name": user.nickname,
        "role": user.role,
        "verified": verified(db, user),
    }


@router.post("/auth/login")
def login(data: Login, request: Request, response: Response, db=Depends(get_db)):
    throttle(request, "login")
    if data.login_type == "email":
        key = validate_email(data.identifier, "identifier")
        query = User.email_key == key
    else:
        if not re.fullmatch(r"U[0-9]{10,20}", data.identifier):
            raise DomainError(
                422, "IDENTIFIER_INVALID", "邮箱或用户 ID 格式不正确，请重新输入。", "identifier"
            )
        query = User.user_id == data.identifier
    user = db.scalar(select(User).where(query))
    valid = verify_password(user.password_hash if user else None, data.password)
    if not user or not valid or not user.active:
        raise DomainError(401, "INVALID_CREDENTIALS", "账号或密码错误。")
    old = request.cookies.get("nv_session")
    if old:
        db.execute(delete(SessionToken).where(SessionToken.token_hash == digest(old)))
    token = secrets.token_urlsafe(48)
    settings = request.app.state.settings
    db.add(
        SessionToken(
            token_hash=digest(token),
            user_id=user.id,
            expires_at=now() + timedelta(hours=settings.session_hours),
        )
    )
    db.commit()
    response.set_cookie(
        "nv_session",
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=settings.session_hours * 3600,
        path="/",
    )
    return result(request, user_view(db, user))


@router.post("/auth/logout")
def logout(request: Request, response: Response, db=Depends(get_db)):
    token = request.cookies.get("nv_session")
    if token:
        db.execute(delete(SessionToken).where(SessionToken.token_hash == digest(token)))
        db.commit()
    response.delete_cookie(
        "nv_session",
        path="/",
        httponly=True,
        secure=request.app.state.settings.cookie_secure,
        samesite="lax",
    )
    return result(request, None)


@router.get("/auth/me")
def me(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(
        request,
        {
            **user_view(db, user),
            "user_id": user.user_id,
            "email_verified": user.email_verified,
            "email_verified_at": None,
        },
    )


@router.post("/registration-applications", status_code=202)
async def apply(
    request: Request, idempotency_key: str | None = Header(default=None), db=Depends(get_db)
):
    throttle(request, "registration")
    settings = request.app.state.settings
    form = await request.form(max_files=1, max_fields=5, max_part_size=12000)
    allowed = {"nickname", "email", "password", "evidence_text", "evidence_audio"}
    if set(form) - allowed or len(form.multi_items()) != len(form):
        await form.close()
        raise DomainError(422, "INVALID_INPUT", "申请包含未允许或重复的字段。")
    upload = form.get("evidence_audio")
    try:
        data = Registration.model_validate({k: v for k, v in form.items() if k != "evidence_audio"})
    except ValidationError as exc:
        await form.close()
        raise RequestValidationError(exc.errors()) from None
    stored = None
    audio_info = None
    audio_hash = None
    try:
        if upload is not None:
            if not isinstance(upload, UploadFile):
                raise DomainError(422, "INVALID_INPUT", "语音字段必须是文件。")
            content = await read_upload(upload, settings)
            mime, duration = validate_audio(content)
            audio_hash = hashlib.sha256(content).hexdigest()
            stored = save_blob(settings, content)
            audio_info = {
                "storage_key": stored,
                "mime": mime,
                "duration": duration,
                "size": len(content),
            }
        app, token, created = registration.submit(
            db, settings, data, idempotency_key, audio_hash, audio_info
        )
        db.commit()
        if stored and not created:
            blob_path(settings, stored).unlink(missing_ok=True)
        return result(request, {**registration.public_status(app), "status_token": token})
    except Exception:
        db.rollback()
        if stored:
            blob_path(settings, stored).unlink(missing_ok=True)
        raise
    finally:
        await form.close()


@router.get("/registration-applications/{application_id}")
def status(
    application_id: UUID,
    request: Request,
    x_application_token: str | None = Header(default=None),
    db=Depends(get_db),
):
    return result(
        request,
        registration.public_status(registration.lookup(db, application_id, x_application_token)),
    )


@router.get("/admin/registration-applications")
def queue(
    request: Request,
    status: str = "pending",
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=30, ge=1, le=100),
    actor=Depends(admin),
    db=Depends(get_db),
):
    if status not in {"pending", "approved", "rejected"}:
        raise DomainError(422, "INVALID_INPUT", "未知申请状态。")
    items = db.scalars(
        select(Application)
        .where(Application.status == status)
        .order_by(Application.created_at, Application.id)
        .offset(offset)
        .limit(limit)
    )
    return result(
        request,
        {
            "items": [
                {
                    **registration.public_status(a),
                    "nickname": a.nickname,
                    "email": a.email,
                    "created_at": a.created_at.isoformat(),
                }
                for a in items
            ],
            "pending_count": db.scalar(
                select(func.count()).select_from(Application).where(Application.status == "pending")
            ),
        },
    )


@router.get("/admin/registration-applications/{application_id}")
def detail(application_id: UUID, request: Request, actor=Depends(admin), db=Depends(get_db)):
    app = db.get(Application, application_id)
    if not app:
        missing()
    evidence = db.scalars(
        select(RegistrationEvidence).where(RegistrationEvidence.application_id == app.id)
    )
    events = db.scalars(
        select(ReviewEvent)
        .where(ReviewEvent.application_id == app.id)
        .order_by(ReviewEvent.created_at)
    )
    return result(
        request,
        {
            **registration.public_status(app),
            "nickname": app.nickname,
            "email": app.email,
            "evidence": [
                {
                    "evidence_id": str(e.id),
                    "text": e.text_content,
                    "mime": e.mime,
                    "duration": e.duration,
                    "audio_url": f"/api/v1/admin/registration-applications/{app.id}/evidence/{e.id}/audio"
                    if e.storage_key
                    else None,
                }
                for e in evidence
            ],
            "reviews": [
                {"decision": e.decision, "reason": e.reason, "timestamp": e.created_at.isoformat()}
                for e in events
            ],
        },
    )


@router.get("/admin/registration-applications/{application_id}/evidence/{evidence_id}/audio")
def audio(
    application_id: UUID,
    evidence_id: UUID,
    request: Request,
    actor=Depends(admin),
    db=Depends(get_db),
):
    evidence = db.get(RegistrationEvidence, evidence_id)
    if not evidence or evidence.application_id != application_id or not evidence.storage_key:
        missing()
    path = blob_path(request.app.state.settings, evidence.storage_key)
    if not path.is_file():
        missing()
    return FileResponse(
        path,
        media_type=evidence.mime,
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


@router.post("/admin/registration-applications/{application_id}/decision")
def decision(
    application_id: UUID, data: Decision, request: Request, actor=Depends(admin), db=Depends(get_db)
):
    app = registration.decide(db, application_id, actor, data, request.app.state.settings)
    db.commit()
    return result(request, registration.public_status(app))
