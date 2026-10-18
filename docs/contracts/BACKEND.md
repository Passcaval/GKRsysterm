# M0–M1 实际后端与前端兼容边界

本说明对应 `feature/backend-postgresql` 的真实实现，优先于早期文档中“尚无后端”的历史核查。启动、数据库和测试见 [后端 README](../../src/backend/README.md)，实现阶段见[技术方案第十六章](../技术方案.md)。

## 协议与权限

所有业务路径前缀 `/api/v1`。JSON 成功使用 `{data,requestId}`，失败使用 `{error:{code,message,details:[{field,message}]},requestId}`；继续兼容现有前端，未单边切换到 request_id。所有写请求必须带允许的 Origin 和 `X-Requested-With: NightVoyage`。错误状态包括 401、403、404、409、413、415、422、429；不会用 200 包装错误。

Cookie 名 nv_session，HttpOnly、SameSite=Lax，默认有效 12 小时；数据库只保存令牌哈希。生产必须 Secure/HTTPS。登录成功轮换旧会话，退出撤销服务端令牌。角色与学校认证分离：student/contributor 无管理权限，reviewer 仅能审核内容，admin 才能审批注册与导入资料。注册只创建 student；角色从持久化账号读取，不接受请求指定。邮箱格式由后端检查，422 EMAIL_INVALID 或 IDENTIFIER_INVALID 的 message 提示重新输入；沿用已有登录页面错误展示。

昵称 NFC 后按 Unicode 码点检查 1–5 个汉字或英文字母，英文字母比较忽略大小写；邮箱按产品规则检查并小写占用。密码不裁剪，Argon2id 哈希。待审和正式标识共用唯一占用表；系统 ID 由 PostgreSQL 序列分配，回滚和驳回不重复使用。登录、注册、投稿、推荐按连接 IP 和分钟窗口限流；默认注册 10 次，其余 30 次，未直接信任请求方的 X-Forwarded-For。反向代理环境需统一可信代理策略，当前限流并非完整反滥用系统。

## 接口清单与流程

| 接口 | 输入、返回与关键约束 |
| --- | --- |
| POST /registration-applications | multipart nickname、email、password，以及 evidence_text / evidence_audio 至少一种；必须 Idempotency-Key；202 data 含 application_id、reserved_user_id、status、version、reason、status_token。仅建暂存申请，不签发会话 |
| GET /registration-applications/{id} | X-Application-Token 传查询凭据，不放 URL；仅返回该申请状态和驳回原因；错误凭据 404 |
| GET /admin/registration-applications | admin；status、offset、limit；items 和 pending_count 组成站内审核队列 |
| GET /admin/registration-applications/{id} | admin；原文、受控音频地址、审核记录；不返回密码哈希或查询凭据 |
| GET /admin/registration-applications/{id}/evidence/{evidence_id}/audio | admin；原始 WAV，不套 JSON；检查申请与材料归属 |
| POST /admin/registration-applications/{id}/decision | `{decision:"approve"或"reject",expected_version,reason}`；驳回须原因；行锁、校验材料、事务内转换占用/建号；相同已完成决策重放返回原状态，相反决策 409 |
| POST /auth/login、/auth/logout；GET /auth/me | 登录请求和响应保持旧契约；me 另含 user_id、email_verified=false、email_verified_at=null；无邮箱验证码和找回密码 |
| GET /me/profile、/me/profile/versions | 当前或历次版本；记录含 profile_version_id、version、profile、created_at，无当前版本返回 null |
| PATCH /me/profile | `{expected_version,profile}`；初次版本为 0；返回新版本；并发旧版本 409 |
| POST /admin/imports | admin；JSON ImportInput，202 返回 import_id、status；内容哈希去重，Worker 原子发布 |
| POST /admin/imports/csv | admin；multipart metadata（ImportInput 除 rows 外的 JSON 字符串）和 file（UTF-8 CSV）；状态与 JSON 导入相同 |
| GET /admin/imports/{id}、/{id}/snapshot | admin；前者状态与 errors，后者 normalized_snapshot 和 content_hash，供复核导入版本 |
| GET /schools、/schools/{id}、/admission-units | 公开；列表 offset/limit（默认30、最多100）；招生单位携带 source_id、dataset_version |
| GET /admission-units/{id}/history、/sources/{id} | 公开；可回查历史单位版本、来源元数据和内容哈希 |
| POST /recommendations | 新请求 `{question,profile_version_id?}` + Idempotency-Key → 202 RunView；旧 `{riskPreference}` → 200 Recommendation[]，见下方兼容说明 |
| GET /recommendations/{run_id} | 仅本人；RunView 含 run_id、status、profile_version_id、result、last_event_id、questions |
| POST /recommendations/{run_id}/answers | 仅本人且 waiting_input；`{expected_profile_version,profile}`；创建新画像版本并继续；202 RunView |
| POST /recommendations/{run_id}/cancel | 仅本人；202 RunView；已成功任务返回原终态，未完成任务取消 |
| GET /recommendations/{run_id}/events | 本人会话，SSE；Last-Event-ID 从上次已收事件编号后继续；每条含 event_id、event_type、run_id、timestamp、payload |
| POST /feedback | 本人 run/item；Idempotency-Key；`{run_id,recommendation_item_id,kind,reason}`；kind 为 preference/correction/satisfaction/outcome；201 feedback_id、accepted |
| GET /admin/feedback | admin；分页列出事实纠错供人工核验；不自动改官方资料；当前无核验结案 UI/状态流转 |
| GET /me/history | 本人的 RunView 数组；M1 小数据规模，尚未分页 |
| 原有其他前端操作 | Bootstrap、收藏、投稿、内容审核、认证提交、草案与基础条件模拟、删除个人业务数据均有兼容实现；完整17项见 API.md |

原始注册证据与占用操作在事务中关联；批准失败回滚至 pending，驳回仅释放自身 reserved 占用。终态清除申请暂存密码及身份副本，正式用户与审计记录保留。后台未读队列基于持久记录；未接入电子邮件或系统推送。

## 数据字典与导入

ImportInput 必填：source_url（允许的官方 HTTPS 域名）、source_title、published_at（带时区）、locator（页码/表格位置）、reviewed=true、rows（1–1000）。覆盖当前版本时须明确 supersedes_import_id；出现未确认来源冲突则整批失败，旧发布数据不变。后台不会抓取 URL，域名合格不证明录入内容真实，管理员必须核对原资料。

每行必填 school_code、school_name、short_name、city、school_province、unit_code、province_code="浙江"、exam_year=2026、batch、rank_cohort、major、required_subjects、tuition。unit_type 只支持 major，exam_category 只支持普通类。可选 campus、plan_count、additional_requirements、history、description。unknown 用 null 或明确的待确认条件，不能用 0 冒充缺失。required_subjects=[] 表示不限选科，null 表示未知。additional_requirements 作为尚需核对的体检等要求列表，当前不自动判断。

history 每项 year、rank、score、rank_cohort、comparable；历史年份必须早于招生年。CSV 的 required_subjects、additional_requirements、history 为 JSON 列，tuition、plan_count 使用 JSON 数值或 null，字符串含逗号时按标准 CSV 引号转义。API 的 /docs 给出完整请求 Schema。

数据库保存规范化导入快照及其 SHA-256、来源 URL/标题/发布时间/位置/接收时间；单位、来源、导入批次保持可追溯版本。M1 没有网络采集和官方原始网页/PDF存档，CSV 原始字节也不单独归档，哈希针对规范化 JSON；需在后续采集流程补原始文件快照，不能把当前 hash 称为官方原件校验值。

## 推荐与任务

新推荐接口冻结画像、问题、招生单位/来源版本。补充答案另建画像版本，保留前一版本信息；此后修改当前画像或导入新数据不改变既有结果。规则先检查省份/年份、选科、预算、批次、校区和额外要求：fail 进入 excluded，unknown 进入 pending_confirmation，全部满足才进入 items。结果独立校验候选/来源属于冻结数据且硬条件满足，校验失败不发布。

result 含 items、pending_confirmation、excluded、questions、rule_version、validation、warnings、probabilities=null。每项含 recommendation_item_id、admission_unit_id、school_id、campus、major、eligibility、historical_risk、preference_match、evidence_ids、dataset_version、reasons、warnings。campus_id 暂为 null，校区当前按来源字符串表达。偏好匹配仅为城市/专业匹配及覆盖率，不是录取概率；同口径历史必须同时满足当前单位、画像与 history 的 rank_cohort 一致且 comparable=true，只展示历史区间。

任务状态为 queued → running → validating → succeeded，或 waiting_input/failed/cancelled。M1 本地计算在一次事务中落地 running/validating/result 事件，查询不保证观察到每个瞬态；事件按 run 内单调序号保存。Worker 用 FOR UPDATE SKIP LOCKED 抢占、2分钟租约与令牌防止重复提交；未知异常最多尝试3次，业务错误直接失败。仅导入与规则推荐进入此队列。

SSE 类型 status/question/result/error/done，`id:` 为 event_id；约25秒结束一次订阅，客户端携带游标重连，终态或等待输入后结束。每轮检查会话仍有效和任务仍归本人；GET 最终结果可恢复显示。监听断开不取消任务；尚未实现事件过期压缩、大规模任务调度或模型任务心跳。

## 与现有前端的同步评估

旧 [openapi.json](openapi.json) 是17项兼容接口的严格响应契约；[backend-openapi.json](backend-openapi.json) 由真实应用生成，包含新增路径、Pydantic 请求、写请求头、Cookie 和媒体类型。新业务的部分成功响应目前是开放对象，字段以本说明和行为测试为准；尚不能依赖它生成全部强类型响应 SDK。两份文件承担不同范围，不能互相覆盖。

| 已有前端能力 | 本次判断与处理 |
| --- | --- |
| 唯一登录页面、邮箱错误展示、角色导航 | 满足接入要求；登录页不修改；后端校验邮箱并执行权限，真实 HTTP 验证错误后重输、普通/管理员同接口登录 |
| Bootstrap 和院校卡片 | 兼容现有类型；缺历史位次/学费/选科要求的院校不塞入旧卡片，仍可从新单位接口读取；旧卡片取该校一个完整单位的历史，不代表全校所有专业条件 |
| 画像保存 | 旧 PUT 保持 Profile 响应，服务器内部仍建版本；旧请求无 expected_version，因此后写覆盖“当前”视图；新 PATCH 才提供乐观并发保护，前端版本界面待补 |
| 推荐数组与风险滑块 | 旧请求使用同一确定性规则和快照；风险滑块数值不改变硬条件、不生成冲稳保阈值；HTTP 模式统一显示待核对，matchScore 可 null，多个专业卡片不按学校单独作为 key |
| 社区可信度面板 | M1 尚未做 M2 内容评估，五个轴返回 null，前端显示待评估；人工发布不等于事实已被证实 |
| 投稿、收藏、草案、审核 | 服务端鉴权及数据隔离已实现；模拟仅检查已知条件，明确不是完整投档模拟 |
| 学校认证与聊天 | 认证提交只进入 pending，认证审批属于后续；聊天明确返回“未接入模型”流事件，不能称为 AI 对话已实现 |
| 注册审批、导入、异步推荐/补问、反馈页面 | 后端 API 已可验证；现有前端尚无这些完整页面，当前通过 API/开发文档使用；需要后续前端任务对接新协议 |

结论：原前端可以接入 M0–M1 兼容服务，不能作为完整 M1 页面验收。前后端均以未知状态呈现未评估内容；真实官方资料接入、浏览器反向代理/SSE重连验收、生产运维及 M2–M4 功能另行推进，不用测试样本冒充上线数据。
