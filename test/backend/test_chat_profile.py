"""Chat-derived profile calibration with explicit confirmation."""

import json

import pytest
from conftest import HEADERS, PASSWORD
from fastapi.testclient import TestClient

from app.db.models import ChatProfileSignal
from app.main import create_app


class FakeGateway:
    def __init__(self):
        self.messages = []

    def stream_text(self, messages, *, max_tokens=None, temperature=0.3):
        self.messages = messages
        yield "我看到你在咨询浙江，先按当前已发布数据回答。"
        yield "如果确认更新画像，后续会按浙江口径继续。"

    def close(self):
        pass


@pytest.fixture
def modern_chat(app):
    application = create_app(app.state.settings)
    application.state.model_gateway_factory = lambda settings: FakeGateway()
    with TestClient(application, headers=HEADERS) as client:
        login = client.post(
            "/api/v1/auth/login",
            json={
                "login_type": "email",
                "identifier": "admin@example.test",
                "password": PASSWORD,
            },
        )
        assert login.status_code == 200, login.text
        yield client


def profile_payload(version=0, province="河南", score=600, rank=30000):
    return {
        "expected_version": version,
        "province_code": province,
        "exam_year": 2026,
        "exam_category": "普通类",
        "score": score,
        "rank": rank,
        "rank_cohort": "普通类位次",
        "subjects": ["物理", "化学", "生物"],
        "budget": {"amount": 10000, "currency": "CNY", "period": "year", "scope": "tuition"},
        "preferred_regions": ["郑州"],
        "preferred_majors": ["计算机"],
        "accept_adjustment": True,
        "consent": True,
        "preferences": [],
    }


def events(response):
    return [
        json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


def test_chat_proposes_and_confirms_profile_calibration(app, modern_chat, published):
    saved = modern_chat.patch("/api/v1/me/profile", json=profile_payload())
    assert saved.status_code == 200, saved.text
    assert saved.json()["data"]["province_code"] == "河南"

    response = modern_chat.post(
        "/api/v1/chat/stream",
        json={"message": "我现在在浙江，想看看计算机专业，628分，位次20000"},
    )
    assert response.status_code == 200, response.text
    payloads = events(response)
    proposal = next(item for item in payloads if item["type"] == "profile_update")
    assert proposal["expected_version"] == 1
    changes = {item["field"]: item for item in proposal["changes"]}
    assert changes["province"]["old"] == "河南"
    assert changes["province"]["new"] == "浙江"
    assert changes["score"]["new"] == 628
    assert changes["rank"]["new"] == 20000
    # Zhejiang rows cannot be cited as matching the still-confirmed Henan profile.
    assert proposal["source_ids"] == []
    assert "更新考生画像" in proposal["question"]

    with app.state.sessions() as db:
        signal = db.get(ChatProfileSignal, proposal["signal_id"])
        assert signal.status == "proposed"
        assert signal.query_text.startswith("我现在在浙江")
        assert signal.source_ids == []

    resolved = modern_chat.post(
        f"/api/v1/chat/profile-signals/{proposal['signal_id']}/resolve",
        json={"decision": "confirm", "expected_version": 1},
    )
    assert resolved.status_code == 200, resolved.text
    data = resolved.json()["data"]
    assert data["signal"]["status"] == "confirmed"
    assert data["profile"]["province_code"] == "浙江"
    assert data["profile"]["score"] == 628
    assert data["profile"]["rank"] == 20000
    assert data["profile"]["version"] == 2
    assert modern_chat.get("/api/v1/me/profile").json()["data"]["province_code"] == "浙江"
    assert (
        modern_chat.post(
            f"/api/v1/chat/profile-signals/{proposal['signal_id']}/resolve",
            json={"decision": "confirm", "expected_version": 2},
        ).status_code
        == 409
    )


def test_chat_profile_proposal_can_be_rejected(app, modern_chat, published):
    saved = modern_chat.patch("/api/v1/me/profile", json=profile_payload())
    assert saved.status_code == 200
    response = modern_chat.post(
        "/api/v1/chat/stream",
        json={"message": "我的生源省份是江苏，计算机专业怎么样？"},
    )
    proposal = next(item for item in events(response) if item["type"] == "profile_update")
    resolved = modern_chat.post(
        f"/api/v1/chat/profile-signals/{proposal['signal_id']}/resolve",
        json={"decision": "reject", "expected_version": 1},
    )
    assert resolved.status_code == 200
    assert resolved.json()["data"]["signal"]["status"] == "rejected"
    assert modern_chat.get("/api/v1/me/profile").json()["data"]["province_code"] == "河南"
