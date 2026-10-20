import csv
import io
import json
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request
from fastapi.exceptions import RequestValidationError
from pydantic import ValidationError
from sqlalchemy import select

from app.core.errors import DomainError, missing, result
from app.core.security import admin
from app.core.storage import read_upload
from app.db.models import AdmissionUnit, ImportBatch, School, Source
from app.db.session import get_db
from app.modules.admissions.service import ImportInput, enqueue_import, unit_view

router = APIRouter(prefix="/api/v1", tags=["admissions"])


@router.get("/sources/{source_id}")
def source(source_id: UUID, request: Request, db=Depends(get_db)):
    item = db.get(Source, source_id)
    if not item:
        missing()
    return result(request, {"id": str(item.id), "content_hash": item.content_hash, **item.data})


@router.get("/admin/imports/{import_id}/snapshot")
def import_snapshot(import_id: UUID, request: Request, actor=Depends(admin), db=Depends(get_db)):
    batch = db.get(ImportBatch, import_id)
    if not batch:
        missing()
    return result(
        request,
        {
            "import_id": str(batch.id),
            "content_hash": batch.fingerprint,
            "normalized_snapshot": batch.payload,
        },
    )


@router.post("/admin/imports", status_code=202)
def import_json(data: ImportInput, request: Request, actor=Depends(admin), db=Depends(get_db)):
    batch = enqueue_import(
        db,
        request.app.state.settings,
        actor,
        data,
        getattr(request.app.state, "admission_config", None),
    )
    db.commit()
    return result(request, {"import_id": str(batch.id), "status": batch.status})


@router.post("/admin/imports/csv", status_code=202)
async def import_csv(request: Request, actor=Depends(admin), db=Depends(get_db)):
    async with request.form(max_files=1, max_fields=1) as form:
        if set(form) != {"metadata", "file"}:
            raise DomainError(422, "INVALID_INPUT", "CSV 导入需包含 metadata JSON 和 file。")
        try:
            content = await read_upload(form["file"], request.app.state.settings)
            metadata = json.loads(form["metadata"])
            rows = []
            for number, raw in enumerate(
                csv.DictReader(io.StringIO(content.decode("utf-8-sig"))), start=2
            ):
                if len(rows) >= 1000:
                    raise ValueError("Too many rows")
                row = dict(raw)
                for key in ("required_subjects", "additional_requirements", "history"):
                    row[key] = json.loads(
                        row.get(key) or ("null" if key == "required_subjects" else "[]")
                    )
                for key in ("tuition", "plan_count"):
                    row[key] = json.loads(row.get(key) or "null")
                row["exam_year"] = int(row["exam_year"])
                row["campus"] = row.get("campus") or None
                rows.append(row)
            data = ImportInput.model_validate({**metadata, "rows": rows})
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            if isinstance(exc, ValidationError):
                raise RequestValidationError(exc.errors()) from None
            raise DomainError(
                422, "IMPORT_INVALID", "CSV 内容或 JSON 列格式错误，请检查行与字段。"
            ) from None
    batch = enqueue_import(
        db,
        request.app.state.settings,
        actor,
        data,
        getattr(request.app.state, "admission_config", None),
    )
    db.commit()
    return result(request, {"import_id": str(batch.id), "status": batch.status})


@router.get("/admin/imports/{import_id}")
def import_status(import_id: UUID, request: Request, actor=Depends(admin), db=Depends(get_db)):
    batch = db.get(ImportBatch, import_id)
    if not batch:
        missing()
    return result(
        request, {"import_id": str(batch.id), "status": batch.status, "errors": batch.errors}
    )


@router.get("/schools")
def schools(
    request: Request,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=30, ge=1, le=100),
    db=Depends(get_db),
):
    return result(
        request,
        {
            "items": [
                {"id": str(s.id), "code": s.code, **s.data}
                for s in db.scalars(
                    select(School).order_by(School.code).offset(offset).limit(limit)
                )
            ],
            "offset": offset,
            "limit": limit,
        },
    )


@router.get("/schools/{school_id}")
def school(school_id: UUID, request: Request, db=Depends(get_db)):
    item = db.get(School, school_id)
    if not item:
        missing()
    return result(request, {"id": str(item.id), "code": item.code, **item.data})


@router.get("/admission-units")
def units(
    request: Request,
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=30, ge=1, le=100),
    db=Depends(get_db),
):
    return result(
        request,
        {
            "items": [
                unit_view(u)
                for u in db.scalars(
                    select(AdmissionUnit)
                    .where(AdmissionUnit.active.is_(True))
                    .order_by(AdmissionUnit.id)
                    .offset(offset)
                    .limit(limit)
                )
            ],
            "offset": offset,
            "limit": limit,
        },
    )


@router.get("/admission-units/{unit_id}/history")
def unit_history(unit_id: UUID, request: Request, db=Depends(get_db)):
    item = db.get(AdmissionUnit, unit_id)
    if not item:
        missing()
    return result(
        request,
        {
            "admission_unit_id": str(item.id),
            "source_id": str(item.source_id),
            "history": item.data["history"],
        },
    )
