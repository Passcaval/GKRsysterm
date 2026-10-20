from app.core.errors import DomainError


def validate_result(snapshot, result):
    """Validate publication boundaries independently of ranking scores."""
    units = {unit["id"]: unit for unit in snapshot["units"]}
    profile = snapshot["profile"]
    subjects = profile.get("subjects") or []
    preferences = profile.get("preferences") or []
    valid_ids = set()
    for group in ("items", "pending_confirmation", "excluded"):
        for item in result[group]:
            valid_ids.add(item["recommendation_item_id"])
            unit = units.get(item["admission_unit_id"])
            if (
                not unit
                or item["school_id"] != unit["school_id"]
                or item["evidence_ids"] != [unit["source_id"]]
            ):
                raise DomainError(422, "RESULT_REJECTED", "候选或来源与冻结数据不一致。")
            if group == "items" and (
                item["eligibility"]["status"] != "pass"
                or len(subjects) != 3
                or profile.get("budget_scope") == "total"
                or any(p.get("strength") == "hard" for p in preferences)
                or unit["required_subjects"] is None
                or not set(unit["required_subjects"]).issubset(subjects)
                or unit["tuition"] is None
                or profile.get("budget") is None
                or unit["tuition"] > profile.get("budget")
                or not unit["campus"]
                or unit["additional_requirements"]
                or profile.get("batch") != unit["batch"]
                or profile.get("province") != unit["province_code"]
                or profile.get("year") != unit["exam_year"]
            ):
                raise DomainError(422, "RESULT_REJECTED", "未满足的硬条件不能作为合格候选发布。")
    for branch in result.get("branches", []):
        if any(item_id not in valid_ids for item_id in branch.get("item_ids", [])):
            raise DomainError(422, "RESULT_REJECTED", "分支引用了未发布的候选。")
    return {
        "status": "pass",
        "checks": ["候选及来源属于冻结数据", "硬条件失败项不进入候选", "未知项单列"],
        "version": "m1-validator-v1",
    }
