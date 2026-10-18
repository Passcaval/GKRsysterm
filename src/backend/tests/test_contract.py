import json
from pathlib import Path

from jsonschema import Draft202012Validator

CONTRACT = json.loads(
    (Path(__file__).resolve().parent / "fixtures/v01-openapi.json").read_text(encoding="utf-8")
)


def validate(name, value):
    schema = {"$ref": f"#/components/schemas/{name}", "components": CONTRACT["components"]}
    Draft202012Validator(schema).validate(value)


def test_all_legacy_routes_present(app):
    available = {
        (path, method.lower())
        for path, methods in app.openapi()["paths"].items()
        for method in methods
    }
    for path, operations in CONTRACT["paths"].items():
        for method in operations:
            # Path parameter spelling is not semantically relevant.
            import re

            target = re.sub(r"\{[^}]+\}", "{}", "/api/v1" + path)
            assert any(
                re.sub(r"\{[^}]+\}", "{}", candidate) == target and verb == method
                for candidate, verb in available
            ), path


def test_actual_postgres_responses_match_frontend_contract(
    student, admin_client, published, profile, app
):
    validate("Bootstrap", student.get("/api/v1/bootstrap").json()["data"])
    legacy_profile = {k: v for k, v in profile.items() if k not in {"batch", "rank_cohort"}}
    validate("Profile", student.put("/api/v1/me/profile", json=legacy_profile).json()["data"])
    snapshot = student.get("/api/v1/bootstrap").json()["data"]
    validate("Bootstrap", snapshot)
    validate("User", snapshot["user"])
    recommendations = student.post("/api/v1/recommendations", json={"riskPreference": 50})
    assert recommendations.status_code == 200, recommendations.text
    assert recommendations.json()["data"]
    for recommendation in recommendations.json()["data"]:
        validate("Recommendation", recommendation)
        assert recommendation["tier"] == "unknown"
    post = student.post(
        "/api/v1/posts",
        json={
            "schoolId": published["school_id"],
            "topic": "生活",
            "title": "契约测试",
            "body": "仅用于契约的合成材料",
        },
    ).json()["data"]
    validate("Post", post)
    validate(
        "Post",
        admin_client.post(
            f"/api/v1/admin/reviews/{post['id']}", json={"decision": "approve", "reason": "测试"}
        ).json()["data"],
    )
    plan = snapshot["plan"]
    plan["entries"] = [
        {
            "id": "one",
            "schoolId": published["school_id"],
            "major": published["major"],
            "adjustment": True,
        }
    ]
    updated = student.put("/api/v1/me/plan", json=plan).json()["data"]
    validate("Plan", updated)
    validate(
        "Simulation",
        student.post(
            "/api/v1/plans/simulations",
            json={"planId": updated["id"], "version": updated["version"]},
        ).json()["data"],
    )
    error = student.put("/api/v1/me/plan", json=plan)
    validate("Error", error.json())
    stream = student.post("/api/v1/chat/stream", json={"message": "测试对话边界"})
    assert stream.status_code == 200 and "text/event-stream" in stream.headers["content-type"]
    assert '"type": "error"' in stream.text and '"type": "done"' in stream.text
