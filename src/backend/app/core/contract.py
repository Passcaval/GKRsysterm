"""The frontend contract is the public wire contract; backend-only operations are additive."""

import json
from copy import deepcopy
from pathlib import Path

from fastapi.openapi.utils import get_openapi


def install_contract(app):
    def build():
        if app.openapi_schema:
            return app.openapi_schema
        document = get_openapi(title=app.title, version="0.4.0", routes=app.routes)
        shared = json.loads(
            (Path(__file__).resolve().parents[4] / "docs/contracts/openapi.json").read_text(
                encoding="utf-8"
            )
        )
        document.setdefault("components", {}).setdefault("schemas", {}).update(
            deepcopy(shared["components"]["schemas"])
        )
        document["components"]["securitySchemes"] = deepcopy(
            shared["components"]["securitySchemes"]
        )
        for path, operations in document["paths"].items():
            proposed = shared["paths"].get(path.removeprefix("/api/v1"), {})
            for method, operation in operations.items():
                if method in proposed:
                    operation.update(deepcopy(proposed[method]))
                else:
                    if path.startswith("/api/v1/admin/school-catalog"):
                        operation["security"] = [{"session": []}]
                        if method not in {"get", "head", "options"}:
                            operation.setdefault("parameters", []).append(
                                {
                                    "in": "header",
                                    "name": "X-Requested-With",
                                    "required": True,
                                    "schema": {"type": "string", "enum": ["NightVoyage"]},
                                }
                            )
                    for code in operation["responses"]:
                        if (
                            path.startswith("/api/v1/admin/school-catalog")
                            and code.startswith("2")
                            and "application/octet-stream"
                            in operation["responses"][code].get("content", {})
                        ):
                            continue
                        if (
                            path.startswith("/api/v1/admin/school-catalog")
                            and code.startswith("2")
                            and "$ref"
                            in operation["responses"][code]
                            .get("content", {})
                            .get("application/json", {})
                            .get("schema", {})
                        ):
                            continue
                        schema = (
                            {"$ref": "#/components/schemas/Error"}
                            if code.startswith(("4", "5"))
                            else {
                                "type": "object",
                                "required": ["data", "request_id"],
                                "properties": {"data": {}, "request_id": {"type": "string"}},
                            }
                        )
                        operation["responses"][code] = {
                            "description": "后台接口，字段见 BACKEND.md",
                            "content": {"application/json": {"schema": schema}},
                        }
                if method not in {"get", "head", "options"}:
                    operation.setdefault("parameters", []).append(
                        {
                            "in": "header",
                            "name": "Origin",
                            "required": True,
                            "schema": {"type": "string"},
                        }
                    )
        document["info"]["description"] = (
            "M0–M1实际API，采用v0.4共享DTO；M2–M4未开放功能明确返回FEATURE_NOT_AVAILABLE。后台导入接口为新增操作。"
        )
        app.openapi_schema = document
        return document

    app.openapi = build
