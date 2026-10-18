from datetime import timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, Request
from sqlalchemy import delete, func, or_, select

from app.core.errors import DomainError, missing, result
from app.core.security import current_user, optional_user, reviewer, throttle
from app.core.storage import blob_path, read_upload, save_blob, validate_document
from app.db.models import (
    Conversation,
    Favorite,
    Feedback,
    Idempotency,
    Job,
    Plan,
    Post,
    PostFeedback,
    PostRevision,
    ProfileVersion,
    RecommendationRun,
    RunEvent,
    School,
    Source,
    User,
    Verification,
    now,
)
from app.db.session import get_db
from app.modules.admissions.service import school_views
from app.modules.community.router import user_view, verified
from app.modules.community.schemas import ContentDecision, PostFeedbackInput, PostInput
from app.modules.profiles.service import current_profile

router = APIRouter(prefix="/api/v1", tags=["frontend compatibility"])


def plan_record(db, user):
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    plan = db.get(Plan, user.id)
    if not plan:
        plan = Plan(owner_id=user.id)
        db.add(plan)
        db.flush()
    return plan


def plan_view(plan):
    return (
        {"id": str(plan.id), "name": plan.name, "version": plan.version, "entries": plan.entries}
        if plan
        else {"id": "", "name": "我的志愿草案", "version": 1, "entries": []}
    )


def post_view(db, post, user=None):
    author = db.get(User, post.owner_id) if post.owner_id else None
    return {
        "id": str(post.id),
        "schoolId": str(post.school_id),
        "isMine": bool(user and post.owner_id == user.id),
        "title": post.data["title"],
        "excerpt": post.data["body"][:150],
        "body": post.data["body"],
        "topic": post.data["topic"],
        "author": author.nickname if author else "已匿名化用户",
        "year": post.created_at.year,
        "signal": "weak",
        "status": post.status,
        "helpful": db.scalar(
            select(func.count())
            .select_from(PostFeedback)
            .where(PostFeedback.post_id == post.id, PostFeedback.kind == "helpful")
        ),
        "citations": 0,
        "sourceIds": [],
        "trust": {
            "identity": None,
            "specificity": None,
            "corroboration": None,
            "freshness": None,
            "anomaly": None,
            "supporting": 0,
            "opposing": 0,
            "explanation": [
                "学校身份不等于内容真实",
                "内容尚未逐条提取核查",
                "尚无独立佐证",
                "适用时间待核对",
                "尚未进行异常评估；尚未评分，未知值不代表真实性结论",
            ],
            "expiresAt": (post.created_at + timedelta(days=30)).date().isoformat(),
            "version": "unassessed-m1",
        },
    }


def verification_view(v):
    return {
        "id": str(v.id),
        "schoolId": str(v.school_id),
        "status": v.status,
        "submittedAt": v.created_at.isoformat(),
    }


@router.get("/bootstrap")
def bootstrap(request: Request, user=Depends(optional_user), db=Depends(get_db)):
    profile = current_profile(db, user.id) if user else None
    plan = plan_record(db, user) if user else None
    posts = db.scalars(
        select(Post)
        .where(or_(Post.status == "published", Post.owner_id == user.id if user else False))
        .order_by(Post.created_at)
    )
    schools = school_views(db)
    source_ids = {source for school in schools for source in school["sourceIds"]}
    sources = [
        {
            "id": str(s.id),
            **{k: s.data[k] for k in ("kind", "title", "url", "year", "retrievedAt", "excerpt")},
        }
        for s in db.scalars(select(Source))
        if str(s.id) in source_ids
    ]
    view = {
        "user": user_view(db, user) if user else None,
        "profile": {k: v for k, v in profile.data.items() if k not in {"rank_cohort", "batch"}}
        if profile
        else None,
        "schools": schools,
        "posts": [post_view(db, p, user) for p in posts],
        "sources": sources,
        "plan": plan_view(plan),
        "favorites": [
            str(x)
            for x in db.scalars(select(Favorite.school_id).where(Favorite.owner_id == user.id))
        ]
        if user
        else [],
        "verifications": [
            verification_view(v)
            for v in db.scalars(select(Verification).where(Verification.owner_id == user.id))
        ]
        if user
        else [],
    }
    db.commit()
    return result(request, view)


@router.put("/me/favorites/{school_id}")
def add_favorite(school_id: UUID, request: Request, user=Depends(current_user), db=Depends(get_db)):
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    if not db.get(School, school_id):
        missing()
    if not db.get(Favorite, (user.id, school_id)):
        db.add(Favorite(owner_id=user.id, school_id=school_id))
    db.commit()
    return result(
        request,
        [
            str(x)
            for x in db.scalars(select(Favorite.school_id).where(Favorite.owner_id == user.id))
        ],
    )


@router.delete("/me/favorites/{school_id}")
def remove_favorite(
    school_id: UUID, request: Request, user=Depends(current_user), db=Depends(get_db)
):
    db.execute(
        delete(Favorite).where(Favorite.owner_id == user.id, Favorite.school_id == school_id)
    )
    db.commit()
    return result(
        request,
        [
            str(x)
            for x in db.scalars(select(Favorite.school_id).where(Favorite.owner_id == user.id))
        ],
    )


@router.post("/posts")
def create_post(data: PostInput, request: Request, user=Depends(current_user), db=Depends(get_db)):
    throttle(request, "post")
    school_id = data.schoolId
    if not db.get(School, school_id):
        missing()
    post = Post(owner_id=user.id, school_id=school_id, data=data.model_dump(mode="json"))
    db.add(post)
    db.flush()
    db.add(PostRevision(post_id=post.id, version=1, data=post.data))
    db.commit()
    return result(request, post_view(db, post, user))


@router.get("/admin/reviews")
def reviews(request: Request, actor=Depends(reviewer), db=Depends(get_db)):
    return result(
        request,
        [post_view(db, p, actor) for p in db.scalars(select(Post).where(Post.status == "pending"))],
    )


@router.post("/admin/reviews/{post_id}")
def review(
    post_id: UUID,
    data: ContentDecision,
    request: Request,
    actor=Depends(reviewer),
    db=Depends(get_db),
):
    post = db.scalar(select(Post).where(Post.id == post_id).with_for_update())
    if not post:
        missing()
    if post.status != "pending":
        raise DomainError(409, "REVIEW_ALREADY_DECIDED", "该帖子已处理。")
    post.status = "published" if data.decision == "approve" else "rejected"
    post.data = {
        **post.data,
        "review": {
            "actor_id": str(actor.id),
            "reason": data.reason,
            "decision": data.decision,
            "time": now().isoformat(),
        },
    }
    db.commit()
    return result(request, post_view(db, post, actor))


@router.post("/posts/{post_id}/feedback")
def feedback(
    post_id: UUID,
    data: PostFeedbackInput,
    request: Request,
    user=Depends(current_user),
    db=Depends(get_db),
):
    post = db.get(Post, post_id)
    if not post or (post.status != "published" and post.owner_id != user.id):
        missing()
    if data.kind != "appeal" and not verified(db, user):
        raise DomainError(
            403, "VERIFIED_USER_REQUIRED", "社区投票仅限认证用户；你可以提交评分申诉。"
        )
    if data.kind == "appeal" and len(data.reason.strip()) < 10:
        raise DomainError(422, "INVALID_INPUT", "请至少填写 10 字复核理由。")
    db.add(PostFeedback(owner_id=user.id, post_id=post.id, kind=data.kind, reason=data.reason))
    db.commit()
    return result(request, {"accepted": True})


@router.post("/verifications")
async def verification(request: Request, user=Depends(current_user), db=Depends(get_db)):
    settings = request.app.state.settings
    async with request.form(max_files=1, max_fields=1) as form:
        if set(form) != {"schoolId", "document"}:
            raise DomainError(422, "INVALID_INPUT", "认证请求字段不正确。")
        try:
            school_id = UUID(form["schoolId"])
        except (ValueError, TypeError):
            raise DomainError(422, "INVALID_INPUT", "院校编号不正确。") from None
        if not db.get(School, school_id):
            missing()
        content = await read_upload(form["document"], settings)
        mime = validate_document(content)
    storage_key = save_blob(settings, content)
    try:
        record = Verification(
            owner_id=user.id, school_id=school_id, storage_key=storage_key, mime=mime
        )
        db.add(record)
        db.commit()
    except Exception:
        db.rollback()
        blob_path(settings, storage_key).unlink(missing_ok=True)
        raise
    return result(request, verification_view(record))


@router.delete("/me/data")
def delete_data(request: Request, user=Depends(current_user), db=Depends(get_db)):
    db.scalar(select(User).where(User.id == user.id).with_for_update())
    run_ids = list(
        db.scalars(select(RecommendationRun.id).where(RecommendationRun.owner_id == user.id))
    )
    db.execute(delete(Job).where(Job.task_type == "recommendation", Job.object_id.in_(run_ids)))
    feedback_ids = list(db.scalars(select(Feedback.id).where(Feedback.owner_id == user.id)))
    db.execute(delete(Idempotency).where(Idempotency.resource_id.in_(feedback_ids)))
    db.execute(delete(Feedback).where(Feedback.owner_id == user.id))
    db.execute(delete(RunEvent).where(RunEvent.run_id.in_(run_ids)))
    db.execute(delete(Idempotency).where(Idempotency.resource_id.in_(run_ids)))
    db.execute(delete(RecommendationRun).where(RecommendationRun.owner_id == user.id))
    db.execute(delete(ProfileVersion).where(ProfileVersion.owner_id == user.id))
    db.execute(delete(Favorite).where(Favorite.owner_id == user.id))
    db.execute(delete(Conversation).where(Conversation.owner_id == user.id))
    db.execute(delete(PostFeedback).where(PostFeedback.owner_id == user.id))
    keys = list(
        db.scalars(select(Verification.storage_key).where(Verification.owner_id == user.id))
    )
    db.execute(delete(Verification).where(Verification.owner_id == user.id))
    for post in db.scalars(select(Post).where(Post.owner_id == user.id)):
        if post.status == "published":
            post.owner_id = None
        else:
            db.execute(delete(PostFeedback).where(PostFeedback.post_id == post.id))
            db.execute(delete(PostRevision).where(PostRevision.post_id == post.id))
            db.delete(post)
    plan = plan_record(db, user)
    plan.entries, plan.version = [], plan.version + 1
    db.commit()
    for key in keys:
        blob_path(request.app.state.settings, key).unlink(missing_ok=True)
    return result(request, None)
