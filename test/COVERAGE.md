# 测试覆盖与需求映射

表格描述实际断言范围，不是代码行覆盖率或“所有功能无缺陷”的保证。后端用例使用真实 PostgreSQL；旧领域回归显式使用v0.1测试应用，`test_v04.py`、`test_login_acceptance.py`及联调用例使用默认生产v0.4。

| 需求/风险 | 可执行用例 | 验证内容 |
|---|---|---|
| 统一登录、服务端邮箱检查 | `backend/test_login_acceptance.py`、`frontend/auth.test.ts` | 多种错误邮箱422及重输成功、拒绝客户端role、双标识登录、普通用户不能审核 |
| 会话退出与请求来源 | `backend/test_login_acceptance.py` | HttpOnly/SameSite、退出后复制的Cookie也失效、缺少或错误Origin/CSRF头拒绝 |
| 注册原始证据和审批 | `backend/test_registration.py`、`backend/test_v04.py` | 身份占用、幂等、批准/驳回、并发冲突、事务回滚、原件权限、有效/无效附件和真实WebM解码 |
| 画像版本与按需补问 | `backend/test_v04.py`、`backend/test_workflow.py`、`frontend/workflow-domain.test.ts` | 画像更新/版本冲突、推荐补问新版本、缺失条件、跨账号访问 |
| 官方数据导入与追溯 | `backend/test_workflow.py`、`backend/test_v04.py` | 合成JSON/CSV、来源白名单/冲突、不可变单位、证据和院校筛选 |
| 招生自动抓取与审核 | `backend/test_crawl.py`、`frontend/crawl.test.ts` | 配置规范化/范围校验、启动触发幂等、HTTP/SSRF/大小/重定向/robots、Fake Model 链接筛选与字段抽取、XLSX 魔数识别/表头映射、证据校验、暂存不可见、审核批准/驳回/权限、Source 溯源、原文快照与 Mock 拒绝 |
| AI 领航员与模型流式对话 | `backend/test_chat.py`、`frontend/http.test.ts`、`frontend/sse.test.ts` | 未配置模型503、SSE tool/evidence/delta/done、已发布招生数据检索与来源、会话/历史持久化、模型失败降级、格式校验；CI 使用 FakeGateway，真实 DeepSeek 手工联调 |
| 领航员首轮推荐与后续补充 | `backend/test_navigator_domain.py`、`backend/test_profile_optional.py`、`frontend/navigator.test.ts`、`integration/backend-smoke.mjs` | 省份/位次/三门选科即可推荐，分数和偏好可后补；生源与意向地域分开；院校/地域/专业排序；画像版本及原推荐快照保留；真实前端访问层与 PostgreSQL 闭环 |
| 部署顺序与启动抓取 | `backend/test_deploy.py`、`backend/test_crawl.py` | 验证先迁移再启动 Worker，已有启动抓取测试覆盖幂等和无模型跳过；不代替真实 Docker 部署验收 |
| 领航员画像校准与编辑 | `backend/test_chat_profile.py`、`frontend/sse.test.ts` | 从聊天明确语句识别省份/分数/位次/选科、`profile_update` 待确认事件、确认/拒绝、画像版本递增、重复处理409、检索来源ID作为反馈、保存后可继续 PATCH 修改 |
| 推荐、任务与校验 | `backend/test_workflow.py`、`backend/test_v04.py` | 硬条件、unknown、独立结果校验、任务租约/发布、取消、反馈归属 |
| SSE协议与恢复 | `frontend/sse.test.ts`、`frontend/workflow-domain.test.ts`、后端工作流用例 | 分块/CRLF/心跳/乱序/去重、格式失败、事件读取和校验后结果 |
| 社区、草案与隐私 | `backend/test_v04.py`、`backend/test_workflow.py`、`frontend/campus.test.ts` | 私帖隔离、审核版本、编辑重审、草案来源归属、学校回声筛选 |
| 共享契约 | `frontend/contract.test.ts`、`backend/test_contract.py`、`backend/test_v04.py` | 两端副本、引用、生成漂移失败、旧响应回归、新响应Schema和路由范围 |
| 前端访问层与会话竞态 | `frontend/http.test.ts`、`frontend/mock.test.ts` | HTTP夹具、状态码、结构化错误、幂等头、DTO、切换会话、Mock完整流程；本组本身不连接数据库 |
| 真实前后端闭环 | `backend/test_live_frontend.py` → `integration/backend-smoke.mjs` | 当前api.ts经真实HTTP调用注册/审批/登录/画像/异步补问/Worker/反馈/证据/草案；统一入口不会跳过此项 |
| 导航几何与领域算法 | `frontend/domain.test.ts`、`frontend/voyage.test.ts`、`frontend/campus.test.ts` | 条件筛选、志愿排序、星图和航线边界，不等于浏览器视觉验收 |
| 数据库结构 | 统一入口调用 `src/backend/scripts/check_migrations.py` | 独立测试库 upgrade→downgrade→upgrade、模型与迁移一致性 |
| 防止误用开发库 | `backend/test_database_guard.py` | 非 `_test` PostgreSQL 和 SQLite 均在连接/迁移前拒绝，返回非零退出码 |
| 未开放功能 | `backend/test_v04.py` | M2/M3入口明确失败、案例共享保持关闭、不虚构成功 |
| 全国院校基础名录 | `backend/test_catalog.py`、`frontend/catalog.test.ts` | 普通/成人完整附件、3196所解析与模拟AI全量分析/真实数据库发布、部署启动去重、HTTPS官方镜像、差异/分页、部分批准/拒绝、模型缺失/连续重试、并发版本保护、私有原件和强类型OpenAPI |

`verify_catalog_source.py`是显式运行的只读真实官网验证，不纳入CI，不调用AI或更新数据库；结果和原件写入忽略的reports目录。实际来源截至日期与测试记录见docs/contracts/CATALOG.md。全国基础名录不表示全部分省招生资料已覆盖。

尚未覆盖：真实招生资料准确性与招生政策人工复核；正式投档结果；模型质量与向量检索；学校认证审核、长期记忆与案例共享业务；全部页面的自动浏览器操作、手机和多浏览器、麦克风实录；生产HTTPS/反向代理SSE、弱网/负载/安全渗透、备份恢复和完整可访问性。以上未实现或未验收项不能因本套测试通过而标记完成。
