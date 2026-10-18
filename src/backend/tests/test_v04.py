import json
from pathlib import Path
from uuid import UUID

import pytest
from conftest import HEADERS, PASSWORD
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from app.db.models import Post
from app.main import create_app
from app.workers.runner import tick

CONTRACT = json.loads(
    (Path(__file__).resolve().parents[3] / "docs/contracts/openapi.json").read_text(
        encoding="utf-8"
    )
)


def validate(name, value):
    Draft202012Validator(
        {"$ref": "#/components/schemas/" + name, "components": CONTRACT["components"]}
    ).validate(value)


@pytest.fixture
def modern(app):
    application = create_app(app.state.settings)
    with TestClient(application, headers=HEADERS) as client:
        yield client


def sign_in(client, email="admin@example.test"):
    r = client.post(
        "/api/v1/auth/login",
        json={"login_type": "email", "identifier": email, "password": PASSWORD},
    )
    assert r.status_code == 200, r.text
    validate("User", r.json()["data"])
    return r.json()["data"]


def create_profile(client):
    data = {
        "expected_version": 0,
        "province_code": "浙江",
        "exam_year": 2026,
        "exam_category": "普通类",
        "score": None,
        "rank": None,
        "rank_cohort": None,
        "subjects": ["物理", "化学", "生物"],
        "budget": {"amount": 10000, "currency": "CNY", "period": "year", "scope": "tuition"},
        "preferred_regions": ["测试市"],
        "preferred_majors": ["计算机"],
        "accept_adjustment": True,
        "consent": True,
        "preferences": [],
    }
    r = client.patch("/api/v1/me/profile", json=data)
    assert r.status_code == 200, r.text
    validate("Profile", r.json()["data"])
    return r.json()["data"]


def create_run(client, profile, key="v4-run"):
    r = client.post(
        "/api/v1/recommendations",
        json={
            "question": "合成测试请求",
            "profile_version_id": profile["profile_version_id"],
            "risk_preference": 50,
            "intent": "risk",
        },
        headers={"Idempotency-Key": key},
    )
    assert r.status_code == 202, r.text
    validate("Run", r.json()["data"])
    return r.json()["data"]


def test_v04_registration_status_approval_and_email_authority(modern):
    r = modern.post(
        "/api/v1/auth/login",
        json={"login_type": "email", "identifier": "bad@@example.test", "password": PASSWORD},
    )
    assert r.status_code == 422
    validate("Error", r.json())
    assert "请重新输入" in r.json()["error"]["message"]
    r = modern.post(
        "/api/v1/registration-applications",
        data={
            "nickname": "新生",
            "email": "new@example.test",
            "password": PASSWORD,
            "evidence_text": "v0.4合成测试说明",
        },
        headers={"Idempotency-Key": "v4-registration"},
    )
    assert r.status_code == 202, r.text
    receipt = r.json()["data"]
    validate("RegistrationReceipt", receipt)
    path = "/api/v1/registration-applications/" + receipt["application_id"]
    state = modern.get(path, headers={"X-Application-Token": receipt["status_token"]})
    validate("RegistrationStatus", state.json()["data"])
    sign_in(modern)
    queue = modern.get("/api/v1/admin/registration-applications").json()["data"]
    validate("RegistrationDetailPage", queue)
    detail = modern.get(
        "/api/v1/admin/registration-applications/" + receipt["application_id"]
    ).json()["data"]
    assert detail["evidence_text"] == "v0.4合成测试说明"
    decision = modern.post(
        "/api/v1/admin/registration-applications/" + receipt["application_id"] + "/decision",
        json={"decision": "approve", "expected_version": 1, "reason": "通过测试"},
        headers={"Idempotency-Key": "v4-approval"},
    )
    assert decision.status_code == 200, decision.text
    validate("RegistrationDetail", decision.json()["data"])
    user = sign_in(modern, "new@example.test")
    assert user["user_id"] == receipt["reserved_user_id"] and user["permissions"] == []
    assert modern.get("/api/v1/admin/registration-applications").status_code == 403


def test_v04_bootstrap_pagination_unknown_sources_and_unit_scope(modern, published, app):
    validate("Bootstrap", modern.get("/api/v1/bootstrap").json()["data"])
    schools = modern.get("/api/v1/schools").json()["data"]
    validate("SchoolPage", schools)
    units = modern.get(
        "/api/v1/admission-units", params={"school_id": published["school_id"]}
    ).json()["data"]
    validate("AdmissionUnitPage", units)
    assert len(units["items"]) == 1
    assert (
        modern.get(
            "/api/v1/admission-units", params={"school_id": "00000000-0000-0000-0000-000000000000"}
        ).json()["data"]["items"]
        == []
    )
    validate("Source", modern.get("/api/v1/evidence/" + published["source_id"]).json()["data"])
    validate(
        "UnitHistory",
        modern.get("/api/v1/admission-units/" + published["id"] + "/history").json()["data"],
    )
    from app.db.models import AdmissionUnit

    with app.state.sessions.begin() as db:
        u = db.get(AdmissionUnit, UUID(published["id"]))
        u.data = {**u.data, "tuition": None, "history": [], "required_subjects": None}
    school = modern.get("/api/v1/schools/" + published["school_id"]).json()["data"]
    assert school["rank"] is None and school["tuition"] is None


def test_v04_profile_answers_worker_feedback_plan_and_events(modern, student, published, app):
    sign_in(modern, "student@example.test")
    profile = create_profile(modern)
    run = create_run(modern, profile)
    assert run["status"] == "waiting_input"
    assert {q["field"] for q in run["questions"]} == {"rank", "rank_cohort", "batch"}
    payload = {
        "expected_version": run["version"],
        "answers": {"rank": "20000", "rank_cohort": "浙江普通类", "batch": "普通类一段"},
    }
    url = "/api/v1/recommendations/" + run["run_id"]
    answered = modern.post(url + "/answers", json=payload, headers={"Idempotency-Key": "v4-answer"})
    assert answered.status_code == 202, answered.text
    assert (
        modern.post(
            url + "/answers", json=payload, headers={"Idempotency-Key": "v4-answer"}
        ).status_code
        == 202
    )
    tick(app.state.sessions)
    final = modern.get(url).json()["data"]
    validate("Run", final)
    assert final["status"] == "succeeded" and final["validation"]["status"] == "passed"
    item = final["items"][0]
    assert (
        item["historical_risk"]["status"] == "unknown"
        and final["original_profile_version_id"] == profile["profile_version_id"]
    )
    assert '"validated": true' in modern.get(url + "/events").text
    feedback = modern.post(
        "/api/v1/feedback",
        json={
            "run_id": run["run_id"],
            "recommendation_item_id": item["recommendation_item_id"],
            "kind": "correction",
            "reason": "合成资料复核",
        },
        headers={"Idempotency-Key": "v4-feedback"},
    )
    assert feedback.status_code == 201
    snapshot = modern.get("/api/v1/bootstrap").json()["data"]
    validate("Bootstrap", snapshot)
    plan = snapshot["plan"]
    plan["entries"] = [
        {
            "id": "entry",
            "school_id": item["school_id"],
            "major": item["major"],
            "major_id": item["major_id"],
            "admission_unit_id": item["admission_unit_id"],
            "recommendation_item_id": item["recommendation_item_id"],
            "adjustment": True,
        }
    ]
    saved = modern.put("/api/v1/me/plan", json=plan)
    assert saved.status_code == 200, saved.text
    validate("Plan", saved.json()["data"])
    simulation = modern.post(
        "/api/v1/plans/simulations",
        json={"plan_id": plan["id"], "version": saved.json()["data"]["version"]},
    )
    validate("Simulation", simulation.json()["data"])
    assert simulation.json()["data"]["eligible"] is True
    assert modern.put("/api/v1/me/plan", json=plan).status_code == 409


def test_v04_private_post_review_versions_and_delete(modern, student, published, app):
    sign_in(modern, "student@example.test")
    body = {
        "school_id": published["school_id"],
        "topic": "生活",
        "title": "合成测试来信",
        "body": "仅用于接口集成测试。" * 12,
        "visibility": "private",
    }
    response = modern.post("/api/v1/posts", json=body, headers={"Idempotency-Key": "private"})
    assert response.status_code == 201, response.text
    record = response.json()["data"]
    validate("Post", record)
    sign_in(modern)
    assert (
        modern.post(
            "/api/v1/admin/reviews/" + record["id"],
            json={"decision": "approve", "expected_version": 1, "reason": "测试人工批准"},
        ).status_code
        == 200
    )
    modern.post("/api/v1/auth/logout")
    assert modern.get("/api/v1/posts/" + record["id"]).status_code == 404
    assert (
        modern.get("/api/v1/posts", params={"school_id": published["school_id"]}).json()["data"][
            "items"
        ]
        == []
    )
    sign_in(modern, "student@example.test")
    assert (
        modern.patch(
            "/api/v1/posts/" + record["id"], json={"expected_version": 2, "visibility": "public"}
        ).status_code
        == 200
    )
    with app.state.sessions() as db:
        assert db.get(Post, UUID(record["id"])).status == "pending"
    assert (
        modern.request(
            "DELETE", "/api/v1/posts/" + record["id"], json={"expected_version": 3}
        ).status_code
        == 200
    )


def test_v04_unsupported_features_are_explicit_and_no_sharing(modern):
    actual = modern.app.openapi()["paths"]
    assert all(
        method in actual.get("/api/v1" + path, {})
        for path, operations in CONTRACT["paths"].items()
        for method in operations
    )
    sign_in(modern)
    assert "verification:review" not in modern.get("/api/v1/auth/me").json()["data"]["permissions"]
    for path in ("/api/v1/me/profile/parse", "/api/v1/me/case-sharing-consent"):
        r = modern.post(path, json={"consent": True})
        assert r.status_code == 503
        validate("Error", r.json())
    assert modern.get("/api/v1/me/case-sharing-consent").json()["data"]["enabled"] is False
    for payload in ({}, {"message": "test", "conversation_id": "invalid"}, {"message": 1}):
        response = modern.post("/api/v1/chat/stream", json=payload)
        assert response.status_code == 422
        validate("Error", response.json())


def test_v04_browser_recording_webm_is_decoded_and_preserved(modern):
    import shutil
    import subprocess

    from app.core.storage import validate_audio

    encoder = shutil.which("ffmpeg")
    assert encoder and shutil.which("ffprobe"), (
        "Install ffmpeg and ffprobe for browser recording support"
    )
    sample = subprocess.run(
        [
            encoder,
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=0.3",
            "-c:a",
            "libopus",
            "-f",
            "webm",
            "pipe:1",
        ],
        capture_output=True,
        check=True,
    ).stdout
    assert validate_audio(sample)[0] == "audio/webm"
    receipt = modern.post(
        "/api/v1/registration-applications",
        data={"nickname": "录音", "email": "voice@example.test", "password": PASSWORD},
        files={"evidence_audio": ("browser.webm", sample, "audio/webm")},
        headers={"Idempotency-Key": "browser-recording"},
    )
    assert receipt.status_code == 202, receipt.text
    path = "/api/v1/admin/registration-applications/" + receipt.json()["data"]["application_id"]
    assert modern.get(path + "/audio").status_code == 401
    sign_in(modern)
    assert modern.get(path + "/audio").content == sample
    assert (
        modern.post(
            path + "/decision",
            json={"decision": "approve", "expected_version": 1, "reason": "人工复核合成原始录音"},
            headers={"Idempotency-Key": "voice-decision"},
        ).status_code
        == 200
    )


def test_v04_cancel_and_snapshot_ownership(modern, student, admin_client, published, app):
    sign_in(modern, "student@example.test")
    run = create_run(modern, create_profile(modern))
    path = "/api/v1/recommendations/" + run["run_id"]
    assert (
        modern.post(
            path + "/cancel",
            json={"expected_version": run["version"]},
            headers={"Idempotency-Key": "cancel-v4"},
        ).status_code
        == 202
    )
    tick(app.state.sessions)
    assert modern.get(path).json()["data"]["status"] == "cancelled"
    sign_in(modern)
    assert modern.get(path).status_code == 404
