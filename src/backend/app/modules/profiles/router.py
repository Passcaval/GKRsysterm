from fastapi import APIRouter, Depends, Request
from sqlalchemy import select

from app.core.errors import result
from app.core.security import current_user
from app.db.models import ProfileVersion
from app.db.session import get_db
from app.modules.profiles.service import (
    ProfileInput,
    ProfilePatch,
    current_profile,
    profile_view,
    save_profile,
)

router = APIRouter(prefix="/api/v1", tags=["profiles"])


@router.get("/me/profile")
def read(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(request, profile_view(current_profile(db, user.id)))


@router.put("/me/profile")
def legacy_save(
    data: ProfileInput, request: Request, user=Depends(current_user), db=Depends(get_db)
):
    record = save_profile(db, user.id, data)
    db.commit()
    # Preserve the frontend's original Profile shape; version API is separate.
    return result(
        request, {k: v for k, v in record.data.items() if k not in {"rank_cohort", "batch"}}
    )


@router.patch("/me/profile")
def patch(data: ProfilePatch, request: Request, user=Depends(current_user), db=Depends(get_db)):
    record = save_profile(db, user.id, data.profile, data.expected_version)
    db.commit()
    return result(request, profile_view(record))


@router.get("/me/profile/versions")
def versions(request: Request, user=Depends(current_user), db=Depends(get_db)):
    return result(
        request,
        [
            profile_view(v)
            for v in db.scalars(
                select(ProfileVersion)
                .where(ProfileVersion.owner_id == user.id)
                .order_by(ProfileVersion.version.desc())
            )
        ],
    )
