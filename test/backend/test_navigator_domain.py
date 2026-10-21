"""Deterministic navigator behaviour; no model or database is needed."""

from copy import deepcopy

from app.modules.agent.profile_signals import extract_profile_changes, extract_profile_values
from app.modules.agent.service import build_messages
from app.modules.profiles.service import recommendation_missing
from app.modules.protocol.service import internal_profile, required_questions
from app.modules.recommendation.service import evaluate_snapshot


def minimal():
    return {
        "province": "浙江",
        "year": 2026,
        "rank": 20000,
        "score": None,
        "subjects": ["物理", "化学", "生物"],
        "consent": True,
        "cities": [],
        "interests": [],
        "schools": [],
        "budget": None,
    }


def unit(identifier, *, major="计算机科学", school="合成大学", province="江苏", subjects=None):
    return {
        "id": identifier,
        "school_id": identifier + "-school",
        "source_id": identifier + "-source",
        "school_name": school,
        "school_province": province,
        "city": "合成市",
        "dataset_version": "synthetic-v1",
        "province_code": "浙江",
        "exam_year": 2026,
        "exam_category": "普通类",
        "required_subjects": subjects or ["物理"],
        "tuition": 6000,
        "campus": "测试校区",
        "batch": "普通类",
        "major": major,
        "plan_count": 10,
        "history": [],
        "additional_requirements": [],
    }


def test_minimum_requires_rank_and_subjects_but_never_optional_preferences():
    profile = minimal()
    assert recommendation_missing(profile) == []
    assert required_questions({"profile": profile}) == []
    profile["subjects"] = []
    assert [field for field, _ in recommendation_missing(profile)] == ["subjects"]
    profile["subjects"] = ["物理", "化学", "生物"]
    profile["rank"] = None
    assert [field for field, _ in recommendation_missing(profile)] == ["rank"]


def test_exam_province_and_destination_are_distinct_and_preferences_remain_proposals():
    profile = minimal()
    before = deepcopy(profile)
    changes = extract_profile_changes(profile, "我想去江苏，想学计算机专业。意向院校：合成大学")
    values = {entry["field"]: entry["new"] for entry in changes}
    assert values == {"cities": ["江苏"], "interests": ["计算机"], "schools": ["合成大学"]}
    assert profile == before
    assert extract_profile_changes(profile, "江苏的计算机专业怎么样？") == []
    assert extract_profile_changes(profile, "不想去江苏，不想学计算机专业") == []
    assert extract_profile_values("位次2万") == {}
    assert extract_profile_values("位次1") == {"rank": 1}
    assert extract_profile_values("我是浙江考生，位次20000，选科物化生") == {
        "province": "浙江",
        "rank": 20000,
        "subjects": ["物理", "化学", "生物"],
    }


def test_preferences_change_order_without_promoting_subject_failures_or_mutating_old_snapshot():
    profile = minimal()
    rows = [
        unit("a", major="法学", school="另一大学", province="安徽"),
        unit("b", school="合成大学"),
        unit("c", subjects=["历史"]),
    ]
    snapshot = {"profile": profile, "units": rows}
    old = deepcopy(snapshot)
    initial = evaluate_snapshot(snapshot)
    assert initial["validation"]["status"] == "pass"
    assert len(initial["branches"]) == 3
    assert {row["field"] for row in initial["missing_info"]} >= {
        "score",
        "schools",
        "cities",
        "interests",
    }
    updated = deepcopy(snapshot)
    updated["profile"].update(cities=["江苏"], schools=["合成大学"], interests=["计算机"])
    final = evaluate_snapshot(updated)
    assert final["pending_confirmation"][0]["admission_unit_id"] == "b"
    assert final["pending_confirmation"][0]["preference_match"]["score"] == 1
    assert [row["admission_unit_id"] for row in final["excluded"]] == ["c"]
    assert snapshot == old


def test_wire_dto_round_trips_optional_schools_and_null_score():
    value = internal_profile(
        {
            "province_code": "浙江",
            "rank": 20000,
            "subjects": ["物理", "化学", "技术"],
            "score": None,
            "consent": True,
            "preferred_regions": ["江苏"],
            "preferred_schools": ["合成大学"],
        }
    )
    assert value.score is None and value.schools == ["合成大学"]
    assert recommendation_missing(value.model_dump()) == []
    prompt = build_messages(value.model_dump(), "合成资料", [], "先推荐几个方向")[0]["content"]
    assert "分数、意向省份/城市、意向院校、专业及预算均可后补" in prompt


def test_chat_prompt_prefers_conversation_over_template_sections():
    prompt = build_messages(None, "合成资料", [], "你好")[0]["content"]
    assert "不要用“先给结论”“下一步建议”" in prompt
    assert "也不要给自己加小标题" in prompt
    assert "最多只问一个最关键的问题" in prompt
    assert "不要每段都列点" in prompt
