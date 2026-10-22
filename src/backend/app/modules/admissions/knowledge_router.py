from fastapi import APIRouter, Depends, Header, Request

from app.core.errors import DomainError, result
from app.core.security import admin, fingerprint, idempotency, throttle
from app.db.models import Idempotency, Job
from app.db.session import get_db
from app.modules.admissions.knowledge import enqueue_sync, summary
from app.modules.community.schemas import StrictModel

router = APIRouter(prefix="/api/v1/admin/admission-knowledge", tags=["admissions knowledge"])


class SyncInput(StrictModel):
    pass


@router.get("")
def status(request: Request, actor=Depends(admin), db=Depends(get_db)):
    return result(request, summary(db, request.app.state.settings))


@router.post("/sync", status_code=202)
def sync(
    data: SyncInput,
    request: Request,
    idempotency_key: str | None = Header(default=None),
    actor=Depends(admin),
    db=Depends(get_db),
):
    settings = request.app.state.settings
    if not settings.knowledge_configured:
        raise DomainError(503, "SEARCH_NOT_CONFIGURED", "请配置 DeepSeek 模型并启用联网知识库。")
    throttle(request, "crawl")
    signature = fingerprint(settings.app_secret, data.model_dump())
    key, previous = idempotency(db, "knowledge:" + str(actor.id), idempotency_key, signature)
    job = db.get(Job, previous.resource_id) if previous else enqueue_sync(db, settings, force=True)
    if not previous:
        db.add(Idempotency(key=key, fingerprint=signature, resource_id=job.id))
    db.commit()
    return result(request, {"id": str(job.id), "status": job.status})
