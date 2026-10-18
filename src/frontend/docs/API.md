# 前后端接口对接规范 v0.4

统一维护在[共享接口规范](../../../docs/contracts/API.md)，机器契约见[OpenAPI](openapi.json)。50个HTTP操作、48个Schema覆盖注册申请与独立审批、统一登录、版本画像、异步任务及恢复、证据、反馈、招生单位与个人授权。新规范整体采用snake_case和request_id；旧v0.1成功DTO不可直接使用。

运行 `pnpm run contract` 同时生成两份相同OpenAPI；`pnpm run contract:check`无写入地检查产物一致性。迁移说明见[技术方案对齐记录](TECHNICAL-ALIGNMENT.md)。本仓库没有真实后端，生产联调尚待双方完成。
