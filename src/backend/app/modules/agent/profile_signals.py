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
    "year": "报考年份",
    "cities": "意向省份或城市",
    "interests": "专业偏好",
    "schools": "意向院校",
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


def extract_profile_values(message: str) -> dict:
    """Extract explicit facts, distinguishing exam province from destinations.

    Values are proposals only. Neither this parser nor the chat stream saves
    them without a separate, version-checked user confirmation.
    """
    values: dict = {}
    provinces = {
        province
        for province in PROVINCES
        if re.search(
            rf"(?:生源(?:省份)?|高考省份|省份|我(?:现在)?在|我来自|我是)\s*[:：是为]?\s*{province}"
            rf"|{province}(?:省)?(?:考生|高考)",
            message,
        )
    }
    # A compact opening such as “浙江，位次20000” is unambiguous.
    for province in PROVINCES:
        if re.match(rf"^{province}(?:省)?[，,、\s]", message):
            provinces.add(province)
    if len(provinces) == 1:
        values["province"] = next(iter(provinces))

    scores = {
        int(value)
        for value in re.findall(r"(?<!\d)([1-9]\d{2})\s*分", message)
        if 100 <= int(value) <= 900
    }
    if len(scores) == 1:
        values["score"] = next(iter(scores))

    ranks = {
        int(value.replace(",", ""))
        for value in re.findall(r"位次\s*(?:是|为|[:：])?\s*(\d[\d,]{0,8})(?![\d,万千])", message)
        if value.replace(",", "").isdigit() and 1 <= int(value.replace(",", "")) <= 5000000
    }
    if len(ranks) == 1:
        values["rank"] = next(iter(ranks))

    if re.search(r"选科|选考|选的是", message) and not re.search(
        r"(?:选科|选考)(?:不是|不选|不包含)", message
    ):
        subjects = [subject for subject in SUBJECTS if subject in message]
        if len(subjects) == 3:
            values["subjects"] = subjects
        else:
            aliases = {
                "物": "物理",
                "化": "化学",
                "生": "生物",
                "史": "历史",
                "地": "地理",
                "政": "政治",
                "技": "技术",
            }
            match = re.search(
                r"(?:选科|选考|选的是)\s*[:：是为]?\s*([物化生史地政技]{3})(?![物化生史地政技])",
                message,
            )
            if match and len(set(match[1])) == 3:
                values["subjects"] = [aliases[char] for char in match[1]]

    year = re.search(r"(?:报考年份|高考年份|报考)\s*[:：是为]?\s*(20\d{2})", message)
    if year and 2024 <= int(year[1]) <= 2035:
        values["year"] = int(year[1])
    patterns = {
        "cities": r"(?:意向省份|意向城市|地域偏好|想去的省份|想去的城市)\s*[:：是为]\s*([^。；;\n]+)",
        "interests": r"(?:专业偏好|意向专业|想学的专业)\s*[:：是为]\s*([^。；;\n]+)",
        "schools": r"(?:意向院校|理想院校|理想的院校|意向学校)\s*[:：是为]\s*([^。；;\n]+)",
    }
    for field, pattern in patterns.items():
        match = re.search(pattern, message)
        if match:
            entries = [x.strip() for x in re.split(r"[,，、]", match[1]) if x.strip()]
            if entries and all(len(x) <= 60 for x in entries):
                values[field] = list(dict.fromkeys(entries))[:30]
    # Natural destination statements must never overwrite the exam province.
    if "cities" not in values:
        destinations = []
        for clause in re.split(r"[。；;，,\n]", message):
            match = re.search(r"(?<!不)(?:想去|希望去|想在)\s*([^。；;，,\n]+)", clause)
            if match and not re.search(r"大学|学院", match[1]):
                destinations.extend(p for p in PROVINCES if p in match[1])
        if destinations:
            values["cities"] = list(dict.fromkeys(destinations))
    if "interests" not in values:
        match = re.search(
            r"(?<!不)(?:想学|想读|希望学)\s*([一-鿿A-Za-z]{2,30}?)(?:专业|[，,。；;]|$)", message
        )
        if match:
            values["interests"] = [match[1]]
    return values


def extract_profile_changes(profile: dict, message: str) -> list[dict]:
    if not profile:
        return []
    changes = []
    for field, value in extract_profile_values(message).items():
        if field == "subjects" and set(value) == set(profile.get(field) or []):
            continue
        change = _change(profile, field, value)
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
