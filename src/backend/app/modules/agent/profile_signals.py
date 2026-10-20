"""Deterministic profile-change proposals derived from chat messages.

A chat message is never allowed to silently rewrite a profile. We extract only
explicit, unambiguous facts here; the UI must ask the user to confirm before
``signals_router`` applies them. The upstream retrieved source IDs are stored
with the signal so the search context remains auditable feedback.
"""

from __future__ import annotations

import re

PROVINCES = (
    "北京",
    "天津",
    "河北",
    "山西",
    "内蒙古",
    "辽宁",
    "吉林",
    "黑龙江",
    "上海",
    "江苏",
    "浙江",
    "安徽",
    "福建",
    "江西",
    "山东",
    "河南",
    "湖北",
    "湖南",
    "广东",
    "广西",
    "海南",
    "重庆",
    "四川",
    "贵州",
    "云南",
    "西藏",
    "陕西",
    "甘肃",
    "青海",
    "宁夏",
    "新疆",
    "香港",
    "澳门",
    "台湾",
)
SUBJECTS = ("物理", "化学", "生物", "历史", "地理", "政治", "技术")
FIELD_LABELS = {
    "province": "生源省份",
    "score": "高考分数",
    "rank": "省内位次",
    "subjects": "选科",
}


def _change(profile, field, new_value) -> dict | None:
    old_value = profile.get(field)
    if old_value == new_value:
        return None
    return {
        "field": field,
        "label": FIELD_LABELS[field],
        "old": old_value,
        "new": new_value,
    }


def extract_profile_changes(profile: dict, message: str) -> list[dict]:
    if not profile:
        return []
    changes: list[dict] = []

    provinces = {province for province in PROVINCES if province in message}
    if len(provinces) == 1:
        province = next(iter(provinces))
        if province != (profile.get("province") or ""):
            change = _change(profile, "province", province)
            if change:
                changes.append(change)

    scores = {
        int(value)
        for value in re.findall(r"(?<!\d)([1-9]\d{2})\s*分", message)
        if 100 <= int(value) <= 900
    }
    if len(scores) == 1:
        score = next(iter(scores))
        change = _change(profile, "score", score)
        if change:
            changes.append(change)

    ranks = {
        int(value.replace(",", ""))
        for value in re.findall(r"位次\s*(?:是|为|[:：])?\s*([\d,]{2,9})", message)
        if value.replace(",", "").isdigit()
    }
    if len(ranks) == 1:
        change = _change(profile, "rank", next(iter(ranks)))
        if change:
            changes.append(change)

    if re.search(r"选科|选考|选的是", message):
        subjects = [subject for subject in SUBJECTS if subject in message]
        if len(subjects) == 3 and set(subjects) != set(profile.get("subjects") or []):
            change = _change(profile, "subjects", subjects)
            if change:
                changes.append(change)

    order = {field: index for index, field in enumerate(FIELD_LABELS)}
    return sorted(changes, key=lambda item: order.get(item["field"], 99))


def signal_question(changes: list[dict]) -> str:
    parts = []
    for change in changes:
        old = "未填写" if change.get("old") in (None, "", []) else change["old"]
        new = change.get("new")
        parts.append(f"{change['label']} {old} → {new}")
    return "我注意到你这次提到：" + "；".join(parts) + "。要现在更新考生画像吗？"


def signal_view(signal) -> dict:
    return {
        "signal_id": str(signal.id),
        "conversation_id": str(signal.conversation_id),
        "changes": signal.changes or [],
        "source_ids": signal.source_ids or [],
        "question": signal_question(signal.changes or []),
        "status": signal.status,
        "query_text": signal.query_text,
    }
