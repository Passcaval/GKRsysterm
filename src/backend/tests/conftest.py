import os
from uuid import uuid4

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url

from app.cli import create_admin
from app.core.config import Settings
from app.db.models import Base
from app.main import create_app

PASSWORD = "Test-only Strong Pass!"
HEADERS = {"Origin": "http://testserver", "X-Requested-With": "NightVoyage"}


@pytest.fixture(scope="session")
def database_url():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        local = Settings()
        url = (
            make_url(local.database_url)
            .set(database="night_voyage_test")
            .render_as_string(hide_password=False)
        )
    parsed = make_url(url)
    if not parsed.drivername.startswith("postgresql") or not parsed.database.endswith("_test"):
        raise RuntimeError("Refusing tests: use a separate PostgreSQL database ending in _test")
    previous = os.environ.get("DATABASE_URL")
    os.environ["DATABASE_URL"] = url
    os.environ.setdefault("APP_SECRET", "test-only-secret-" + "x" * 48)
    command.upgrade(Config("alembic.ini"), "head")
    yield url
    if previous is None:
        os.environ.pop("DATABASE_URL", None)
    else:
        os.environ["DATABASE_URL"] = previous


@pytest.fixture
def app(database_url, tmp_path):
    engine = create_engine(database_url)
    # Explicitly guarded test DB, only this backend's known tables.
    with engine.begin() as db:
        tables = ", ".join('"' + t.name + '"' for t in Base.metadata.sorted_tables)
        db.execute(text("TRUNCATE " + tables + " CASCADE"))
    engine.dispose()
    settings = Settings(
        database_url=database_url,
        app_secret="test-only-secret-" + "x" * 48,
        allowed_origins=["http://testserver"],
        cookie_secure=False,
        storage_dir=tmp_path / "private",
        auth_rate_limit=10000,
        registration_rate_limit=10000,
    )
    application = create_app(settings, contract_version="0.1")
    with application.state.sessions.begin() as db:
        create_admin(db, "管理员", "admin@example.test", PASSWORD)
    yield application
    application.state.engine.dispose()


@pytest.fixture
def client(app):
    with TestClient(app, headers=HEADERS) as client:
        yield client


@pytest.fixture
def admin_client(app):
    with TestClient(app, headers=HEADERS) as client:
        response = client.post(
            "/api/v1/auth/login",
            json={"login_type": "email", "identifier": "admin@example.test", "password": PASSWORD},
        )
        assert response.status_code == 200, response.text
        yield client


def submit(client, nickname="小明", email="student@example.test", key=None, **extra):
    return client.post(
        "/api/v1/registration-applications",
        data={
            "nickname": nickname,
            "email": email,
            "password": PASSWORD,
            "evidence_text": "仅用于测试的原始审核说明",
            **extra,
        },
        headers={"Idempotency-Key": key or str(uuid4())},
    )


def approve(admin_client, application, decision="approve", reason=""):
    return admin_client.post(
        f"/api/v1/admin/registration-applications/{application['application_id']}/decision",
        json={"decision": decision, "expected_version": 1, "reason": reason},
    )


def login(client, identifier="student@example.test"):
    return client.post(
        "/api/v1/auth/login",
        json={
            "login_type": "email" if "@" in identifier else "user_id",
            "identifier": identifier,
            "password": PASSWORD,
        },
    )


@pytest.fixture
def student(client, admin_client):
    response = submit(client)
    assert response.status_code == 202, response.text
    application = response.json()["data"]
    assert approve(admin_client, application).status_code == 200
    assert login(client).status_code == 200
    return client


@pytest.fixture
def profile():
    return {
        "province": "浙江",
        "year": 2026,
        "score": 600,
        "rank": 20000,
        "subjects": ["物理", "化学", "生物"],
        "cities": ["测试市"],
        "interests": ["计算机"],
        "budget": 10000,
        "acceptAdjustment": True,
        "consent": True,
        "rank_cohort": "浙江普通类",
        "batch": "普通类一段",
    }


@pytest.fixture
def import_payload():
    return {
        "source_url": "https://www.zjzs.net/test-fixture",
        "source_title": "合成测试资料（非真实招生数据）",
        "published_at": "2026-01-01T00:00:00Z",
        "locator": "合成测试第1行",
        "reviewed": True,
        "rows": [
            {
                "school_code": "TEST001",
                "school_name": "合成测试大学",
                "short_name": "测试",
                "city": "测试市",
                "school_province": "浙江",
                "unit_code": "TESTCS",
                "unit_type": "major",
                "province_code": "浙江",
                "exam_year": 2026,
                "exam_category": "普通类",
                "batch": "普通类一段",
                "rank_cohort": "浙江普通类",
                "campus": "合成校区",
                "major": "计算机科学",
                "required_subjects": ["物理", "化学"],
                "tuition": 5000,
                "plan_count": 10,
                "additional_requirements": [],
                "history": [
                    {
                        "year": 2025,
                        "rank": 25000,
                        "score": 590,
                        "rank_cohort": "浙江普通类",
                        "comparable": True,
                    }
                ],
                "description": "仅用于集成测试，不代表真实学校",
            }
        ],
    }


@pytest.fixture
def published(app, admin_client, import_payload):
    from app.workers.runner import tick

    response = admin_client.post("/api/v1/admin/imports", json=import_payload)
    assert response.status_code == 202, response.text
    tick(app.state.sessions)
    status = admin_client.get(
        "/api/v1/admin/imports/" + response.json()["data"]["import_id"]
    ).json()["data"]
    assert status["status"] == "published", status
    return admin_client.get("/api/v1/admission-units").json()["data"]["items"][0]
