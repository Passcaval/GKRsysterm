# 联网招生知识库

具体招生信息不再依赖旧页面爬虫先产出完整招生行。DeepSeek Search 找到官方页面，Fetch 补读缺少的正文，领航员基于正文回答并提供原始出处。全国院校名录仍提供基础院校身份；旧省级页面爬虫默认关闭。搜索摘要、模型记忆不能替代招生计划、学费、选科或投档数据。

## 启动与查询

- 配置同一组 `MODEL_BASE_URL=https://api.deepseek.com/v1`、`MODEL_API_KEY`、`MODEL_NAME=deepseek-flash`。只有官方 DeepSeek 主机配置才启用此联网实现，不向其他模型供应商或搜索网站发送 Key。
- `ADMISSION_KNOWLEDGE_ENABLED=true`、`ADMISSION_KNOWLEDGE_AUTO_SYNC=true` 时，`crawl-worker` 创建持久化 `knowledge_sync` Job，预热六类 2026 浙江招生查询，每小时检查缓存是否到期。最近一次启动任务 24 小时内不会因重启反复创建；管理员可手动重试失败任务。可通过 `ADMISSION_KNOWLEDGE_TTL_HOURS` 调整为 1–168 小时。
- 领航员根据问题和对话信息生成有长度上限的招生查询，使用新鲜缓存或按需联网。问候不搜索；查询不含邮箱、长电话号码或位次等长数字，保留明确年份。默认每次 Search 最多 5 条、必要时最多补读 2 页；单次请求默认超时 20 秒，可设置 `ADMISSION_KNOWLEDGE_RESULTS`（1–8）和 `ADMISSION_KNOWLEDGE_TIMEOUT_SECONDS`（1–60）。
- 仅接受 HTTPS 官方教育/政府域名及学信网、浙江考试院域名。拒绝凭据 URL、IP、非常规端口和伪装域名。只保存实际正文，网页不可读时不会将模型摘要当作证据。
- 页面内容、来源 URL、发布时间（未知保留为空）、获取时间和哈希作为不可变 `Source` 快照保存，24 小时缓存复用；到期后创建新快照。未取得资料或服务失败时，SSE 结束联网工具状态并继续已有资料回答，不宣称联网成功。
- 搜索服务及模型回答均可能产生费用；同步查询数量和正文长度均有限制，不会在部署时对全国每所院校逐一无限查询。

## 前后端接口

保留原有共享 v0.4 的 50 个操作。新增两个后端管理接口，实际 Schema 见 `backend-openapi.json`：

| 请求 | 权限 / 行为 | 返回 data |
| --- | --- | --- |
| `GET /api/v1/admin/admission-knowledge` | 管理员；不返回 Key 或环境变量 | `enabled, configured, source_count, ttl_hours, latest_job` |
| `POST /api/v1/admin/admission-knowledge/sync` | 管理员、CSRF、限流；JSON `{}`，必须带 `Idempotency-Key` | HTTP 202；`id, status`；存在排队/运行中的任务时复用 |

`latest_job` 可为空，否则含 `id, status, error, created_at`。Job 状态为 queued/running/succeeded/failed；错误只包含代码。前端访问层转换为 camelCase，管理页显示快照数量、缓存时长、任务状态和刷新按钮；演示模式不访问搜索服务。

`POST /api/v1/chat/stream` 沿用原有 SSE：新增工具名 `web_search`，继续使用 `tool_start/tool_end/evidence/delta/done`。证据 ID 可通过既有 `GET /api/v1/evidence/{id}` 查询，状态仍为 `unverified`，不对外返回内部检索指纹或完整缓存正文。答复中的数值须能在引用正文中找到，并区分生源省份、年份、批次；不能将历年分数说成当年数据或录取概率。

## 数据边界

知识库是有出处的网页资料，不会自动创建 `AdmissionUnit`、覆盖专业/分数、发布招生计划或扩展正式推荐规则。正式结构化推荐和投档模拟继续使用经审核的数据，当前规则范围仍为浙江 2026 普通类。模型自身知识可用于解释一般概念，未知招生事实保持未知。

复用既有 `Source` 与 `Job` 表，无新增数据库迁移。对旧部署仍须执行仓库已有迁移，先备份数据库、上传文件及环境配置，保持密钥和数据库密码稳定。升级现有服务时不要在未获授权的情况下执行画像清空命令。

DeepSeek 接口依据：[Search](https://api-docs.deepseek.com/api/search/)、[Fetch](https://api-docs.deepseek.com/api/fetch/)，2026-10-22 核查。
