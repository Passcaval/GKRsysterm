from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import UUID

import pytest
from conftest import HEADERS, approve, login, submit
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.core.errors import DomainError
from app.db.models import AdmissionUnit, Feedback, Job, ProfileVersion, RecommendationRun
from app.modules.recommendation.service import evaluate_snapshot, rules
from app.modules.validation.service import validate_result
from app.workers.runner import tick


def test_import_is_atomic_idempotent_and_versioned(app, admin_client, import_payload):
    first = admin_client.post("/api/v1/admin/imports", json=import_payload).json()["data"]
    assert admin_client.get("/api/v1/admission-units").json()["data"]["items"] == []
    assert admin_client.post("/api/v1/admin/imports", json=import_payload).json()["data"] == first
    tick(app.state.sessions)
    old = admin_client.get("/api/v1/admission-units").json()["data"]["items"][0]
    source = admin_client.get("/api/v1/sources/" + old["source_id"]).json()["data"]
    snapshot = admin_client.get("/api/v1/admin/imports/" + first["import_id"] + "/snapshot").json()[
        "data"
    ]
    assert snapshot["content_hash"] == source["content_hash"]
    assert snapshot["normalized_snapshot"]["rows"][0]["tuition"] == 5000
    import_payload["rows"][0]["tuition"] = 6000
    import_payload["supersedes_import_id"] = first["import_id"]
    second = admin_client.post("/api/v1/admin/imports", json=import_payload).json()["data"]
    assert first["import_id"] != second["import_id"]
    tick(app.state.sessions)
    new = admin_client.get("/api/v1/admission-units").json()["data"]["items"][0]
    assert new["id"] != old["id"]
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(AdmissionUnit)) == 2
        assert not db.get(AdmissionUnit, UUID(old["id"])).active


def test_import_rejects_unreviewed_or_untrusted_source(admin_client, import_payload):
    import_payload["reviewed"] = False
    assert admin_client.post("/api/v1/admin/imports", json=import_payload).status_code == 422
    import_payload["reviewed"] = True
    import_payload["source_url"] = "http://127.0.0.1/private"
    assert admin_client.post("/api/v1/admin/imports", json=import_payload).status_code == 422


def test_csv_import_publishes_same_normalized_rows(app, admin_client, import_payload):
    import csv
    import io
    import json

    row = dict(import_payload["rows"][0])
    for field in ("required_subjects", "additional_requirements", "history"):
        row[field] = json.dumps(row[field], ensure_ascii=False)
    csv_file = io.StringIO(newline="")
    writer = csv.DictWriter(csv_file, fieldnames=list(row))
    writer.writeheader()
    writer.writerow(row)
    metadata = {k: v for k, v in import_payload.items() if k != "rows"}
    response = admin_client.post(
        "/api/v1/admin/imports/csv",
        data={"metadata": json.dumps(metadata)},
        files={"file": ("synthetic.csv", csv_file.getvalue().encode("utf-8-sig"), "text/csv")},
    )
    assert response.status_code == 202, response.text
    tick(app.state.sessions)
    units = admin_client.get("/api/v1/admission-units").json()["data"]["items"]
    assert len(units) == 1 and units[0]["required_subjects"] == ["物理", "化学"]
    assert units[0]["history"][0]["rank"] == 25000


def test_conflicting_source_does_not_replace_current_dataset(
    app, admin_client, import_payload, published
):
    import_payload["rows"][0]["tuition"] = 9999
    response = admin_client.post("/api/v1/admin/imports", json=import_payload)
    assert response.status_code == 202
    tick(app.state.sessions)
    status = admin_client.get(
        "/api/v1/admin/imports/" + response.json()["data"]["import_id"]
    ).json()["data"]
    assert status["status"] == "failed" and status["errors"][0]["code"] == "SOURCE_CONFLICT"
    assert admin_client.get("/api/v1/admission-units").json()["data"]["items"][0]["tuition"] == 5000


def test_validator_rejects_foreign_evidence_and_unqualified_candidates(profile, published):
    snapshot = {"profile": profile, "units": [published]}
    output = evaluate_snapshot(snapshot)
    output["items"][0]["evidence_ids"] = ["foreign-source"]
    with pytest.raises(DomainError, match="候选或来源"):
        validate_result(snapshot, output)
    published["tuition"] = None
    output = evaluate_snapshot(snapshot)
    output["items"] = output.pop("pending_confirmation")
    output["pending_confirmation"] = []
    with pytest.raises(DomainError, match="硬条件"):
        validate_result(snapshot, output)


def test_profiles_concurrency_snapshot_and_ownership(
    student, admin_client, profile, app, published
):
    first = student.patch("/api/v1/me/profile", json={"expected_version": 0, "profile": profile})
    assert first.status_code == 200, first.text
    assert (
        student.patch(
            "/api/v1/me/profile", json={"expected_version": 0, "profile": profile}
        ).status_code
        == 409
    )
    run = student.post(
        "/api/v1/recommendations",
        json={"question": "希望查询有来源的候选"},
        headers={"Idempotency-Key": "snapshot"},
    )
    assert run.status_code == 202, run.text
    data = run.json()["data"]
    profile["budget"] = 10
    assert (
        student.patch(
            "/api/v1/me/profile", json={"expected_version": 1, "profile": profile}
        ).status_code
        == 200
    )
    tick(app.state.sessions)
    completed = student.get(f"/api/v1/recommendations/{data['run_id']}").json()["data"]
    assert len(completed["result"]["items"]) == 1  # Frozen older budget, not current budget.
    assert completed["profile_version_id"] == first.json()["data"]["profile_version_id"]
    assert admin_client.get(f"/api/v1/recommendations/{data['run_id']}").status_code == 404
    assert admin_client.get(f"/api/v1/recommendations/{data['run_id']}/events").status_code == 404


def test_rules_exclude_hard_failures_and_keep_unknown(profile, published):
    profile["subjects"] = ["历史", "政治", "地理"]
    failed = rules(profile, published)
    assert failed["eligibility"]["status"] == "fail"
    profile["subjects"] = ["物理", "化学", "生物"]
    published["tuition"] = None
    assert rules(profile, published)["eligibility"]["status"] == "unknown"
    published["tuition"] = 5000
    profile["rank_cohort"] = "另一统计口径"
    assert rules(profile, published)["historical_risk"]["status"] == "unknown"


def test_waiting_answers_events_resume_and_idempotency(student, profile, published, app):
    response = student.post(
        "/api/v1/recommendations",
        json={"question": "推荐候选"},
        headers={"Idempotency-Key": "wait"},
    )
    assert response.status_code == 202, response.text
    run = response.json()["data"]
    assert run["status"] == "waiting_input"
    duplicate = student.post(
        "/api/v1/recommendations",
        json={"question": "推荐候选"},
        headers={"Idempotency-Key": "wait"},
    )
    assert duplicate.json()["data"]["run_id"] == run["run_id"]
    assert (
        student.post(
            "/api/v1/recommendations",
            json={"question": "不同问题"},
            headers={"Idempotency-Key": "wait"},
        ).status_code
        == 409
    )
    first_events = student.get(f"/api/v1/recommendations/{run['run_id']}/events").text
    assert "event: question" in first_events
    answer = student.post(
        f"/api/v1/recommendations/{run['run_id']}/answers",
        json={"expected_profile_version": 0, "profile": profile},
    )
    assert answer.status_code == 202, answer.text
    assert (
        student.post(
            f"/api/v1/recommendations/{run['run_id']}/answers",
            json={"expected_profile_version": 0, "profile": profile},
        ).status_code
        == 409
    )
    tick(app.state.sessions)
    resumed = student.get(
        f"/api/v1/recommendations/{run['run_id']}/events", headers={"Last-Event-ID": "2"}
    ).text
    assert "event: result" in resumed and "event: done" in resumed and "id: 1\n" not in resumed
    with app.state.sessions() as db:
        stored = db.get(RecommendationRun, UUID(run["run_id"]))
        assert stored.snapshot["profile_history"] == [{"profile_version_id": None, "profile": None}]


def test_worker_crash_lease_and_two_workers_no_duplicate(student, profile, published, app):
    student.put("/api/v1/me/profile", json=profile)
    run = student.post(
        "/api/v1/recommendations",
        json={"question": "测试恢复"},
        headers={"Idempotency-Key": "lease"},
    ).json()["data"]
    with app.state.sessions.begin() as db:
        job = db.scalar(select(Job).where(Job.task_type == "recommendation"))
        job.status, job.lease_token = "running", "dead-worker"
        from app.db.models import now

        job.lease_until = now() - timedelta(seconds=1)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda _: tick(app.state.sessions), [1, 2]))
    completed = student.get(f"/api/v1/recommendations/{run['run_id']}").json()["data"]
    assert completed["status"] == "succeeded"
    assert (
        student.get(f"/api/v1/recommendations/{run['run_id']}/events").text.count("event: result")
        == 1
    )


def test_cancel_and_delete_prevent_job_resurrection(student, profile, published, app):
    student.put("/api/v1/me/profile", json=profile)
    run = student.post(
        "/api/v1/recommendations", json={"question": "取消"}, headers={"Idempotency-Key": "cancel"}
    ).json()["data"]
    assert student.post(f"/api/v1/recommendations/{run['run_id']}/cancel").status_code == 202
    tick(app.state.sessions)
    assert (
        student.get(f"/api/v1/recommendations/{run['run_id']}").json()["data"]["status"]
        == "cancelled"
    )
    student.post(
        "/api/v1/recommendations",
        json={"question": "删除后不复活"},
        headers={"Idempotency-Key": "delete"},
    )
    assert student.delete("/api/v1/me/data").status_code == 200
    assert not tick(app.state.sessions)
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(RecommendationRun)) == 0
        assert db.scalar(select(func.count()).select_from(ProfileVersion)) == 0


def test_feedback_targets_immutable_run_and_does_not_change_facts(
    student, profile, published, app, admin_client
):
    student.put("/api/v1/me/profile", json=profile)
    run = student.post(
        "/api/v1/recommendations",
        json={"question": "反馈"},
        headers={"Idempotency-Key": "feedback-run"},
    ).json()["data"]
    tick(app.state.sessions)
    completed = student.get(f"/api/v1/recommendations/{run['run_id']}").json()["data"]
    item = completed["result"]["items"][0]
    payload = {
        "run_id": run["run_id"],
        "recommendation_item_id": item["recommendation_item_id"],
        "kind": "correction",
        "reason": "测试：我认为学费有误，需核验",
    }
    first = student.post("/api/v1/feedback", json=payload, headers={"Idempotency-Key": "feedback"})
    assert first.status_code == 201, first.text
    assert (
        student.post(
            "/api/v1/feedback", json=payload, headers={"Idempotency-Key": "feedback"}
        ).json()["data"]
        == first.json()["data"]
    )
    assert (
        admin_client.post(
            "/api/v1/feedback", json=payload, headers={"Idempotency-Key": "other"}
        ).status_code
        == 404
    )
    assert student.get("/api/v1/admin/feedback").status_code == 403
    corrections = admin_client.get("/api/v1/admin/feedback").json()["data"]["items"]
    assert corrections[0]["feedback_id"] == first.json()["data"]["feedback_id"]
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(Feedback)) == 1
        assert db.get(AdmissionUnit, UUID(published["id"])).data["tuition"] == 5000


def test_plan_lock_and_user_data_isolation(student, admin_client, profile, published, app):
    student.put("/api/v1/me/profile", json=profile)
    snapshot = student.get("/api/v1/bootstrap").json()["data"]
    plan = snapshot["plan"]
    plan["entries"] = [
        {
            "id": "entry-1",
            "schoolId": published["school_id"],
            "major": published["major"],
            "adjustment": True,
        }
    ]
    assert student.put("/api/v1/me/plan", json=plan).status_code == 200
    assert student.put("/api/v1/me/plan", json=plan).status_code == 409
    assert admin_client.put("/api/v1/me/plan", json=plan).status_code == 404
    with TestClient(app, headers=HEADERS) as other:
        data = submit(other, nickname="小红", email="other@example.test").json()["data"]
        approve(admin_client, data)
        login(other, "other@example.test")
        view = other.get("/api/v1/bootstrap").json()["data"]
        assert view["profile"] is None and not view["plan"]["entries"] and not view["favorites"]


def test_posts_manual_moderation_and_private_verification(student, admin_client, published):
    response = student.post(
        "/api/v1/posts",
        json={
            "schoolId": published["school_id"],
            "topic": "生活",
            "title": "测试帖子",
            "body": "仅用于测试的校园体验。",
        },
    )
    assert response.status_code == 200, response.text
    post = response.json()["data"]
    assert post["status"] == "pending"
    assert admin_client.get("/api/v1/admin/reviews").json()["data"][0]["id"] == post["id"]
    assert (
        admin_client.post(
            f"/api/v1/admin/reviews/{post['id']}",
            json={"decision": "approve", "reason": "测试通过"},
        ).status_code
        == 200
    )
    assert (
        admin_client.post(
            f"/api/v1/admin/reviews/{post['id']}", json={"decision": "reject", "reason": "重复"}
        ).status_code
        == 409
    )
    assert (
        student.post(
            f"/api/v1/posts/{post['id']}/feedback", json={"kind": "helpful", "reason": ""}
        ).status_code
        == 403
    )
    assert (
        student.post(
            "/api/v1/verifications",
            data={"schoolId": published["school_id"]},
            files={"document": ("fake.pdf", b"not pdf", "application/pdf")},
        ).status_code
        == 415
    )
    assert (
        student.post(
            "/api/v1/verifications",
            data={"schoolId": published["school_id"], "document": "not-file"},
        ).status_code
        == 400  # Parser rejects two text fields before a file can be read.
    )
    import io

    from PIL import Image

    image = io.BytesIO()
    Image.new("RGB", (2, 2), "white").save(image, format="PNG")
    uploaded = student.post(
        "/api/v1/verifications",
        data={"schoolId": published["school_id"]},
        files={"document": ("synthetic.png", image.getvalue(), "image/png")},
    )
    assert uploaded.status_code == 200 and uploaded.json()["data"]["status"] == "pending"
    assert student.get("/api/v1/auth/me").json()["data"]["verified"] is False
