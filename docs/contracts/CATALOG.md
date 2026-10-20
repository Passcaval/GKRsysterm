# 全国院校基础资料同步与管理员审核

本功能处理教育部公布的全国高等学校完整名录，包含普通和成人高校，不依赖浙江招生计划是否存在。教育部该名单未包含港澳台高校。基础字段为学校名称、10位学校标识码、主管部门、省份、所在地（原件未提供时“待核对”）、办学层次、普通/成人类别和备注；不据此生成专业、排名、学费或录取判断。分省招生计划继续由原招生模块独立管理。

## 部署与自动抓取

`config/school_catalog.json` 是全国名录来源和策略配置。默认 enabled/auto_start=true，首次部署时 crawl-worker 自动建立任务；即使已有浙江院校/招生记录也不跳过全国名录。相同配置已有任务时不反复入队，已有待处理任务由启动与管理员触发共同复用。失败后可在管理端重新抓取；修改来源配置也会产生新指纹。需要停止自动同步时设置 auto_start=false（仍允许管理员抓取），完全关闭则设置 enabled=false。

Compose 的 migrate 一次性服务先执行 Alembic upgrade head，API、普通Worker和抓取Worker等待其成功后启动，避免全新数据库启动时任务表不存在。crawl-worker 消费 crawl、catalog_fetch、catalog_analyze；普通Worker处理原导入和推荐。部署命令仍为 `python deploy/manage.py init`，升级为 `python deploy/manage.py up`。本次新增迁移 `c3e4f5a6b7d8`，保留全部既有迁移。

全国名录会先抓取并暂存完整原件。配置了MODEL_BASE_URL/MODEL_API_KEY/MODEL_NAME时自动逐批进行AI分析；没有模型时保留抓取结果为analysis_pending，管理端提示配置模型后重新分析，禁止直接发布。`config/admission_sources.json` 中旧浙江抓取的auto_start默认改为false，可由管理员另行触发，避免把局部招生抓取当作全国资料初始化。

## 来源与完整性

优先从教育部索引发现新年度公告；索引不可用时使用配置中的公告及教育部官方备用发布页。默认备用是“中国大学生在线”的同一教育部公告。显示实际名录截至日期，管理员须核对是否为所需版本；已有正式资料的截至日期晚于本次快照时拒绝覆盖。

普通和成人两份XLS/XLSX都必须成功读取，按真实表头解析所有工作表，逐类数量须等于官方公告，合计和标识码唯一性也须通过检查。另设最低数量防止误认局部样本。存在缺附件、重复标识码、关键字段缺失、行数不符或解析限制时整体失败，不能截断后作为全量发布。XLSX有解压体积限制。抓取HTTPS域名和每次重定向均执行白名单/公网地址验证，响应有超时与体积上限。

教育部主站部分入口可能403或将附件HTTPS重定向为HTTP；客户端拒绝降级，通过显式配置的教育部hudong HTTPS镜像读取相同路径的官方附件。镜像仍执行相同域名和地址校验，保存实际URL，不将任意第三方转载当作来源。官方原件保存在私有目录，SHA-256、公告URL和截至日期随任务保留；下载接口仅管理员可用。

## AI分析与人工更新

状态：queued → fetching → analysis_pending/analyzing → awaiting_review → published/rejected；来源失败进入failed。逐批分析默认100所，全部候选都提交分析，按批保存进度和模型用量；未完成全量分析不可批准。AI只返回summary/warnings，不允许生成或修改官方院校字段。失败保留原件与资料，可重新分析，无须重新下载；每次分析任务使用新的版本，支持连续重试。

按学校标识码匹配正式记录；已有省级代码时只在名称唯一且身份不冲突时关联原ID。反向顺序也受支持：先发布全国名录、后导入省级招生资料时，正式导入和抓取审核预检共用身份解析，复用同一学校ID。歧义和多个候选记为conflict，不自动合并。管理端显示新增、变更、未变化及冲突数量，支持搜索、筛选、分页、逐字段前后对比、AI意见和原始快照。管理员必须填写审核说明、确认核对材料，再选择更新全部新增/变更或仅勾选院校；也可拒绝本次更新。

发布采用一笔数据库事务，保留原学校ID和省级代码、招生单位、收藏等引用，基础资料更新记入school_catalog_revisions（before/after、来源、任务）。审核期间资料发生变化返回409，避免覆盖另一开发者/管理员的新数据。拒绝、AI失败、网络失败均不更新正式学校；未选中和未出现在新名单中的旧学校不会被删除。本次选择部分院校后任务结束，其余保持原样，下一次抓取再比较。没有变更时可拒绝本次更新并填写“无需更新”等说明。

## 接口（均为管理员，前缀 /api/v1/admin/school-catalog）

| 方法与路径 | 行为 |
|---|---|
| GET /config | 来源、范围、自动启动与模型配置状态，无密钥 |
| GET /runs?offset=0 | 任务历史，20条/页，next_offset |
| POST /runs | 创建/复用待处理的全量抓取，202、Idempotency-Key |
| GET /runs/{id}?offset=0&limit=100&kind=all&q= | 摘要、快照元信息、AI分析、新旧差异及分页 |
| GET /runs/{id}/snapshots/{index} | 管理员下载私有原件，二进制，不暴露存储路径 |
| POST /runs/{id}/analyze | expected_version，202，Idempotency-Key；重做AI分析 |
| POST /runs/{id}/review | decision、expected_version、reason、identifiers（null为全部可更新项）、acknowledge_analysis；Idempotency-Key |

写请求沿用Origin和X-Requested-With:NightVoyage，成功 `{data,request_id}`，错误沿用统一结构。重复同键同内容重放，改内容409；版本冲突409，未登录401，非管理员403，未配置AI503；缺审核确认422、AI未完成409。完整成功响应由后端Pydantic DTO和 [backend-openapi.json](backend-openapi.json) 定义，包含名录专属Schema；原v0.4的50个操作仍保持兼容。前端访问层和契约测试随同提交。

## 验证

自动测试位于test/backend/test_catalog.py和test/frontend/catalog.test.ts，使用真实PostgreSQL专用测试库、官方格式的合成附件和Fake AI，包含3196所全量分析/分页/管理员发布及版本审计。常规CI不访问真实官网或付费模型。

人工可运行只读来源验证（从仓库根目录）：

```powershell
src/backend/.venv/Scripts/python.exe test/verify_catalog_source.py --direct
```

脚本不连接数据库、不调用AI，不读取业务.env，写入忽略的test/reports目录。`--direct`显式选择直连；不传则沿用环境代理，锁文件已包含httpx的SOCKS支持。本机2026-10-20已通过实际HTTPS全链路：官方备用公告→教育部hudong普通/成人附件，读取2952+244=3196所、3196个唯一标识码、截至2026-06-17。真实AI输出质量与生产容器启动仍须部署环境验收，不能由Fake AI测试替代。
