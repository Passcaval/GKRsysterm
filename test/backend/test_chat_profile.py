"""Chat-derived profile calibration applied directly from explicit statements."""

import json

import pytest
from conftest import HEADERS, PASSWORD
from fastapi.testclient import TestClient

from app.db.models import ChatProfileSignal
from app.main import create_app


class FakeGateway:
    instances = []

    def __init__(self):
        self.messages = []
        type(self).instances.append(self)

    def stream_text(self, messages, *, max_tokens=None, temperature=0.3):
        self.messages = messages
        yield "我看到你在咨询浙江，先按当前已发布数据回答。"
        yield "后续会按这次对话里提到的信息继续。"

    def close(self):
        pass


@pytest.fixture
def modern_chat(app):
    FakeGateway.instances.clear()
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


def test_chat_applies_profile_calibration_without_a_form(app, modern_chat):
    first = modern_chat.post(
        "/api/v1/chat/stream",
        json={"message": "我是河南考生，600分，位次30000，选科物化生"},
    )
    assert first.status_code == 200, first.text
    first_payloads = events(first)
    first_update = next(item for item in first_payloads if item["type"] == "profile_update")
    conversation_id = first_payloads[-1]["conversation_id"]
    assert first_update["conversation_profile"]["province"] == "河南"

    response = modern_chat.post(
        "/api/v1/chat/stream",
        json={
            "message": "我现在在浙江，628分，位次20000",
            "conversation_id": conversation_id,
        },
    )
    assert response.status_code == 200, response.text
    proposal = next(item for item in events(response) if item["type"] == "profile_update")
    assert proposal["applied"] is True
    assert proposal["conversation_profile"]["province"] == "浙江"
    assert proposal["conversation_profile"]["score"] == 628
    assert proposal["conversation_profile"]["rank"] == 20000
    assert proposal["conversation_profile"]["subjects"] == ["物理", "化学", "生物"]
    assert "已根据这次对话记下" in proposal["question"]
    changes = {item["field"]: item for item in proposal["changes"]}
    assert changes["province"]["old"] == "河南"
    assert changes["province"]["new"] == "浙江"
    assert changes["score"]["new"] == 628
    assert changes["rank"]["new"] == 20000

    with app.state.sessions() as db:
        signal = db.get(ChatProfileSignal, proposal["signal_id"])
        assert signal.status == "confirmed"
        assert signal.query_text.startswith("我现在在浙江")

    profile = modern_chat.get("/api/v1/me/profile").json()["data"]
    assert profile["province_code"] == "浙江"
    assert profile["score"] == 628
    assert profile["rank"] == 20000
    assert profile["version"] == 2
    assert (
        modern_chat.post(
            f"/api/v1/chat/profile-signals/{proposal['signal_id']}/resolve",
            json={"decision": "confirm", "expected_version": 1},
        ).status_code
        == 409
    )


def test_new_chat_does_not_inherit_saved_profile(app, modern_chat):
    saved = modern_chat.patch("/api/v1/me/profile", json=profile_payload())
    assert saved.status_code == 200, saved.text

    response = modern_chat.post(
        "/api/v1/chat/stream",
        json={"message": "628 分，浙江省排名33226推荐的院校和专业"},
    )
    assert response.status_code == 200, response.text
    proposal = next(item for item in events(response) if item["type"] == "profile_update")
    conversation = proposal["conversation_profile"]
    assert conversation["province"] == "浙江"
    assert conversation["score"] == 628
    assert conversation["rank"] == 33226
    assert conversation["subjects"] == []
    assert conversation["cities"] == []
    assert conversation["interests"] == []
    assert conversation["budget"] is None
    changes = {item["field"]: item for item in proposal["changes"]}
    assert changes["province"]["old"] in (None, "")
    assert changes["rank"]["new"] == 33226

    system = FakeGateway.instances[-1].messages[0]["content"]
    assert "郑州" not in system
    assert "10000" not in system
    assert "河南" not in system


def test_chat_saves_partial_profile_without_manual_fields(app, modern_chat):
    response = modern_chat.post(
        "/api/v1/chat/stream",
        json={"message": "我想去江苏，想学计算机"},
    )
    assert response.status_code == 200, response.text
    proposal = next(item for item in events(response) if item["type"] == "profile_update")
    assert proposal["applied"] is True
    assert proposal["conversation_profile"]["cities"] == ["江苏"]
    assert proposal["conversation_profile"]["interests"] == ["计算机"]
    assert proposal["conversation_profile"]["province"] == ""
    assert proposal["conversation_profile"]["rank"] is None
    profile = modern_chat.get("/api/v1/me/profile").json()["data"]
    assert profile["preferred_regions"] == ["江苏"]
    assert profile["preferred_majors"] == ["计算机"]
    assert profile["province_code"] is None
    assert profile["rank"] is None
    assert profile["version"] == 1
    with app.state.sessions() as db:
        signal = db.get(ChatProfileSignal, proposal["signal_id"])
        assert signal.status == "confirmed"
