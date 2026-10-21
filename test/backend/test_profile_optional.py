"""Optional profile fields, branch recommendations and fuzzy preferences."""

from conftest import PASSWORD

from app.workers.runner import tick


def sign_in(client, email="admin@example.test"):
    response = client.post(
        "/api/v1/auth/login",
        json={"login_type": "email", "identifier": email, "password": PASSWORD},
    )
    assert response.status_code == 200, response.text
    return response


def minimal_profile(version=0):
    return {
        "expected_version": version,
        "province_code": "浙江",
        "exam_year": 2026,
        "exam_category": "普通类",
        "score": None,
        "rank": 20000,
        "rank_cohort": None,
        "subjects": ["物理", "化学", "生物"],
        "budget": {
            "amount": None,
            "currency": "CNY",
            "period": "year",
            "scope": "tuition",
        },
        "preferred_regions": [],
        "preferred_majors": [],
        "accept_adjustment": False,
        "consent": True,
        "preferences": [],
    }


def test_minimal_profile_recommends_with_branch_analysis(modern, published, app):
    sign_in(modern)
    saved = modern.patch("/api/v1/me/profile", json=minimal_profile())
    assert saved.status_code == 200, saved.text
    profile = saved.json()["data"]
    assert profile["subjects"] == ["物理", "化学", "生物"]
    assert profile["score"] is None
    assert profile["budget"]["amount"] is None

    created = modern.post(
        "/api/v1/recommendations",
        json={
            "question": "只填了省份位次选科，先看看有哪些方向",
            "profile_version_id": profile["profile_version_id"],
            "risk_preference": 50,
            "intent": "risk",
        },
        headers={"Idempotency-Key": "optional-profile-run"},
    )
    assert created.status_code == 202, created.text
    assert created.json()["data"]["status"] == "queued"
    tick(app.state.sessions)
    final = modern.get("/api/v1/recommendations/" + created.json()["data"]["run_id"]).json()["data"]
    assert final["status"] == "succeeded"
    assert final["validation"]["status"] == "passed"
    assert final["missing_info"]
    assert {item["field"] for item in final["missing_info"]} >= {
        "score",
        "cities",
        "interests",
        "budget",
    }
    assert all(item["required"] is False for item in final["missing_info"])
    assert len(final["branches"]) == 3
    item_ids = {item["recommendation_item_id"] for item in final["items"]}
    for branch in final["branches"]:
        assert branch["pros"] and branch["cons"]
        assert branch["item_ids"]
        assert set(branch["item_ids"]) <= item_ids
    assert final["items"][0]["eligibility"]["status"] == "unknown"
    assert "subjects" not in {item["field"] for item in final["missing_info"]}
    assert any(
        "学费预算" in value for value in final["items"][0]["eligibility"]["missing_requirements"]
    )


def test_fuzzy_profile_suggestions(modern, published):
    sign_in(modern)
    response = modern.get("/api/v1/me/profile/suggestions", params={"q": "计算"})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert any("计算机" in value for value in data["majors"])
    assert data["schools"]
    assert data["schools"][0]["id"] and data["schools"][0]["name"]

    typo = modern.get("/api/v1/me/profile/suggestions", params={"q": "计算级"})
    assert typo.status_code == 200
    assert any("计算机" in value for value in typo.json()["data"]["majors"])


def test_missing_subjects_blocks_but_score_does_not(modern, published, app):
    sign_in(modern)
    payload = minimal_profile()
    payload["subjects"] = []
    profile = modern.patch("/api/v1/me/profile", json=payload).json()["data"]
    created = modern.post(
        "/api/v1/recommendations",
        json={
            "question": "先看方向",
            "profile_version_id": profile["profile_version_id"],
            "risk_preference": 50,
            "intent": "admission",
        },
        headers={"Idempotency-Key": "missing-subjects"},
    )
    assert created.status_code == 202, created.text
    run = created.json()["data"]
    assert run["status"] == "waiting_input"
    assert {q["field"] for q in run["questions"]} == {"subjects"}
    answered = modern.post(
        f"/api/v1/recommendations/{run['run_id']}/answers",
        json={
            "expected_version": run["version"],
            "answers": {"subjects": "物理、化学、生物"},
        },
        headers={"Idempotency-Key": "fill-subjects"},
    )
    assert answered.status_code == 202, answered.text
    assert answered.json()["data"]["status"] == "queued"
    tick(app.state.sessions)
    assert (
        modern.get(f"/api/v1/recommendations/{run['run_id']}").json()["data"]["validation"][
            "status"
        ]
        == "passed"
    )


def test_follow_up_preferences_create_new_profile_and_keep_old_run(modern, published, app):
    sign_in(modern)
    profile = modern.patch("/api/v1/me/profile", json=minimal_profile()).json()["data"]

    def run_for(version_id, key):
        response = modern.post(
            "/api/v1/recommendations",
            json={
                "question": "根据当前信息推荐",
                "profile_version_id": version_id,
                "risk_preference": 50,
                "intent": "admission",
            },
            headers={"Idempotency-Key": key},
        )
        assert response.status_code == 202, response.text
        tick(app.state.sessions)
        return modern.get("/api/v1/recommendations/" + response.json()["data"]["run_id"]).json()[
            "data"
        ]

    old = run_for(profile["profile_version_id"], "navigator-initial")
    saved = modern.patch(
        "/api/v1/me/profile",
        json={
            "expected_version": 1,
            "preferred_regions": ["浙江"],
            "preferred_majors": ["计算机"],
            "preferred_schools": ["合成测试大学"],
        },
    )
    assert saved.status_code == 200, saved.text
    updated = saved.json()["data"]
    assert updated["version"] == 2 and updated["province_code"] == "浙江"
    assert updated["preferred_schools"] == ["合成测试大学"]
    new = run_for(updated["profile_version_id"], "navigator-refined")
    assert new["validation"]["status"] == "passed"
    assert new["profile_version_id"] != old["profile_version_id"]
    assert modern.get("/api/v1/recommendations/" + old["run_id"]).json()["data"] == old


def test_profile_parse_is_available_without_model_and_does_not_save(modern):
    sign_in(modern)
    response = modern.post(
        "/api/v1/me/profile/parse",
        json={
            "text": "我是浙江考生，位次20000，选科物化生。想去江苏，想学计算机专业。意向院校：合成大学"
        },
    )
    assert response.status_code == 200, response.text
    parsed = response.json()["data"]
    assert parsed["proposed_changes"]["province_code"] == "浙江"
    assert parsed["proposed_changes"]["preferred_regions"] == ["江苏"]
    assert parsed["proposed_changes"]["preferred_majors"] == ["计算机"]
    assert parsed["proposed_changes"]["preferred_schools"] == ["合成大学"]
    assert "score" not in parsed["missing_fields"]
    assert "consent" in parsed["missing_fields"]
    assert modern.get("/api/v1/me/profile").json()["data"] is None
