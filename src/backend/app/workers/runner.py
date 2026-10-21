import argparse
import logging
import secrets
import time
from datetime import timedelta

from sqlalchemy import create_engine, or_, select
from sqlalchemy.orm import sessionmaker

from app.core.config import Settings
from app.core.errors import DomainError
from app.db.models import CrawlRun, ImportBatch, Job, RecommendationRun, now
from app.modules.admissions.crawl_service import (
    TERMINAL_STATUSES,
    maybe_enqueue_startup_crawl,
    refresh_crawl_status_for_batch,
    run_crawl_job,
)
from app.modules.admissions.service import process_import
from app.modules.catalog.service import analyze_job, fetch_job, startup_sync
from app.modules.recommendation.service import emit, evaluate_snapshot

logger = logging.getLogger("worker")


def _terminal_crawl_error(db, job: Job, code: str, message: str) -> None:
    run = db.get(CrawlRun, job.object_id)
    if run and run.status not in TERMINAL_STATUSES:
        run.status = "failed"
        run.errors = [
            *(run.errors or []),
            {"code": code, "message": message[:300]},
        ]
        run.finished_at = now()
        run.version += 1


def tick(sessions, settings: Settings | None = None, task_types: list[str] | None = None):
    # Lease is durable; expired claims can be recovered after a worker crash.
    token = secrets.token_hex(24)
    with sessions.begin() as db:
        query = select(Job).where(
            or_(Job.status == "queued", (Job.status == "running") & (Job.lease_until < now()))
        )
        if task_types:
            query = query.where(Job.task_type.in_(task_types))
        job = db.scalar(query.order_by(Job.created_at).with_for_update(skip_locked=True).limit(1))
        if not job:
            return False
        lease_minutes = 5 if job.task_type in {"crawl", "catalog_fetch", "catalog_analyze"} else 2
        job.status, job.lease_token, job.lease_until = (
            "running",
            token,
            now() + timedelta(minutes=lease_minutes),
        )
        job.attempts += 1
        job_id, task_type, object_id = job.id, job.task_type, job.object_id
    try:
        if task_type in {"catalog_fetch", "catalog_analyze"}:
            settings = settings or Settings()
            processor = fetch_job if task_type == "catalog_fetch" else analyze_job
            processor(sessions, settings, object_id, job_id, token)
            with sessions.begin() as db:
                job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
                if job and job.lease_token == token:
                    job.status, job.lease_token, job.lease_until = "succeeded", None, None
            return True
        if task_type == "crawl":
            if settings is None:
                settings = Settings()
            run_crawl_job(sessions, settings, object_id, job_id, token)
            with sessions.begin() as db:
                job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
                if job and job.lease_token == token:
                    job.status, job.lease_token, job.lease_until = "succeeded", None, None
            return True

        with sessions.begin() as db:
            job = db.scalar(select(Job).where(Job.id == job_id).with_for_update())
            if not job or job.lease_token != token or job.status != "running":
                return True
            if task_type == "import":
                batch = db.get(ImportBatch, object_id)
                if batch and batch.status != "published":
                    process_import(db, batch)
                    if batch.status == "published":
                        refresh_crawl_status_for_batch(db, batch)
            elif task_type == "recommendation":
                run = db.scalar(
                    select(RecommendationRun)
                    .where(RecommendationRun.id == object_id)
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
            if not job or job.lease_token != token:
                return True
            terminal = isinstance(exc, DomainError) or job.attempts >= 3
            job.status = "failed" if terminal else "queued"
            job.error = exc.code if isinstance(exc, DomainError) else "JOB_FAILED"
            job.lease_until = None
            if terminal and job.task_type == "import":
                batch = db.get(ImportBatch, job.object_id)
                if batch:
                    batch.status, batch.errors = "failed", [{"code": job.error}]
                    refresh_crawl_status_for_batch(db, batch)
            if terminal and job.task_type == "crawl":
                _terminal_crawl_error(
                    db,
                    job,
                    exc.code if isinstance(exc, DomainError) else "CRAWL_FAILED",
                    str(exc),
                )
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
    parser.add_argument(
        "--task-types",
        default="",
        help="Comma-separated types (import,recommendation,crawl,catalog_fetch,catalog_analyze).",
    )
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO)
    task_types = [item.strip() for item in args.task_types.split(",") if item.strip()]
    settings = Settings()
    logger.info(
        "worker started: task_types=%s once=%s database=%s; idle polling is silent",
        ",".join(task_types) or "all",
        args.once,
        settings.database_url.rsplit("@", 1)[-1],
    )
    engine = create_engine(settings.database_url, pool_pre_ping=True, hide_parameters=True)
    sessions = sessionmaker(engine, expire_on_commit=False)
    try:
        if not args.once and (not task_types or "catalog_fetch" in task_types):
            try:
                startup_sync(sessions, settings)
            except Exception:
                logger.exception("national school catalog startup enqueue failed")
        if not args.once and (not task_types or "crawl" in task_types):
            try:
                maybe_enqueue_startup_crawl(sessions, settings)
            except Exception:
                logger.exception("startup crawl enqueue failed")
        while True:
            worked = tick(sessions, settings, task_types or None)
            if args.once:
                break
            if not worked:
                time.sleep(1)
    finally:
        engine.dispose()


if __name__ == "__main__":
    main()
