from app.core.errors import DomainError


def validate_result(snapshot, result):
    """Validate publication boundaries independently of ranking scores."""
    units = {unit["id"]: unit for unit in snapshot["units"]}
    profile = snapshot["profile"]
    for group in ("items", "pending_confirmation", "excluded"):
        for item in result[group]:
            unit = units.get(item["admission_unit_id"])
            if (
                not unit
                or item["school_id"] != unit["school_id"]
                or item["evidence_ids"] != [unit["source_id"]]
            ):
                raise DomainError(422, "RESULT_REJECTED", "候选或来源与冻结数据不一致。")
            if group == "items" and (
                item["eligibility"]["status"] != "pass"
                or unit["required_subjects"] is None
                or not set(unit["required_subjects"]).issubset(profile["subjects"])
                or unit["tuition"] is None
                or unit["tuition"] > profile["budget"]
                or not unit["campus"]
                or unit["additional_requirements"]
                or profile.get("batch") != unit["batch"]
                or profile["province"] != unit["province_code"]
                or profile["year"] != unit["exam_year"]
            ):
                raise DomainError(422, "RESULT_REJECTED", "未满足的硬条件不能作为合格候选发布。")
    return {
        "status": "pass",
        "checks": ["候选及来源属于冻结数据", "硬条件失败项不进入候选", "未知项单列"],
        "version": "m1-validator-v1",
    }
