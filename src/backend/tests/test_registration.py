import io
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID

import pytest
from conftest import HEADERS, PASSWORD, approve, login, submit
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.cli import cleanup
from app.core.errors import DomainError
from app.core.security import validate_email, validate_nickname
from app.db.models import Application, IdentityClaim, RegistrationEvidence, User, now


@pytest.mark.parametrize("value", ["小明", "Alice", "中Ab文", "一二三四五", "𠀀"])
def test_valid_nicknames(value):
    assert validate_nickname(value) == value


@pytest.mark.parametrize(
    "value", ["", "AliceA", "小明1", "a_b", "小 明", "Émile", "ＡBC", "😀", "小明\n"]
)
def test_invalid_nicknames(value):
    with pytest.raises(DomainError):
        validate_nickname(value)


@pytest.mark.parametrize(
    "value",
    [
        "missing-at.example.test",
        "a..b@example.test",
        ".a@example.test",
        "a.@example.test",
        "a@-example.test",
        "a@example_.test",
        "a@example.test\n",
        "a" * 65 + "@example.test",
    ],
)
def test_invalid_emails(value):
    with pytest.raises(DomainError):
        validate_email(value)


def test_pending_no_user_no_session_and_idempotency(client, admin_client, app):
    first = submit(client, key="same")
    assert first.status_code == 202, first.text
    data = first.json()["data"]
    assert "nv_session" not in first.cookies
    assert submit(client, key="same").json()["data"] == data
    assert submit(client, key="same", nickname="另名").status_code == 409
    assert login(client).status_code == 401
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert (
            db.scalar(
                select(func.count())
                .select_from(IdentityClaim)
                .where(IdentityClaim.state == "reserved")
            )
            == 3
        )
    assert (
        client.get(f"/api/v1/registration-applications/{data['application_id']}").status_code == 404
    )
    status = client.get(
        f"/api/v1/registration-applications/{data['application_id']}",
        headers={"X-Application-Token": data["status_token"]},
    )
    assert status.json()["data"]["status"] == "pending"
    assert (
        client.get(
            "/api/v1/auth/me", headers={"X-Application-Token": data["status_token"]}
        ).status_code
        == 401
    )
    detail = admin_client.get(f"/api/v1/admin/registration-applications/{data['application_id']}")
    assert detail.json()["data"]["evidence"][0]["text"] == "仅用于测试的原始审核说明"
    assert not any(x in detail.text for x in ("password", "hash", "status_token"))


def test_approve_preserves_id_and_no_privilege_escalation(client, admin_client, app):
    data = submit(client).json()["data"]
    assert approve(admin_client, data).status_code == 200
    assert approve(admin_client, data).status_code == 200
    assert approve(admin_client, data, "reject", "不能改判").status_code == 409
    assert login(client, data["reserved_user_id"]).status_code == 200
    me = client.get("/api/v1/auth/me").json()["data"]
    assert me["role"] == "student" and not me["verified"] and not me["email_verified"]
    assert client.get("/api/v1/admin/registration-applications").status_code == 403
    assert client.get("/api/v1/admin/reviews").status_code == 403
    assert client.post("/api/v1/auth/logout").status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 401
    assert login(client).status_code == 200
    with app.state.sessions() as db:
        record = db.get(Application, UUID(data["application_id"]))
        assert record.password_hash is None and record.email is None and record.nickname is None
        assert (
            db.scalar(
                select(func.count())
                .select_from(IdentityClaim)
                .where(IdentityClaim.application_id == record.id)
            )
            == 0
        )


def test_reject_releases_only_own_claims_and_pending_not_expired(client, admin_client, app):
    first = submit(client).json()["data"]
    assert submit(client, nickname="小明", email="other@example.test").status_code == 409
    with app.state.sessions.begin() as db:
        db.get(Application, UUID(first["application_id"])).created_at = now() - timedelta(days=100)
    with app.state.sessions() as db:
        cleanup(db, app.state.settings)
    assert submit(client).status_code == 409
    assert approve(admin_client, first, "reject", "测试驳回原因").status_code == 200
    second = submit(client).json()["data"]
    assert first["reserved_user_id"] != second["reserved_user_id"]
    assert approve(admin_client, first, "reject", "测试驳回原因").status_code == 200
    with app.state.sessions() as db:
        assert (
            db.scalar(
                select(func.count())
                .select_from(IdentityClaim)
                .where(IdentityClaim.application_id == UUID(second["application_id"]))
            )
            == 3
        )


def test_casefold_unique_under_concurrent_submissions(app):
    def attempt(n):
        with TestClient(app, headers=HEADERS) as client:
            return submit(
                client, nickname="Alice" if n == 0 else "alice", email=f"student{n}@example.test"
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, [0, 1])) == [202, 409]


def test_concurrent_approval_opposite_decisions(client, admin_client, app):
    data = submit(client).json()["data"]
    cookies = dict(admin_client.cookies)

    def attempt(choice):
        with TestClient(app, headers=HEADERS, cookies=cookies) as other:
            return approve(other, data, choice, "测试审核理由").status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, ["approve", "reject"])) == [200, 409]
    with app.state.sessions() as db:
        application = db.get(Application, UUID(data["application_id"]))
        users = db.scalar(
            select(func.count())
            .select_from(User)
            .where(User.user_id == application.reserved_user_id)
        )
        assert users == (1 if application.status == "approved" else 0)


def test_reject_injected_fields_and_backend_email_errors(client):
    assert submit(client, role="admin").status_code == 422
    for identifier, kind in [("bad@@example.test", "email"), ("no-at.example.test", "user_id")]:
        response = client.post(
            "/api/v1/auth/login",
            json={"login_type": kind, "identifier": identifier, "password": PASSWORD},
        )
        assert response.status_code == 422
        assert "请重新输入" in response.json()["error"]["message"]
        assert response.json()["requestId"]
    assert (
        client.post(
            "/api/v1/auth/login",
            json={
                "login_type": "email",
                "identifier": "admin@example.test",
                "password": PASSWORD,
                "role": "admin",
            },
        ).status_code
        == 422
    )
    assert client.post("/api/v1/auth/forgot-password", json={}).status_code == 404


def test_audio_evidence_is_private_and_verified(client, admin_client, app):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(8000)
        output.writeframes(b"\x00\x00" * 8000)
    response = client.post(
        "/api/v1/registration-applications",
        data={"nickname": "音频", "email": "audio@example.test", "password": PASSWORD},
        files={"evidence_audio": ("test.wav", buffer.getvalue(), "audio/wav")},
        headers={"Idempotency-Key": "audio"},
    )
    assert response.status_code == 202, response.text
    data = response.json()["data"]
    detail = admin_client.get(
        f"/api/v1/admin/registration-applications/{data['application_id']}"
    ).json()["data"]
    url = detail["evidence"][0]["audio_url"]
    assert client.get(url).status_code == 401
    assert admin_client.get(url).content == buffer.getvalue()
    bad = client.post(
        "/api/v1/registration-applications",
        data={"nickname": "伪装", "email": "bad@example.test", "password": PASSWORD},
        files={"evidence_audio": ("test.wav", b"not audio", "audio/wav")},
        headers={"Idempotency-Key": "bad-audio"},
    )
    assert bad.status_code == 415
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(RegistrationEvidence)) == 1


def test_csrf_and_rate_limit(client, app):
    assert (
        client.post(
            "/api/v1/auth/login", json={}, headers={"Origin": "https://evil.example"}
        ).status_code
        == 403
    )
    app.state.settings.auth_rate_limit = 1
    assert login(client).status_code == 401
    assert login(client).status_code == 429


def test_approval_transaction_rolls_back_on_midway_failure(client, admin_client, app):
    from sqlalchemy import event

    data = submit(client).json()["data"]

    def fail_claim_transfer(connection, cursor, statement, parameters, context, many):
        if statement.startswith("UPDATE identity_claims"):
            raise RuntimeError("synthetic transaction failure")

    event.listen(app.state.engine, "before_cursor_execute", fail_claim_transfer)
    try:
        with TestClient(
            app, headers=HEADERS, cookies=dict(admin_client.cookies), raise_server_exceptions=False
        ) as admin:
            response = approve(admin, data)
            assert response.status_code == 500
            assert "password" not in response.text and "synthetic" not in response.text
    finally:
        event.remove(app.state.engine, "before_cursor_execute", fail_claim_transfer)
    with app.state.sessions() as db:
        application = db.get(Application, UUID(data["application_id"]))
        assert application.status == "pending" and application.password_hash
        assert db.scalar(select(func.count()).select_from(User)) == 1
        assert (
            db.scalar(
                select(func.count())
                .select_from(IdentityClaim)
                .where(IdentityClaim.state == "reserved")
            )
            == 3
        )
    assert approve(admin_client, data).status_code == 200


def test_missing_evidence_cannot_be_approved_and_terminal_retention(client, admin_client, app):
    data = submit(client).json()["data"]
    with app.state.sessions.begin() as db:
        evidence = db.scalar(select(RegistrationEvidence))
        evidence.text_content = None
    assert approve(admin_client, data).status_code == 422
    assert approve(admin_client, data, "reject", "证据丢失").status_code == 200
    with app.state.sessions.begin() as db:
        db.get(Application, UUID(data["application_id"])).reviewed_at = now() - timedelta(days=31)
    with app.state.sessions() as db:
        assert cleanup(db, app.state.settings) == 1
        assert db.get(Application, UUID(data["application_id"])).status == "rejected"


def test_concurrent_case_insensitive_email_and_reviewer_is_not_admin(app, client, admin_client):
    def attempt(n):
        with TestClient(app, headers=HEADERS) as requester:
            return submit(
                requester,
                nickname="小甲" if n == 0 else "小乙",
                email="Same@example.test" if n == 0 else "same@example.test",
            )

    with ThreadPoolExecutor(max_workers=2) as pool:
        responses = list(pool.map(attempt, [0, 1]))
    assert sorted(r.status_code for r in responses) == [202, 409]
    data = next(r.json()["data"] for r in responses if r.status_code == 202)
    assert approve(admin_client, data).status_code == 200
    with app.state.sessions.begin() as db:
        user = db.scalar(select(User).where(User.user_id == data["reserved_user_id"]))
        user.role = "reviewer"
    assert login(client, data["reserved_user_id"]).status_code == 200
    assert client.get("/api/v1/admin/reviews").status_code == 200
    assert client.get("/api/v1/admin/registration-applications").status_code == 403
    assert client.get("/api/v1/auth/me").json()["data"]["verified"] is False
