import logging
from contextlib import asynccontextmanager
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.exceptions import HTTPException

from app.core.config import Settings
from app.core.contract import install_contract
from app.core.errors import error_response, install_handlers, result
from app.db.session import configure_db
from app.modules.admissions.atlas import router as atlas
from app.modules.admissions.config import load_admission_config
from app.modules.admissions.crawl_router import router as admissions_crawl
from app.modules.admissions.knowledge_router import router as admission_knowledge
from app.modules.admissions.router import router as admissions
from app.modules.agent.router import router as agent
from app.modules.agent.signals_router import router as chat_profile_signals
from app.modules.catalog.router import router as school_catalog
from app.modules.community.content import router as content
from app.modules.community.router import router as accounts
from app.modules.history.router import router as history
from app.modules.profiles.router import router as profiles
from app.modules.profiles.suggestions import router as profile_suggestions
from app.modules.recommendation.router import router as recommendations

logger = logging.getLogger("app.http")


class BodyLimit:
    """Bound streamed bodies too, before multipart parsing or disk spooling."""

    def __init__(self, app, limit=11 * 1024 * 1024):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] in {"GET", "HEAD", "OPTIONS"}:
            return await self.app(scope, receive, send)
        chunks, size = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            size += len(message.get("body", b""))
            if size > self.limit:
                response = JSONResponse(
                    status_code=413,
                    content={
                        "error": {
                            "code": "FILE_TOO_LARGE",
                            "message": "请求体过大，请缩小附件。",
                            "details": {},
                        },
                        "request_id": str(uuid4()),
                    },
                )
                return await response(scope, receive, send)
            chunks.append(message.get("body", b""))
            if not message.get("more_body", False):
                break
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": b"".join(chunks), "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


def create_app(settings: Settings | None = None, *, contract_version="0.4"):
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app):
        yield
        app.state.engine.dispose()

    app = FastAPI(title="Night Voyage M0–M1", version="0.1.0", lifespan=lifespan)
    app.include_router(admission_knowledge)
    app.include_router(atlas)
    app.state.settings = settings
    app.state.contract_version = contract_version
    app.state.admission_config, app.state.admission_config_error = load_admission_config(settings)
    configure_db(app, settings)
    app.add_middleware(BodyLimit)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=[
            "Content-Type",
            "X-Requested-With",
            "Idempotency-Key",
            "X-Application-Token",
            "Last-Event-ID",
        ],
    )

    @app.middleware("http")
    async def security(request: Request, call_next):
        request.state.request_id = str(uuid4())
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            if (
                request.headers.get("x-requested-with") != "NightVoyage"
                or request.headers.get("origin") not in settings.allowed_origins
            ):
                return error_response(request, 403, "CSRF_REJECTED", "请求来源验证失败。")
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    install_handlers(app)

    @app.exception_handler(HTTPException)
    async def http_error(request, exc):
        logger.warning(
            "HTTP %s on %s %s: %s",
            exc.status_code,
            request.method,
            request.url.path,
            exc.detail,
        )
        return error_response(
            request, exc.status_code, "HTTP_ERROR", "请求无法处理，请检查路径与输入。"
        )

    @app.get("/health")
    def health(request: Request):
        try:
            with app.state.engine.connect() as connection:
                connection.execute(text("SELECT version_num FROM alembic_version"))
        except Exception:
            return error_response(
                request, 503, "DATABASE_UNAVAILABLE", "数据库未就绪或尚未执行迁移。"
            )
        return result(request, {"status": "ok", "database": "postgresql", "stage": "M0-M1"})

    if contract_version == "0.1":
        # Isolated regression harness for core service invariants; never the default deployment.
        for router in (accounts, profiles, admissions, content, recommendations, history, agent):
            app.include_router(router)
    else:
        from app.modules.protocol.router import router as protocol

        app.include_router(protocol)
        # Import endpoints are backend-only and unchanged by the frontend migration.
        for route in admissions.routes:
            if route.path.startswith("/api/v1/admin/imports"):
                app.router.routes.append(route)
        for route in history.routes:
            if route.path == "/api/v1/admin/feedback":
                app.router.routes.append(route)
        app.include_router(admissions_crawl)
        app.include_router(profile_suggestions)
        app.include_router(chat_profile_signals)
        app.include_router(school_catalog)
        install_contract(app)
    return app
