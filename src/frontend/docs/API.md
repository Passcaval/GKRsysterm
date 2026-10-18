# 前后端接口对接规范

共享规范统一维护在[仓库 docs/contracts/API.md](../../../docs/contracts/API.md)。

[共享 OpenAPI](../../../docs/contracts/openapi.json)由本前端的 `scripts/contract.mjs` 生成，同时生成本目录的兼容副本；执行 `pnpm run contract:check` 检查一致性。

当前约定描述已实现的前端接口，并非完整后端实现。目标规范与差距见[技术方案](../../../docs/技术方案.md)第十二至十四章。
