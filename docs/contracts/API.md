# 夜航前后端接口对接规范 v0.4

更新：2026-10-18。工程路径为 `src/frontend/`。本轮按主技术方案第4–9、12–13章迁移，保留第14–15章统一登录与CI。这里描述**前端已实现的联调提案**，仓库尚无真实后端；Mock与临时HTTP测试服务不能证明生产鉴权或推荐模型已完成。

机器契约以本目录 [openapi.json](openapi.json) 为准，由 `src/frontend/scripts/contract.mjs` 生成；前端 `docs/openapi.json` 是相同副本。修改生成源后运行 `pnpm run contract`；`pnpm run contract:check` 只检查、不改文件，任何副本过期均非零退出。

## 1. 协议与迁移

- 基址 `/api/v1`，UTF-8。HTTP DTO统一 `snake_case`；React模型保留camelCase，通过 `transport.ts` 显式转换。画像与User有专用映射，不能只依赖递归改名。
- 成功 `{ "data": ..., "request_id": "req-..." }`。新建注册申请/推荐/补问/取消/学校认证用202；投稿与推荐反馈用201；普通读写与删除用200。删除返回 `data:null`，不返回204。每个响应的数据结构见OpenAPI。
- 失败使用非2xx状态：`{"error":{"code":"PROFILE_VERSION_CONFLICT","message":"画像已更新，请刷新后确认","details":{"field_errors":{"rank":["请核对位次口径"]}}},"request_id":"req-..."}`。
- `details`为对象，可含 `field_errors`、`missing_fields`。前端展示message、字段提示、request_id并保留输入；不会用演示结果替换HTTP错误。登录失败也遵循此结构，不暴露账号是否存在。422格式错误；401会话失败；403权限；404不存在/不可访问；409版本/占用/幂等冲突；410事件游标过期；413/415文件；429限流；5xx依赖失败。
- 本版是整批协议升级：替换旧v0.1 camelCase信封、details数组、同步推荐数组和全200约定。第14.5章旧响应说明作为历史保留。登录**请求**仍为login_type/identifier/password；前端错误读取兼容旧requestId和message，但成功DTO不兼容旧版。后端迁移前不要直接切HTTP上线。
- Cookie `nv_session`，生产 `HttpOnly;Secure;SameSite=Lax;Path=/`；fetch带credentials。写请求带 `X-Requested-With:NightVoyage`，后端仍须验证Origin/CSRF与对象权限。跨域须明确允许源与凭据，不能通配。
- 20秒普通请求/原件超时；会话切换会中止旧请求、清除个人UI并丢弃迟到响应。SSE连接20秒、空闲30秒，心跳维持连接；不自动重放写操作。
- UTC ISO8601时间在UI按Asia/Shanghai展示，日期字段保持YYYY-MM-DD。不透明ID不推断主键，未知值使用null或unknown；禁止用0伪装未知。
- 游标列表 `{items:[],next_cursor:null}`；查询条件改变须重置游标。Bootstrap只是首屏快照，详情按ID另取，分页列表不可当全量数据库。请求URL参数与文件限制详见OpenAPI。

## 2. 登录、注册与三种审核

所有账号共用 `/#/login`，无身份选择器。`POST /auth/login`：

```json
{"login_type":"email","identifier":"sample@example.test","password":"原样传输，不裁剪"}
```

也可用 `user_id` 和系统ID；昵称不能登录。服务端返回User中的id、user_id、nickname、email、email_verified、role、permissions、student_verified与认证范围。邮箱仅格式检查，首版不发送验证码、不验证邮箱控制权、不提供找回密码。权限必须来自账号，不从客户端角色参数赋予。

注册只提交multipart：nickname/email/password/evidence_text/evidence_audio。昵称NFC后按Unicode码点计1–5个汉字或ASCII字母，不做NFKC、不裁剪昵称。邮箱按主技术方案ASCII子集验证并统一比较大小写；密码8–128字符且原样处理。文字最多3000码点、音频最多120秒/10MiB，WebM/OGG/MP3/M4A/WAV；至少一种证据。浏览器的长度、MIME、时长提示只是辅助，后端必须解码验证、扫描与加密保存原件。

`POST /registration-applications` 带Idempotency-Key，202返回：

```json
{"data":{"application_id":"app-101","reserved_user_id":"U0000000101","status":"pending","status_token":"opaque-random-capability"},"request_id":"req-101"}
```

pending不能登录。系统预留ID，批准沿用，驳回不复用该ID。pending/approved昵称邮箱占用；驳回释放占用。原子约束、密码安全哈希和并发唯一性由后端保证。状态查询 `GET /registration-applications/{id}` 把凭据放 **X-Application-Token**，禁止放URL、Cookie或localStorage；状态结果不包含密码、哈希或原始审核证据。

注册审核要求 `registration:review`，查看原始文字/音频，决策带expected_version和Idempotency-Key。批准只创建普通账号，邮箱仍未验证，不赋学校认证；驳回理由必填。相反决策并发或过期版本409，不覆盖。

学校认证要求单独材料上传（JPG/PNG/PDF≤5MiB），队列/受保护原件/审核为独立接口，审核员需 `verification:review`；批准说明学校与证明范围。内容审核需 `content:review`。只有内容审核权限的人不能读取注册申请或学校证明。前端路由守卫不能替代后端权限检查。所有原件下载需鉴权，不能返回永久公开存储URL；服务端实施访问审计与保留期限。

Mock仅为本地开发：公开测试账号在README；申请、密码哈希、注册音频和学校证明文件只驻当前JS运行内存，刷新/HMR会丢失；认证元数据、个人任务与偏好可持久化。不要输入真实个人资料。Mock不是安全边界。

## 3. 画像版本与招生口径

`GET /me/profile` 可为null。PATCH完整画像字段加expected_version（首次0），返回新version/profile_version_id，409保留输入。`POST /me/profile/parse` 返回proposed_changes/missing_fields/questions，UI确认后才能写入。历史版本不可改写；任务冻结profile_version_id并保留original_profile_version_id。

省份province_code、exam_year、exam_category、选科、score/rank/rank_cohort分别表示，不以分数替代位次。预算为 `{amount:null,currency:"CNY",period:"year",scope:"tuition"}` 或scope=total。偏好含field/value/strength(hard|soft)/priority。未填成绩不会阻断校园生活；报考条件与风险任务按所需字段补问。

院校、校区、招生单位、专业必须分开。`/admission-units` 返回招生年份、省份、科类、批次、unit_type、选科、majors及data_version；历史返回comparable/reason及单位行。未确认同口径不绘制可比风险曲线。HTTP模式不在浏览器运行浙江示例分类或补默认23500位次。

草案使用稳定entry.id、admission_unit_id及major_id；从推荐加入时携带recommendation_item_id，后端据此核对实际招生单位和专业，不按名称猜ID。Plan.version乐观锁，max_entries由后端配置。HTTP工作台不允许修改专业名称却沿用旧专业ID；应回院校选具体专业。旧演示条目的缺失ID只适用于Mock，正式写入后端应拒绝或要求重新选择。

## 4. 异步推荐与恢复

```json
{"question":"结合档案分析报考选择","profile_version_id":"pv-1","risk_preference":50,"intent":"risk"}
```

intent为campus_life/admission/risk。`POST /recommendations` + Idempotency-Key，202最小返回 `{run_id,status}`，前端随后GET完整任务；也接受完整Run。滑块不会自动创建任务。补问POST answers携带answers/expected_version和同样的幂等策略，形成新画像版本，保留原版本；取消用专门接口，不能以断开SSE充当取消。

状态：queued → running → validating → succeeded/partial；缺失条件可waiting_input，经answers继续；失败failed或取消cancelled。终态不恢复运行，冲突409。部分失败必须明确原因。输出须分开eligibility(pass/fail/unknown)、historical_risk(reach/match/safe/unknown)、preference_match(score可null、coverage与breakdown)。偏好分不是录取概率。

UI仅当终态succeeded/partial且validation.status=passed才展示推荐，并排除eligibility.fail；未知条件单列，不当作已满足。推荐项用recommendation_item_id作为键，同校多个招生单位/专业不能去重为一个学校。未取到学校详情时保留推荐项并显式报错，不静默丢失。

GET `/recommendations/{run_id}/events`，Accept:text/event-stream，恢复带Last-Event-ID。每帧：

```text
id: 8
event: result
data: {"event_id":8,"event_type":"result","run_id":"run-1","timestamp":"2026-10-18T08:00:00Z","payload":{"validated":true}}

```

事件类型status/question/result/error/done；id需与event_id一致、run_id需一致，event_id单调。result必须validated=true，前端仍GET任务快照验证后展示。支持UTF8拆包、CRLF、心跳、去重，丢弃旧/乱序事件；拒绝截断帧及超过1MiB缓存。服务端保存可重放事件并支持游标；410时前端读取快照重置游标，让用户恢复监听。网络断开、离开页面、“仅停止监听”均不取消后台任务。任务ID/游标按账号保存在sessionStorage，历史页可恢复。

普通问答 `/chat/stream` 是POST SSE，独立的delta/tool_start/tool_end/evidence/done/error事件（完整payload见ChatEvent），不能把推荐任务事件直接转为聊天或输出未校验个性化推荐。停止回答只中止当前流。两类流都必须完整done，异常显式展示。

## 5. 证据、投稿与反馈

Source包含来源类型、URL、年份、采集时间、版本、段落定位/哈希、support_status、freshness、scope。Claim关联evidence_id及supports/refutes/background。unknown/unverified/withdrawn/expired明确展示，缺失证据ID按需GET，不以Bootstrap过滤掩盖。五维可信度允许null，未评估不显示伪造高分。

投稿含学校/校区/专业、experienced_at、visibility(public/private)、title/body/topic；201待审，作者可读私有/待审，公众仅published+public。修改/删除只限作者，expected_version冲突409，修改重置pending及旧claims。后端执行脱敏、鉴权与内容校验。

推荐反馈POST /feedback带run_id/recommendation_item_id/kind/reason，后端回溯任务绑定的profile_version_id和Idempotency-Key，201。preference形成待确认个人记忆，可修改/确认/删除；correction进入事实核查，不直接改官方资料。历史任务、个人记忆与案例共享独立授权；撤回共享不删除私人历史，也不能继续用于公共案例。DELETE /me/data清除本人画像/任务/偏好/投稿等，真实保留策略由后端核实并告知。

## 6. 接口清单

下表仅列成功状态；公共错误信封及权限见上文和机器契约。所有管理接口后端必须按独立permission及对象范围拦截。音频/证明返回二进制，SSE返回事件流，除此之外使用data信封。

| 方法 | 路径 | 成功状态 |
| --- | --- | --- |
| GET | `/bootstrap` | 200 |
| POST | `/auth/login` | 200 |
| POST | `/auth/logout` | 200 |
| GET | `/auth/me` | 200 |
| POST | `/registration-applications` | 202 |
| GET | `/registration-applications/{application_id}` | 200 |
| GET | `/admin/registration-applications` | 200 |
| GET | `/admin/registration-applications/{application_id}` | 200 |
| POST | `/admin/registration-applications/{application_id}/decision` | 200 |
| GET | `/admin/registration-applications/{application_id}/audio` | 200 |
| GET | `/me/profile` | 200 |
| PATCH | `/me/profile` | 200 |
| POST | `/me/profile/parse` | 200 |
| GET | `/me/profile/versions` | 200 |
| DELETE | `/me/data` | 200 |
| PUT | `/me/favorites/{school_id}` | 200 |
| DELETE | `/me/favorites/{school_id}` | 200 |
| GET | `/schools` | 200 |
| GET | `/schools/{school_id}` | 200 |
| GET | `/admission-units` | 200 |
| GET | `/admission-units/{unit_id}/history` | 200 |
| POST | `/recommendations` | 202 |
| GET | `/recommendations/{run_id}` | 200 |
| GET | `/recommendations/{run_id}/events` | 200 |
| POST | `/recommendations/{run_id}/answers` | 202 |
| POST | `/recommendations/{run_id}/cancel` | 202 |
| POST | `/feedback` | 201 |
| PUT | `/me/plan` | 200 |
| POST | `/plans/simulations` | 200 |
| GET | `/posts` | 200 |
| POST | `/posts` | 201 |
| GET | `/posts/{post_id}` | 200 |
| PATCH | `/posts/{post_id}` | 200 |
| DELETE | `/posts/{post_id}` | 200 |
| POST | `/posts/{post_id}/feedback` | 200 |
| GET | `/evidence/{evidence_id}` | 200 |
| POST | `/me/student-verification` | 202 |
| GET | `/admin/student-verifications` | 200 |
| GET | `/admin/student-verifications/{verification_id}/document` | 200 |
| POST | `/admin/student-verifications/{verification_id}/decision` | 200 |
| GET | `/admin/reviews` | 200 |
| POST | `/admin/reviews/{post_id}` | 200 |
| GET | `/me/history` | 200 |
| GET | `/me/memories` | 200 |
| PATCH | `/me/memories/{memory_id}` | 200 |
| DELETE | `/me/memories/{memory_id}` | 200 |
| GET | `/me/case-sharing-consent` | 200 |
| POST | `/me/case-sharing-consent` | 200 |
| DELETE | `/me/case-sharing-consent` | 200 |
| POST | `/chat/stream` | 200 |

## 7. 后端接入与验收

1. 服务监听8000并挂载/api/v1；开发Vite代理转发/api，生产配置同源反向代理。VITE_API_MODE=http，生产未设置默认http；非法值直接报错。standalone固定mock，不能用作真实接口验收。
2. 用OpenAPI定义Pydantic DTO，输出snake_case；统一异常转换，保证details对象、request_id、状态码、nullable和版本字段。会话写入HttpOnly Cookie。不要从客户端接收role/permissions或自行猜测来源数据。
3. 落地申请/审批唯一性、幂等键作用域(用户+操作+请求体)、重放保存期、乐观锁与事务。校验用户ID、邮箱与密码的全部服务端规则，不能依赖浏览器。
4. 接入可追溯官方数据、任务队列、结果校验与事件重放。跨账号读写403/404，会话过期401；取消竞态返回冲突而非覆盖终态。
5. 完成真实服务集成：注册提交→管理员看原件→批准→双标识登录→画像冲突→创建/补问/恢复任务→证据详情→反馈/记忆→撤回共享→退出401。验证跨账号资源隔离、私帖、并发审批、事件过期、文件时长/伪MIME、限流和依赖失败。

前端内置Schema检查只实现本契约用到的类型、引用、组合、必填、枚举、数值/长度、数组唯一性与日期时间子集，不是完整JSON Schema引擎，也不替代后端业务验证。50个操作、48个Schema的当前测试覆盖是协议夹具验证，生产密码哈希、加密文件存储、任务持久化、模型与安全审计必须由真实后端实现。
