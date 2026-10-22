import json
from uuid import uuid4

from conftest import HEADERS
from fastapi.testclient import TestClient
from sqlalchemy import func, select

from app.db.models import AdmissionUnit, Conversation, ProfileVersion, School, Source
from app.main import create_app
from app.modules.admissions import atlas


def test_public_atlas_uses_default_rank_and_changes_order_without_login(app, modern, monkeypatch):
    names = ["合成甲大学", "合成乙大学", "合成丙大学"]
    with app.state.sessions.begin() as db:
        for i, name in enumerate(names):
            db.add(
                School(
                    code="atlas-" + str(i),
                    data={
                        "name": name,
                        "short": name,
                        "city": "杭州市" if i < 2 else "南京市",
                        "province": "浙江省" if i < 2 else "江苏省",
                    },
                )
            )
    facts = [
        {
            "school_name": name,
            "rank": rank,
            "year": 2026,
            "major": "计算机科学与技术",
            "province": "浙江",
            "source_id": str(uuid4()),
            "required_subjects": ["物理"],
        }
        for name, rank in zip(names, [7500, 11000, 8200])
    ]
    monkeypatch.setattr(atlas, "table_facts", lambda *args: facts)
    response = modern.post("/api/v1/atlas/search", json={"cities": ["杭州"], "majors": ["计算机"]})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["basis"]["rank"] == 8000
    assert [s["name"] for s in data["items"]] == names[:2]
    data = modern.post(
        "/api/v1/atlas/search", json={"rank": 12000, "cities": ["杭州"], "majors": ["计算机"]}
    ).json()["data"]
    assert [s["name"] for s in data["items"]] == [names[1], names[0]]
    data = modern.post(
        "/api/v1/atlas/search", json={"cities": ["南京"], "majors": ["计算机"]}
    ).json()["data"]
    assert [s["name"] for s in data["items"]] == [names[2]]
    data = modern.post("/api/v1/atlas/search", json={"majors": ["临床医学"]}).json()["data"]
    assert data["items"] == []
    data = modern.post("/api/v1/atlas/search", json={"subjects": ["历史", "政治", "地理"]}).json()[
        "data"
    ]
    assert data["items"] == []
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(AdmissionUnit)) == 0
        assert db.scalar(select(func.count()).select_from(ProfileVersion)) == 0


def test_rank_facts_reject_other_province_and_numbers_without_evidence():
    source = Source(
        id=uuid4(),
        content_hash="a" * 64,
        data={
            "title": "合成甲大学2026年浙江普通类录取",
            "body": "2026年浙江普通类 合成甲大学 计算机科学与技术 最低位次7500 选考物理",
        },
    )
    context = atlas.AtlasQuery(majors=["计算机"])
    good = {
        "school_name": "合成甲大学",
        "major": "计算机科学与技术",
        "year": 2026,
        "rank": 7500,
        "province": "浙江",
        "source_id": str(source.id),
        "quote": source.data["body"],
        "required_subjects": ["物理"],
    }
    assert len(atlas.verified_facts([good], [source], [{"name": "合成甲大学"}], context)) == 1
    assert not atlas.verified_facts(
        [{**good, "rank": 8000}], [source], [{"name": "合成甲大学"}], context
    )
    assert not atlas.verified_facts(
        [{**good, "province": "江苏"}], [source], [{"name": "合成甲大学"}], context
    )
    assert not atlas.verified_facts(
        [{**good, "school_name": []}], [source], [{"name": "合成甲大学"}], context
    )
    # "浙江" in an institution name is not proof of the student's province.
    source.data = {
        "title": "某省录取表",
        "body": "2026年 浙江合成大学 计算机科学与技术 最低位次7500",
    }
    bad = {**good, "school_name": "浙江合成大学", "quote": source.data["body"]}
    assert not atlas.verified_facts([bad], [source], [{"name": "浙江合成大学"}], context)


def test_anonymous_context_survives_history_window_and_updates_new_rank(app):
    class Gateway:
        def __init__(self, settings):
            self.messages = []

        def stream_text(self, messages, **kwargs):
            self.messages = messages
            yield "合成回答"

        def close(self):
            pass

    application = create_app(app.state.settings)
    gateways = []

    def factory(settings):
        gateway = Gateway(settings)
        gateways.append(gateway)
        return gateway

    application.state.model_gateway_factory = factory
    with TestClient(application, headers=HEADERS) as client:
        response = client.post(
            "/api/v1/chat/stream",
            json={
                "message": "我的位次改为12000",
                "profile_context": {
                    "province": "浙江",
                    "year": 2026,
                    "rank": 8000,
                    "subjects": ["物理", "化学", "生物"],
                    "cities": ["杭州"],
                    "interests": ["计算机"],
                },
                "history": [{"role": "user", "content": "最早位次是30000"}],
            },
        )
        assert response.status_code == 200, response.text
        events = [
            json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
        ]
        profile = next(v for v in events if v["type"] == "profile_update")["conversation_profile"]
        assert profile["rank"] == 12000 and profile["cities"] == ["杭州"]
        assert profile["subjects"] == ["物理", "化学", "生物"]
        assert "计算机" in gateways[0].messages[0]["content"]
    with app.state.sessions() as db:
        assert db.scalar(select(func.count()).select_from(ProfileVersion)) == 0
        assert db.scalar(select(func.count()).select_from(Conversation)) == 0
    application.state.engine.dispose()


def test_natural_city_major_updates_do_not_change_exam_province():
    from app.modules.agent.profile_signals import extract_profile_values

    values = extract_profile_values("浙江，位次8000，选科物化生，想在杭州读计算机")
    assert values["province"] == "浙江"
    assert values["cities"] == ["杭州"] and values["interests"] == ["计算机"]
    assert values["rank"] == 8000 and len(values["subjects"]) == 3
    values = extract_profile_values("我的位次改为12000，想去南京读临床医学")
    assert values["rank"] == 12000 and values["cities"] == ["南京"]
    assert values["interests"] == ["临床医学"] and "province" not in values
    assert extract_profile_values("城市不限，专业不限")["cities"] == []
    assert "cities" not in extract_profile_values("不想在杭州读计算机")
