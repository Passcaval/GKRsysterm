"""Add wire-level envelopes, legacy responses and manually parsed multipart contracts."""

import json
import re
from copy import deepcopy
from pathlib import Path

from fastapi.openapi.utils import get_openapi


def envelope(data):
    return {
        "type": "object",
        "required": ["data", "requestId"],
        "additionalProperties": False,
        "properties": {"data": data, "requestId": {"type": "string"}},
    }


def response(schema, description="成功"):
    return {"description": description, "content": {"application/json": {"schema": schema}}}


def install_contract(app):
    def build():
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(title=app.title, version=app.version, routes=app.routes)
        legacy = json.loads(
            (Path(__file__).resolve().parents[4] / "docs/contracts/openapi.json").read_text(
                encoding="utf-8"
            )
        )
        schema["components"]["schemas"].update(deepcopy(legacy["components"]["schemas"]))
        schema["components"]["securitySchemes"] = {
            "CookieSession": {"type": "apiKey", "in": "cookie", "name": "nv_session"}
        }
        legacy_paths = {
            re.sub(r"\{[^}]+\}", "{}", "/api/v1" + p): v for p, v in legacy["paths"].items()
        }
        public = {
            "/health",
            "/api/v1/bootstrap",
            "/api/v1/auth/login",
            "/api/v1/auth/logout",
            "/api/v1/registration-applications",
            "/api/v1/registration-applications/{application_id}",
        }
        for path, methods in schema["paths"].items():
            old = legacy_paths.get(re.sub(r"\{[^}]+\}", "{}", path), {})
            for method, operation in methods.items():
                operation["security"] = (
                    []
                    if path in public
                    or path.startswith(
                        ("/api/v1/schools", "/api/v1/admission-units", "/api/v1/sources")
                    )
                    else [{"CookieSession": []}]
                )
                for code in list(operation["responses"]):
                    if code.startswith("2"):
                        operation["responses"][code] = response(
                            envelope({}), "成功；新增业务响应字段见 BACKEND.md"
                        )
                if method in old:
                    operation["responses"].update(deepcopy(old[method]["responses"]))
                for code in ("400", "401", "403", "404", "409", "413", "415", "422", "429", "500"):
                    operation["responses"][code] = response(
                        {"$ref": "#/components/schemas/Error"}, "结构化错误；不得回传敏感输入"
                    )
                if method not in {"get", "head", "options"}:
                    operation.setdefault("parameters", []).extend(
                        [
                            {
                                "name": "Origin",
                                "in": "header",
                                "required": True,
                                "schema": {"type": "string"},
                            },
                            {
                                "name": "X-Requested-With",
                                "in": "header",
                                "required": True,
                                "schema": {"type": "string", "const": "NightVoyage"},
                            },
                        ]
                    )
        schema["paths"]["/api/v1/recommendations"]["post"]["responses"]["202"] = response(
            envelope({"$ref": "#/components/schemas/RunView"}),
            "question 请求创建持久任务；旧 riskPreference 请求仍返回 200 数组",
        )
        schema["components"]["schemas"]["RunView"] = {
            "type": "object",
            "required": [
                "run_id",
                "status",
                "profile_version_id",
                "result",
                "last_event_id",
                "questions",
            ],
            "properties": {
                "run_id": {"type": "string", "format": "uuid"},
                "status": {
                    "enum": [
                        "queued",
                        "running",
                        "waiting_input",
                        "validating",
                        "succeeded",
                        "failed",
                        "cancelled",
                    ]
                },
                "profile_version_id": {"type": ["string", "null"]},
                "result": {"type": ["object", "null"]},
                "last_event_id": {"type": "integer"},
                "questions": {"type": "array", "items": {"type": "string"}},
            },
        }
        for path, methods in schema["paths"].items():
            if path.endswith("/audio"):
                methods["get"]["responses"]["200"] = {
                    "description": "经鉴权的原始语音",
                    "content": {"audio/wav": {"schema": {"type": "string", "format": "binary"}}},
                }
            if path.endswith("/events") or path == "/api/v1/chat/stream":
                next(iter(methods.values()))["responses"]["200"] = {
                    "description": "SSE，详见 BACKEND.md 的事件协议",
                    "content": {"text/event-stream": {"schema": {"type": "string"}}},
                }
        forms = {
            "/api/v1/registration-applications": (
                ["nickname", "email", "password"],
                {
                    "nickname": {"type": "string"},
                    "email": {"type": "string"},
                    "password": {"type": "string", "writeOnly": True},
                    "evidence_text": {"type": "string"},
                    "evidence_audio": {"type": "string", "format": "binary"},
                },
            ),
            "/api/v1/admin/imports/csv": (
                ["metadata", "file"],
                {
                    "metadata": {"type": "string", "description": "ImportInput 除 rows 外的 JSON"},
                    "file": {"type": "string", "format": "binary"},
                },
            ),
            "/api/v1/verifications": (
                ["schoolId", "document"],
                {
                    "schoolId": {"type": "string", "format": "uuid"},
                    "document": {"type": "string", "format": "binary"},
                },
            ),
        }
        for path, (required, properties) in forms.items():
            schema["paths"][path]["post"]["requestBody"] = {
                "required": True,
                "content": {
                    "multipart/form-data": {
                        "schema": {
                            "type": "object",
                            "required": required,
                            "properties": properties,
                            "additionalProperties": False,
                        }
                    }
                },
            }
        schema["info"]["description"] = (
            "M0–M1 实际后端路由；旧17项响应与共享前端契约一致。新增响应部分为开放对象，详细字段、边界及示例见 docs/contracts/BACKEND.md。"
        )
        app.openapi_schema = schema
        return schema

    app.openapi = build
