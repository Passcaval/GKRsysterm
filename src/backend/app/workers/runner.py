import argparse
import secrets
import time
from datetime import timedelta

from sqlalchemy import create_engine, or_, select
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.core.errors import DomainError
from app.db.models import ImportBatch, Job, RecommendationRun, now
from app.modules.admissions.service import process_import
from app.modules.recommendation.service import emit, evaluate_snapshot


def tick(sessions):
    # Lease is durable; expired claims can be recovered after a worker crash.
    token = secrets.token_hex(24)
    with sessions.begin() as db:
        job = db.scalar(
            select(Job)
            .where(
                or_(Job.status == "queued", (Job.status == "running") & (Job.lease_until < now()))
            )
            .order_by(Job.created_at)
            .with_for_update(skip_locked=True)
            .limit(1)
        )
        if not job:
            return False
        job.status, job.lease_token, job.lease_until = (
            "running",
            token,
            now() + timedelta(minutes=2),
        )
        job.attempts += 1
        job_id = job.id
    try:
        with sessions.begin() as db:
            job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
            if job.lease_token != token or job.status != "running":
                return True
            if job.task_type == "import":
                batch = db.get(ImportBatch, job.object_id)
                if batch and batch.status != "published":
                    process_import(db, batch)
            elif job.task_type == "recommendation":
                run = db.scalar(
                    select(RecommendationRun)
                    .where(RecommendationRun.id == job.object_id)
                    .with_for_update()
                )
                if run and run.status not in {"succeeded", "failed", "cancelled"}:
                    if run.cancelled:
                        run.status = "cancelled"
                    else:
                        run.status = "running"
                        emit(db, run, "status", {"status": "running"})
                        result = evaluate_snapshot(run.snapshot)
                        emit(db, run, "status", {"status": "validating"})
                        run.result, run.status = result, "succeeded"
                        emit(db, run, "result", result)
                    emit(db, run, "done", {"status": run.status})
            else:
                raise DomainError(422, "UNKNOWN_JOB", "Unsupported job type")
            job.status, job.lease_token, job.lease_until = "succeeded", None, None
    except Exception as exc:
        with sessions.begin() as db:
            job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
            if job.lease_token != token:
                return True
            terminal = isinstance(exc, DomainError) or job.attempts >= 3
            job.status = "failed" if terminal else "queued"
            job.error = exc.code if isinstance(exc, DomainError) else "JOB_FAILED"
            job.lease_until = None
            if terminal and job.task_type == "import":
                batch = db.get(ImportBatch, job.object_id)
                batch.status, batch.errors = "failed", [{"code": job.error}]
            if terminal and job.task_type == "recommendation":
                run = db.scalar(
                    select(RecommendationRun)
                    .where(RecommendationRun.id == job.object_id)
                    .with_for_update()
                )
                if run and not run.cancelled:
                    run.status = "failed"
                    emit(
                        db,
                        run,
                        "error",
                        {"code": job.error, "message": "任务未完成，请检查输入及服务状态。"},
                    )
                    emit(db, run, "done", {"status": "failed"})
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    settings = Settings()
    engine = create_engine(settings.database_url, pool_pre_ping=True, hide_parameters=True)
    sessions = sessionmaker(engine, expire_on_commit=False)
    try:
        while True:
            worked = tick(sessions)
            if args.once:
                break
            if not worked:
                time.sleep(1)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
