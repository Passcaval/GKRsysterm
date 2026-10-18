# M0–M1 后端：已整合 v0.4 前端

当前生产入口 `app.main:create_app` 使用 v0.4 共享协议，与合并的 `feature/frontend-workflow-alignment` 前端同步。用户要求先整合新前端再提交 PR；双方历史通过 merge 保留。原49项基线验证和17项旧契约只作为回归依据，不是当前线上协议。

[启动与验证](../../src/backend/README.md) · [共享前端契约](openapi.json) · [实际后端完整路由](backend-openapi.json) · [开发日志](../开发日志.md)

## 协议与实现范围

业务前缀 `/api/v1`，成功 `{data,request_id}`，失败 `{error:{code,message,details:{field_errors?}},request_id}`。写请求带允许的 Origin 和 `X-Requested-With:NightVoyage`；注册、审批、创建/补问/取消推荐、投稿、推荐反馈按约定传 Idempotency-Key。同操作同键同内容返回原业务对象，不同内容409。状态码、版本和可空字段以共享 v0.4 DTO 为准。

后端 `app/modules/protocol/` 实现生产边界，按共享 JSON Schema 校验公开 DTO，再转换至 Pydantic/领域服务；内部保留画像、来源、任务及事件版本快照。`create_app(...,contract_version="0.1")` 仅用于独立旧领域回归测试，不是默认部署入口，不额外挂载旧生产路径。旧响应夹具放在 tests/fixtures，避免新版契约被旧测试覆盖。生成后端 OpenAPI 时复用共享公开定义，再补充管理员导入等后端接口；修改时须同时运行两端契约检查。

| 前端功能 | 实际后端状态 |
| --- | --- |
| 唯一登录页、角色权限与邮箱重输 | 已实现真实 Cookie 会话；后端返回 EMAIL_INVALID / IDENTIFIER_INVALID 及重新输入提示；真实模式不在浏览器提前拒绝邮箱 |
| 注册申请、状态查询、管理员原文/原始音频审批 | 已实现；未批准不建正式账号；批准/驳回原子处理，预留ID不变、驳回释放自身占用；查询凭据使用请求头 |
| 部分画像、版本、乐观锁 | 已实现；未填成绩/位次为null；初次expected_version=0，后续旧版本409；画像使用需确认consent |
| 自然语言提取画像 | M2未接入；503 FEATURE_NOT_AVAILABLE，不伪造提取结果；可使用结构化档案 |
| 院校、招生单位、历史、来源详情、分页筛选 | 已实现；未知数据保留null；按学校筛选单位；仅当前已复核导入数据可发布 |
| 异步推荐、补问、事件恢复、取消、反馈 | 已实现并与真实前端访问层联调；只有校验通过的结果进入页面 |
| 草案与模拟 | 以招生单位/专业ID校验本人条目，版本锁；模拟仅检查已知条件，未知不等于通过，不执行真实投档 |
| 投稿、编辑、删除、私密、人工审核 | 已实现基础流程、版本及权限；编辑重新待审，私密内容不会出现在公开列表；不包含M2的主张/可信度评估 |
| 学校认证材料 | 可受控提交，202 pending；完整认证审批尚未开放，admin不返回verification:review权限；人工发布帖子不授予学校认证 |
| 历史、记忆、共享 | 本人推荐历史已实现；M3记忆返回空、跨用户共享保持关闭，写入未开放返回503；页面明确提示并禁用真实模式共享开关 |
| AI聊天/向量检索 | M2–M4尚未接入，聊天SSE明确发送未接入模型错误；不返回演示答案 |

共享契约50个操作都能路由；未开放操作返回明确错误，不代表50项业务全部完成。管理员导入等为后端额外接口。完整操作与DTO见 [API.md](API.md)，M0–M1实际范围以本页为准。

## 账号、证据与权限

student/contributor无管理权限，reviewer仅有content:review，admin拥有content:review、registration:review、admissions:import。所有对象权限在后端重复检查。管理角色不等于学校认证；注册请求禁止role/permissions等额外字段。管理员只由受控初始化命令创建，审批只产生student。

昵称NFC后按Unicode码点检查1–5个汉字或ASCII英文字母，英文忽略大小写占用；邮箱按产品规则检查后小写占用；密码不裁剪，使用Argon2id。正式与待审共用标识唯一占用表；系统ID由PostgreSQL序列产生，不因回滚/驳回重复。批准失败回滚至pending及原占用；终态清理暂存密码与身份副本，保留正式账号与审计事件。申请查询凭据不会进入URL。

注册支持文字或音频至少一种。WAV直接解析；浏览器录音WebM及OGG/MP3/M4A由ffprobe识别、ffmpeg真实解码验证，限制120秒、10MiB；媒体处理只允许pipe协议、15秒超时，禁止媒体引用网络或本机路径。保留原始字节供管理员收听，不将转写当作证据。缺少解码工具明确503，可改用WAV或文字。认证材料支持PNG/JPEG或未加密、最多20页PDF。

Cookie名nv_session，HttpOnly、SameSite=Lax，默认12小时；生产Secure/HTTPS。数据库只存令牌哈希，登录轮换旧会话，退出撤销令牌。登录/注册/投稿/推荐按连接IP限流；默认注册10次/分钟，其余30次，未直接信任客户端X-Forwarded-For。反向代理需统一可信代理策略。

私有文件不公开托管，终态申请材料默认保留30天，清理命令不会自动释放待审占用。Windows需限制运行目录ACL；数据库和文件都需要备份。尚未完成生产备份恢复、加密存储、压力与完整安全审计，数据库事务测试不能替代这些工作。

## 官方资料导入

管理员接口 POST `/admin/imports` 接收JSON；POST `/admin/imports/csv` 接收multipart metadata（除rows外的JSON）和UTF-8 CSV file；均202返回import_id/status。GET `/admin/imports/{id}`查询状态/errors，GET `/admin/imports/{id}/snapshot`读取规范化快照和content_hash。独立Worker运行才会发布数据。

ImportInput必填 source_url、source_title、published_at（带时区）、locator（页码/表格位置）、reviewed=true、rows（1–1000）。来源必须为允许的官方HTTPS域名；后台不会抓取URL，域名合格不能证明录入真实，管理员须复核原件。覆盖已有单位须明确supersedes_import_id；冲突整批失败，不覆盖当前版本。

每行：school_code、school_name、short_name、city、school_province、unit_code、province_code="浙江"、exam_year=2026、exam_category="普通类"、unit_type="major"、batch、rank_cohort、major、required_subjects、tuition。可选campus、plan_count、additional_requirements、history、description。学费/校区/选科缺失用null；required_subjects=[]代表不限选科，null代表未知。v0.4单位响应增加requirements_known辅助区分未知选科。

history每项year/rank/score/rank_cohort/comparable，年份必须早于招生年。CSV的required_subjects、additional_requirements、history使用JSON列，tuition/plan_count使用JSON数值或null，含逗号时用标准CSV引号转义。完整输入模型见API的/docs。

保存规范化导入快照及SHA-256、来源URL/标题/发布时间/位置/接收时间，单位与来源不可变版本可回查。没有原始官方网页/PDF自动存档，CSV原始字节也不单独归档；此hash不是官方原件校验值。没有预置真实招生数据，测试资料不会写入开发库。

## 推荐与版本语义

新前端只使用202异步推荐。创建冻结画像及单位/来源版本；risk意图缺位次/统计口径时补问，其他报考意图不因缺分数被拒绝。当前M1规则推荐还会要求明确选科、学费预算、批次及同意使用画像；校园生活可直接用院校/回声查询，不冒充模型语义问答。

补问请求采用 `{expected_version,answers:{field:string}}`，expected_version对应任务版本，答案生成新画像版本并保留original_profile_version_id。版本来自单调事件序号；若本人在另一页面更新画像，补问返回409，不覆盖更新。取消也检查任务版本并具备幂等键；断开SSE只停止监听，不取消任务。

规则分开pass/fail/unknown；fail不进入候选，unknown单列。预算为空、总费用预算缺住宿/生活数据、未自动解析的硬性偏好均待核对，不忽略硬要求后返回合格。偏好匹配只表示现有城市/专业维度匹配，不代表录取概率，尚未按所有优先级加权。历史须匹配画像和单位的rank_cohort且comparable=true，只展示历史参考；未校准冲稳保，公开historical_risk始终unknown。

结果经独立校验确认单位/来源属于冻结数据且合格项满足硬条件；Run.validation.status=passed后才展示。SSE的result.payload.validated=true只在校验通过时发出。事件按run内编号保存，Last-Event-ID恢复；约25秒断开后重连，终态或waiting_input结束订阅。每轮复核会话与任务归属；当前无事件过期压缩，非法游标422，不虚构410恢复记录。

Worker使用SKIP LOCKED、2分钟租约、令牌校验和事务发布；未知异常最多重试3次，业务错误直接失败。running/validating/result在本地短任务的一次事务内落地，GET未必看到每个瞬态，但事件完整。删除个人业务数据同时清理任务/事件/反馈，不会被Worker重新发布。

首版一个招生单位对应一个专业，major_id使用该不可变单位版本的ID；campus_id暂为null，保留campus_name。推荐加入草案同时携带单位、专业和推荐项ID，后台核对本人来源，不按名称猜测。后续真正多专业组合/独立校区实体需新增迁移及同步契约。

反馈绑定本人run/item/画像版本；事实纠错通过GET `/admin/feedback`供人工核验，不自动改官方数据。M3记忆不会由M1偏好反馈偷偷生成。

## 验证边界

旧领域回归使用独立v0.1测试应用、固定响应夹具和真实PostgreSQL；生产v0.4另有响应Schema、私帖/版本、补问/任务/反馈/草案、录音和未开放功能测试。Node真实访问层联调使用当前v0.4 api.ts→临时Uvicorn→PostgreSQL，包含申请/审批/错误重输/普通账号权限/推荐补问/反馈/来源/草案；不使用HTTP模拟返回。原前端24项夹具/Mock测试另行保留，不冒充后端验证。

浏览器、实际招生资料和生产基础设施的验收范围以[最新开发日志](../开发日志.md)为准。本次仅提交整合PR，不直接合并main。
