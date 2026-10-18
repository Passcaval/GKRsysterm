from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError


class DomainError(Exception):
    def __init__(self, status: int, code: str, message: str, field: str | None = None):
        self.status, self.code, self.message, self.field = status, code, message, field


def error_response(request: Request, status: int, code: str, message: str, details=None):
    return JSONResponse(
        status_code=status,
        content={
            "error": {"code": code, "message": message, "details": details or []},
            "requestId": getattr(request.state, "request_id", "unknown"),
        },
    )


def install_handlers(app):
    @app.exception_handler(DomainError)
    async def domain_error(request, exc):
        details = [{"field": exc.field, "message": exc.message}] if exc.field else []
        return error_response(request, exc.status, exc.code, exc.message, details)

    @app.exception_handler(RequestValidationError)
    async def invalid(request, exc):
        # Pydantic errors can contain the raw password/input; never serialize them.
        fields = [
            {
                "field": ".".join(str(x) for x in e["loc"][1:]),
                "message": "字段类型、范围或格式不正确",
            }
            for e in exc.errors()
        ]
        return error_response(request, 422, "INVALID_INPUT", "输入不符合要求，请重新输入。", fields)

    @app.exception_handler(IntegrityError)
    async def conflict(request, exc):
        return error_response(request, 409, "CONFLICT", "数据已更新或标识已被占用，请检查后重试。")

    @app.exception_handler(Exception)
    async def internal(request, exc):
        # No raw exception/body in client response: DB exceptions may include parameters.
        return error_response(request, 500, "INTERNAL_ERROR", "服务暂时无法处理请求，请稍后重试。")


def result(request: Request, data):
    return {"data": data, "requestId": request.state.request_id}


def missing():
    raise DomainError(404, "RESOURCE_NOT_FOUND", "资源不存在或无权访问。")
