"""User-requested email authority, unified login and permission acceptance tests."""

import pytest
from conftest import HEADERS, PASSWORD
from fastapi.testclient import TestClient


def credentials(identifier="admin@example.test"):
    return {"login_type": "email", "identifier": identifier, "password": PASSWORD}


@pytest.mark.parametrize(
    "email", ["bad@@example.test", "a..b@example.test", "a@localhost", " a@example.test"]
)
def test_backend_email_error_allows_corrected_login(modern, email):
    bad = modern.post("/api/v1/auth/login", json=credentials(email))
    assert bad.status_code == 422
    payload = bad.json()
    assert payload["error"]["code"] == "EMAIL_INVALID"
    assert "重新输入" in payload["error"]["message"]
    assert payload["request_id"] == bad.headers["x-request-id"]
    assert isinstance(payload["error"]["details"], dict)
    assert "nv_session" not in modern.cookies
    assert modern.post("/api/v1/auth/login", json=credentials()).status_code == 200


def test_login_rejects_client_role_and_student_cannot_review(modern, student):
    injected = modern.post(
        "/api/v1/auth/login", json={**credentials("student@example.test"), "role": "admin"}
    )
    assert injected.status_code == 422
    response = modern.post("/api/v1/auth/login", json=credentials("student@example.test"))
    assert response.status_code == 200
    user = response.json()["data"]
    assert "registration:review" not in user["permissions"]
    for path in ("/api/v1/admin/registration-applications", "/api/v1/admin/reviews"):
        assert modern.get(path).status_code == 403
    assert modern.post("/api/v1/auth/logout").status_code == 200
    response = modern.post(
        "/api/v1/auth/login",
        json={"login_type": "user_id", "identifier": user["user_id"], "password": PASSWORD},
    )
    assert response.status_code == 200
    assert response.json()["data"]["id"] == user["id"]


def test_logout_invalidates_copied_session_cookie(modern):
    response = modern.post("/api/v1/auth/login", json=credentials())
    assert response.status_code == 200
    cookie = response.headers["set-cookie"]
    assert "httponly" in cookie.lower() and "samesite=lax" in cookie.lower()
    token = modern.cookies.get("nv_session")
    with TestClient(modern.app, headers=HEADERS) as copied:
        copied.cookies.set("nv_session", token)
        assert copied.get("/api/v1/auth/me").status_code == 200
        assert modern.post("/api/v1/auth/logout").status_code == 200
        assert modern.get("/api/v1/auth/me").status_code == 401
        assert copied.get("/api/v1/auth/me").status_code == 401


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Origin": "https://untrusted.invalid", "X-Requested-With": "NightVoyage"},
        {"Origin": "http://testserver"},
    ],
)
def test_login_write_requires_allowed_origin_and_csrf_header(modern, headers):
    with TestClient(modern.app) as isolated:
        response = isolated.post("/api/v1/auth/login", json=credentials(), headers=headers)
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "CSRF_REJECTED"
        assert "nv_session" not in isolated.cookies
