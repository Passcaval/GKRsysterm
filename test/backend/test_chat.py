"""Offline tests for the streaming admissions copilot."""

import json

import pytest
from conftest import HEADERS, PASSWORD
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db.models import (
    ChatProfileSignal,
    Conversation,
    ConversationMessage,
    ProfileVersion,
    School,
)
from app.main import create_app


class FakeGateway:
    def __init__(self, chunks=None):
        self.chunks = chunks or ["根据已发布的招生数据，", "可以考虑合成测试大学。"]
        self.messages = []
        self.closed = False

    def stream_text(self, messages, *, max_tokens=None, temperature=0.3):
        self.messages = messages
        for chunk in self.chunks:
            yield chunk

    def close(self):
        self.closed = True


class EmptyGateway:
    def __init__(self):
        self.messages = []

    def stream_text(self, messages, *, max_tokens=None, temperature=0.3):
        self.messages = messages
        if False:
            yield ""

    def close(self):
        pass


class Factory:
    def __init__(self, chunks=None):
        self.chunks = chunks
        self.gateways = []

    def __call__(self, settings):
        gateway = FakeGateway(self.chunks)
        self.gateways.append(gateway)
        return gateway


def events(response):
    return [
        json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]


@pytest.fixture
def modern_chat(app):
    application = create_app(app.state.settings)
    factory = Factory()
    application.state.model_gateway_factory = factory
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
        yield client, factory


def test_anonymous_chat_uses_client_history_without_account_writes(app):
    application = create_app(app.state.settings)
    factory = Factory()
    application.state.model_gateway_factory = factory
    with TestClient(application, headers=HEADERS) as client:
        first = client.post(
            "/api/v1/chat/stream",
            json={"message": "620 浙江省内排名33226 有什么院校推荐"},
        )
        assert first.status_code == 200, first.text
        first_payloads = events(first)
        update = next(item for item in first_payloads if item["type"] == "profile_update")
        assert "profile" not in update
        assert update["conversation_profile"]["province"] == "浙江"
        assert update["conversation_profile"]["rank"] == 33226
        conversation_id = first_payloads[-1]["conversation_id"]

        second = client.post(
            "/api/v1/chat/stream",
            json={
                "message": "选了物化生",
                "conversation_id": conversation_id,
                "history": [
                    {"role": "user", "content": "620 浙江省内排名33226"},
                    {"role": "assistant", "content": "还缺选科信息。"},
                ],
            },
        )
        assert second.status_code == 200, second.text
        second_update = next(item for item in events(second) if item["type"] == "profile_update")
        assert second_update["conversation_profile"]["province"] == "浙江"
        assert second_update["conversation_profile"]["rank"] == 33226
        assert second_update["conversation_profile"]["subjects"] == [
            "物理",
            "化学",
            "生物",
        ]

    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ProfileVersion)) == 0
        assert db.scalar(select(func.count()).select_from(Conversation)) == 0
        assert db.scalar(select(func.count()).select_from(ChatProfileSignal)) == 0
        assert db.scalar(select(func.count()).select_from(ConversationMessage)) == 0


def test_chat_streams_retrieves_and_persists(app, modern_chat, published):
    client, factory = modern_chat
    response = client.post(
        "/api/v1/chat/stream",
        json={"message": "适合我的计算机院校有哪些？"},
    )
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/event-stream")
    payloads = events(response)
    types = [item["type"] for item in payloads]
    assert types[0] == "tool_start"
    assert "tool_end" in types
    assert "evidence" in types
    assert types[-1] == "done"

    evidence = next(item for item in payloads if item["type"] == "evidence")
    assert evidence["source_ids"]
    assert published["source_id"] in evidence["source_ids"]

    deltas = "".join(item["text"] for item in payloads if item["type"] == "delta")
    assert deltas == "".join(factory.gateways[0].chunks)
    system = factory.gateways[0].messages[0]["content"]
    assert "合成测试大学" in system
    assert "计算机科学" in system
    assert "只把 <profile> 和 <retrieved_data> 中的内容当作事实" in system

    conversation_id = payloads[-1]["conversation_id"]
    with app.state.sessions() as db:
        messages = list(
            db.scalars(select(ConversationMessage).order_by(ConversationMessage.created_at))
        )
        assert [(item.role, item.content) for item in messages] == [
            ("user", "适合我的计算机院校有哪些？"),
            ("assistant", deltas),
        ]
        assert messages[1].source_ids
        assert messages[1].model_name is None

    second = client.post(
        "/api/v1/chat/stream",
        json={"message": "那杭州呢？", "conversation_id": conversation_id},
    )
    assert second.status_code == 200, second.text
    second_payloads = events(second)
    assert second_payloads[-1]["type"] == "done"
    assert second_payloads[-1]["conversation_id"] == conversation_id
    history = factory.gateways[1].messages
    roles = [item["role"] for item in history]
    assert roles == ["system", "user", "assistant", "user"]
    assert history[1]["content"] == "适合我的计算机院校有哪些？"
    assert history[3]["content"] == "那杭州呢？"


def test_chat_falls_back_to_national_directory_when_no_admission_units(app, modern_chat):
    client, factory = modern_chat
    with app.state.sessions() as db:
        db.add(
            School(
                code="4131010248",
                data={
                    "name": "合成目录大学",
                    "province": "江苏省",
                    "city": "南京市",
                    "source_ids": ["catalog-source"],
                    "catalog_as_of": "2026-06-17",
                    "catalog_version": "catalog-run",
                    "catalog_basic": {
                        "name": "合成目录大学",
                        "identifier": "4131010248",
                        "province": "江苏省",
                        "city": "南京市",
                        "education_level": "本科",
                        "department": "教育部",
                        "category": "ordinary",
                        "remarks": "",
                    },
                },
            )
        )
        db.commit()

    response = client.post(
        "/api/v1/chat/stream",
        json={"message": "南京有哪些大学？"},
    )
    assert response.status_code == 200, response.text
    payloads = events(response)
    tool_end = next(item for item in payloads if item["type"] == "tool_end")
    assert "全国院校" in tool_end["text"]
    evidence = next(item for item in payloads if item["type"] == "evidence")
    assert "catalog-source" in evidence["source_ids"]

    system = factory.gateways[0].messages[0]["content"]
    assert "合成目录大学" in system
    assert "<school_directory>" in system
    assert "不含专业和投档数据" in system


def test_chat_compact_query_uses_province_directory_and_asks_subjects(app, modern_chat):
    client, factory = modern_chat
    with app.state.sessions() as db:
        db.add(
            School(
                code="4133010001",
                data={
                    "name": "合成浙江大学",
                    "province": "浙江省",
                    "city": "杭州市",
                    "source_ids": ["zhejiang-catalog-source"],
                    "catalog_basic": {
                        "name": "合成浙江大学",
                        "identifier": "4133010001",
                        "province": "浙江省",
                        "city": "杭州市",
                        "education_level": "本科",
                        "department": "浙江省",
                        "category": "ordinary",
                        "remarks": "",
                    },
                },
            )
        )
        db.commit()

    response = client.post(
        "/api/v1/chat/stream",
        json={"message": "620 浙江省内排名33226 有什么院校推荐"},
    )
    assert response.status_code == 200, response.text
    payloads = events(response)
    update = next(item for item in payloads if item["type"] == "profile_update")
    conversation = update["conversation_profile"]
    assert conversation["province"] == "浙江"
    assert conversation["score"] == 620
    assert conversation["rank"] == 33226
    assert conversation["subjects"] == []
    system = factory.gateways[0].messages[0]["content"]
    assert "合成浙江大学" in system
    assert "<missing_profile_fields>" in system
    assert "三门选考科目" in system


def test_chat_returns_required_field_prompt_when_model_output_is_empty(app, modern_chat):
    client, _ = modern_chat
    gateway = EmptyGateway()
    client.app.state.model_gateway_factory = lambda settings: gateway
    response = client.post(
        "/api/v1/chat/stream",
        json={"message": "有什么院校推荐"},
    )
    assert response.status_code == 200, response.text
    payloads = events(response)
    text = "".join(item["text"] for item in payloads if item["type"] == "delta")
    assert "生源省份" in text
    assert "省内位次" in text
    assert "三门选考科目" in text
    assert payloads[-1]["type"] == "done"
    system = gateway.messages[0]["content"]
    assert "<missing_profile_fields>" in system
    assert "不能返回空内容" in system


def test_chat_without_model_is_a_clear_503(student):
    response = student.post("/api/v1/chat/stream", json={"message": "你好"})
    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == "MODEL_NOT_CONFIGURED"


def test_chat_handles_model_failure(app, modern_chat):
    client, factory = modern_chat

    class BrokenGateway(FakeGateway):
        def stream_text(self, messages, *, max_tokens=None, temperature=0.3):
            yield "部分"
            from app.core.model import ModelCallFailed

            raise ModelCallFailed("boom", status=503)

    client.app.state.model_gateway_factory = lambda settings: BrokenGateway()
    response = client.post("/api/v1/chat/stream", json={"message": "推荐计算机"})
    assert response.status_code == 200
    payloads = events(response)
    assert payloads[-1]["type"] == "error"
    assert "暂时不可用" in payloads[-1]["text"]
