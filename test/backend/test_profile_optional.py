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
        "score": 628,
        "rank": 20000,
        "rank_cohort": None,
        "subjects": [],
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
    assert profile["subjects"] == []
    assert profile["budget"]["amount"] is None

    created = modern.post(
        "/api/v1/recommendations",
        json={
            "question": "只填了省份分数位次，先看看有哪些方向",
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
        "subjects",
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
    assert any(
        "选科" in value for value in final["items"][0]["eligibility"]["missing_requirements"]
    )
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
