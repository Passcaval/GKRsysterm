# 夜航前后端接口对接规范 v0.1

> **M0–M1 后端已实现：** 本页保留现有前端17项兼容契约，早期“无后端”描述为历史状态。实际后端新增注册审批、版本画像、异步推荐、导入与反馈，见 [BACKEND.md](BACKEND.md) 和 [后端 OpenAPI](backend-openapi.json)。真实模式新增 tier=unknown、matchScore 可 null、Trust 五轴可 null，显示待核对或待评估。模型聊天与完整学校认证审批尚未实现。

> **统一登录更新：** 当前使用 `POST /auth/login`（login_type、identifier、password）和 `POST /auth/logout`。页面统一为 `/#/login`，不选择管理员或用户身份，权限由后端账号决定；User.role 新增 admin。其余接口仍沿用本页 v0.1 约定，正式业务差距见主技术方案。

> **2026-10-18 对照评估：** 本文与 `openapi.json` 描述当前前端接口，尚未覆盖完整业务规范。后端开发以[主技术方案](../技术方案.md)第 4～9 章为目标，具体差距及迁移要求见第 12～14 章。统一双标识登录已更新前端；注册申请与人工审批、版本画像、异步推荐任务、事件恢复及推荐反馈仍需补齐。本文的全 200 响应和同步推荐数组不作为最终契约。首版不提供验证码、邮箱验证或找回密码。

本文源码路径（例如 `src/api.ts`）均相对于仓库 `src/frontend/`。更新 `scripts/contract.mjs` 后执行 `pnpm run contract` 同步共享 OpenAPI 与前端兼容副本；执行 `pnpm run contract:check` 验证两处产物均未过期。

## 1. 约定性质与模块边界

本契约依据前端开发时的方案制定，下列接口是**当前前端实际采用的拟定约定**，不是对已经存在服务的描述。主技术方案现已补充目标 URL、数据对象及流程；其中与本契约冲突的内容需按上述评估迁移。当前前端契约的机器可读文件为同目录 `openapi.json`，对应 `src/api.ts` / `src/types.ts`，尚不能作为完整后端规范。

| 后端模块               | 当前前端入口             | 对接边界                                                |
| ---------------------- | ------------------------ | ------------------------------------------------------- |
| 考生画像与需求分析     | 档案、首页画像摘要       | 存取省份、年份、位次、选科、偏好，服务端识别缺失字段    |
| 官方院校与招生数据获取 | 星图、院校详情           | 快照中的 Schools / Sources；必须保留真实来源与时效      |
| 发帖与身份认证         | 灯塔计划、我的           | 发帖、上传材料、认证状态；服务端拥有发布状态            |
| 可信度评估与证据管理   | 鉴定面板、审核台         | 五维指标、印证计数、有效期、规则版本、申诉              |
| 检索与知识服务         | 回声筛选、Agent          | v0.1快照本地筛选；语义检索在Agent后端工具中执行         |
| 志愿匹配与推荐计算     | 航线、排除解释、方案检查 | 后端决定条件合规、匹配、推荐依据和风险；前端仅展示      |
| Agent编排与模型接入    | 全局领航员               | POST SSE，公开工具状态、回答增量、证据、完成 / 失败     |
| 结果校验与反馈评估     | 来源详情、帮助投票、复核 | 后端校验数字、引用与结论一致性；反馈写入服务端          |
| 档案与历史案例         | 我的、志愿草案           | 本版保存当前档案和当前草案；历史方案 / 效果统计另行扩展 |

## 2. 通用协议

- 基址 `/api/v1`；UTF-8 JSON；字段使用 camelCase，FastAPI 内部可用 Pydantic alias。
- ID 是不透明字符串；前端不得推断数据库主键。时间 ISO 8601 UTC；仅日期为 `YYYY-MM-DD`。分数、位次、学费为数值，禁止返回含逗号的格式化文本。
- 所有 REST 成功操作当前统一返回 **200 + JSON**，包括删除。不要返回 204，现有访问层需要响应信封。
- 日期、单位与统计范围由服务端保证。前端显示的排名只有“同省、同选科、同批次、同专业组、同口径”才可比较；历史分数不可跨年直接当作预测分数。
- `GET /bootstrap` 可以匿名，其余接口按下表授权。**导航隐藏与前端角色守卫不能替代服务端鉴权**。
- API 普通请求 20 秒超时，不自动重试写操作；SSE 单次上限 120 秒，可由用户取消。限流后返回 429，建议 `Retry-After`。

成功：

```json
{ "data": { "id": "school-hdu" }, "requestId": "req-3f18" }
```

失败（校验错误也应转换为此格式，不要直接暴露 FastAPI 默认 `detail`）：

```json
{
  "error": {
    "code": "PROFILE_INVALID",
    "message": "当前选科不满足该省份规则",
    "details": [{ "field": "subjects", "message": "必须包含物理或历史主选科" }]
  },
  "requestId": "req-3f18"
}
```

| HTTP      | 典型 code                                               | 前端与后端行为                                |
| --------- | ------------------------------------------------------- | --------------------------------------------- |
| 400 / 422 | INVALID_INPUT / PROFILE_INVALID / UNSUPPORTED_EXAM_MODE | 明确字段与适用范围，前端保留用户输入          |
| 401       | SESSION_EXPIRED                                         | 提示登录；不得继续返回个人数据                |
| 403       | ROLE_REQUIRED / VERIFIED_USER_REQUIRED                  | 显示权限原因，不降级绕过                      |
| 404       | RESOURCE_NOT_FOUND                                      | 无权读取私有资源时也可返回404，避免泄露存在性 |
| 409       | PLAN_VERSION_CONFLICT / REVIEW_ALREADY_DECIDED          | 刷新后再操作，不覆盖他人新状态                |
| 413 / 415 | FILE_TOO_LARGE / FILE_TYPE_UNSUPPORTED                  | 拒绝文件；前端保留其余字段                    |
| 429       | RATE_LIMITED                                            | 保留输入，提示稍后重试                        |
| 500 / 503 | INTERNAL_ERROR / MODEL_UNAVAILABLE                      | 返回 requestId，服务端日志保留详细诊断        |

## 3. 会话、安全与隐私

### 登录输入校验与现有前端的对接

保持现有登录页面和业务代码不变。请求仍为 `POST /auth/login`，JSON 包含 `login_type`、`identifier`、`password`。前端仅按是否含 `@` 选择登录类型，并对标识做首尾空白裁剪；这不是邮箱合法性校验。后端不能依赖前端的 required、长度限制、裁剪或 login_type 来判定输入有效，必须自行检查类型、格式、长度及字符规则。

后端按主技术方案 5.3.2 校验邮箱；系统 ID 按系统分配格式校验。不符合输入格式返回 **422**，不建立新会话，不进行正常登录跳转。缺少 `@` 的错误邮箱可能被前端标为 user_id；后端仍需验证系统 ID 格式，失败返回 `IDENTIFIER_INVALID`，不能把任意字符串当成合法 ID。

沿用现有 Error Schema，失败示例与 OpenAPI 一致：

```json
{
  "error": {
    "code": "EMAIL_INVALID",
    "message": "邮箱格式不正确，请重新输入。",
    "details": [{"field": "identifier", "message": "请输入符合格式要求的邮箱地址"}]
  },
  "requestId": "req-email-invalid"
}
```

**完整提示必须写在 error.message 中。** 现有 ApiError／登录页会显示该消息，保留输入、解除按钮禁用，用户修改后可重新提交；当前不按 code／details 展示字段级错误，不要求新增自动聚焦或清空逻辑。后端不得只返回 FastAPI 默认 detail 或将错误放入 200 的 data。格式正确但账号、密码或账号状态不通过时返回统一 401 提示，不暴露账号是否存在；不发送邮箱验证码或验证邮箱控制权。

当前兼容契约使用 `requestId` 和 details 数组；主方案第 12.5 节的 snake_case 统一是后续整体迁移目标，不在本次单独切换登录协议。迁移需同步修改后端响应、共享契约、前端适配和测试。

使用 `nv_session` Cookie，服务端存储会话与角色。生产属性：`HttpOnly; Secure; SameSite=Lax; Path=/`。前端 `fetch` 使用 `credentials: include`，不在 localStorage 存访问令牌，不把模型 API Key 放入 `VITE_*`。

所有非 GET 请求（包括登录和 multipart 上传）携带 `X-Requested-With: NightVoyage`。后端必须同时验证 `Origin` 白名单、Cookie SameSite 和权限；仅凭这个公开字符串不是鉴权。开发推荐同源 Vite 代理，生产同域反代。跨域部署需要显式 CORS 来源、`allow_credentials=True`，禁止配合凭据使用 `*`。跨站域名导致 SameSite 限制时，应优先调整为同站部署；如改为 SameSite=None，需重新审视 CSRF 方案。

服务端根据当前用户过滤快照：

- 匿名：`user/profile=null`，`favorites/verifications=[]`，`plan.entries=[]`，只返回公开帖子。
- 学生 / 贡献者：公开帖子加自己的投稿；`Post.isMine` 是服务端计算的展示标识，不接受客户端输入。
- 审核员／管理员：可以读待审队列，内容审核接口每次校验 reviewer 或 admin；reviewer 不因此获得注册审批权限，管理角色也不自动获得学校认证。
- 身份证号、实名、学号、认证原件、模型私有提示词不得随快照下发。证据URL只能指向当前用户有权读取的资源。

`DELETE /me/data` 删除画像、收藏、草案、认证申请及材料、未发布投稿；已发布内容匿名化，依法保留的安全审计需告知用户。产品端已有二次确认。后端应终止涉及已删除数据的活跃任务，防止旧 SSE 响应重新写入个人档案。

演示模式使用浏览器 localStorage 存一份开发数据；不是正式账号隔离机制。请勿在共享设备输入真实个人信息。正式模式不使用这份演示业务存储。

## 4. 当前实际调用的端点

所有请求和响应字段的 required、类型与枚举见 OpenAPI。下表响应指信封中的 `data`。

| 方法与路径                        | 输入                          | 响应                 | 授权                   |
| --------------------------------- | ----------------------------- | -------------------- | ---------------------- |
| GET `/bootstrap`                  | 无                            | Bootstrap            | 可匿名，按角色裁剪     |
| POST `/auth/login`                | login_type, identifier, password | User + Set-Cookie | 可匿名，服务端确定权限 |
| POST `/auth/logout`               | 无                            | null，吊销Cookie     | 当前会话               |
| PUT `/me/profile`                 | 完整Profile                   | Profile              | 登录且只能写自己       |
| DELETE `/me/data`                 | 无                            | null                 | 登录且只能删除自己     |
| PUT `/me/favorites/{schoolId}`    | 无                            | string[]全部收藏ID   | 登录，幂等             |
| DELETE `/me/favorites/{schoolId}` | 无                            | string[]全部收藏ID   | 登录，幂等             |
| POST `/recommendations`           | riskPreference: 0–100整数     | Recommendation[]     | 登录且画像完整         |
| POST `/recommendations/explain`   | schoolId                      | text, sourceIds      | 登录                   |
| PUT `/me/plan`                    | 完整Plan，含version           | 新Plan               | 登录，校验所有权与版本 |
| POST `/plans/simulations`         | planId, version               | Simulation           | 登录，校验所有权与版本 |
| POST `/posts`                     | schoolId, topic, title, body  | Post，status=pending | 登录                   |
| POST `/posts/{postId}/feedback`   | kind, reason                  | accepted             | 登录；投票另需认证     |
| POST `/verifications`             | multipart: schoolId, document | Verification         | 登录                   |
| GET `/admin/reviews`              | 无                            | Post[]待审队列       | reviewer / admin       |
| POST `/admin/reviews/{postId}`    | decision, reason              | Post                 | reviewer / admin       |
| POST `/chat/stream`               | message, conversationId?      | SSE事件流            | 登录                   |

### Bootstrap 聚合视图

```typescript
interface Bootstrap {
  user: User | null;
  profile: Profile | null;
  schools: School[];
  posts: Post[];
  sources: Source[];
  plan: Plan;
  favorites: string[];
  verifications: Verification[];
}
```

当前采用有限集合的聚合快照，方便后端模块尚未完成时先联调。推荐项 `schoolId/postIds/sourceIds`、星图详情和回声详情必须能在快照中解析。审核队列通过独立接口刷新，用户投稿后前端重新请求快照。

**院校专属回声页（v0.3）：**前端路由为 `/#/echoes/{schoolId}`（如 `/#/echoes/hdu`），不是新增 HTTP 接口。当前从 `Bootstrap.schools` 精确匹配院校，只展示 `Post.schoolId === schoolId && Post.status === "published"` 的来信，再在本校集合内应用主题、关键词和强信号筛选。本校来信数也只统计公开内容。未知院校显示不存在；已知但无来信的院校显示空态，不借用其他学校的内容。服务端仍须对快照内的未公开帖子执行权限控制，不能依赖前端过滤保护数据。

星图航行及停靠位置属于本地交互状态，不产生招生、投稿或个人档案写请求。来信详情返回其自身 `schoolId` 对应的回声页；投稿入口预选当前院校，但仍允许作者选择真实所属院校，正式投稿沿用 `POST /posts` 的 `schoolId` 字段及权限校验。`/#/echoes` 兼容入口恢复最近查看的有效院校，无记录时选择有公开来信的首所院校；始终只展示一校。

**容量边界：**本版本不是全量全国院校的分页客户端。院校与帖子筛选在浏览器内完成，只能筛选已加载集合；不得将一个截断后的快照伪装成全站查询结果。后端可以先提供目标省份的小规模完整视图。上线全国数据前，双方应新增分页学校 / 帖子检索、详情按ID加载、证据批量解析接口，再改造相应页面；不要直接把全部帖子、向量或认证材料打进 Bootstrap。

### Profile

示例（示例分数不是填报依据）：

```json
{
  "province": "浙江",
  "year": 2026,
  "score": 628,
  "rank": 23500,
  "subjects": ["物理", "化学", "生物"],
  "cities": ["杭州", "南京", "上海"],
  "interests": ["计算机科学与技术"],
  "budget": 10000,
  "acceptAdjustment": true,
  "consent": true
}
```

前端校验：省份非空；年份2024–2035；整数分数0–900；正整数位次至500万；三门不重复选科；非负学费预算；授权为true。**这些只是基本格式校验**，后端必须按省份、当年考试模式与可用数据再校验。传统文理、新高考3+1+2的组合合法性、赋分口径等未在本版前端编码；不支持时返回明确422。

### 推荐、冲稳保和依据

`riskPreference` 0 为偏稳妥、100 为偏挑战。后端用已保存的画像生成结果，检查选科、性别 / 体检等官方限制（如适用）、预算、校区、专业组、招生计划变化；不得把“学校最低位次”直接当“该专业录取位次”。`matchScore` 仅表示偏好匹配，UI明确标为“非录取概率”。

```json
{
  "schoolId": "hdu",
  "major": "计算机科学与技术",
  "tier": "match",
  "matchScore": 92,
  "reasons": ["符合选科要求与城市偏好"],
  "warnings": ["需核对当年计划"],
  "sourceIds": ["official-hdu", "inference-01"],
  "postIds": ["p1"]
}
```

`tier` 枚举 reach / match / safe，对应 ▲冲 / ●稳 / ■保。后端是最终分类来源。星图和工作台当前的颜色是示例位次规则的视觉辅助，不能覆盖正式后端推荐结论。生产要统一分类，可把服务端分类加入School和Plan响应，修改两处展示逻辑。

引用强度、年份和政策时效必须透明；单篇弱信号不得作为唯一依据；官方与体验冲突应同时返回并解释适用范围。本版院校页的差异提示是通用演示，不是实际冲突检测结果。

### 志愿保存与检查

`entries` 数组顺序是填报草案顺序，每项拥有稳定ID；拖动只改变数组位置。一个条目包含 `schoolId/major/adjustment`。前端v0.1演示采用“院校＋一个专业”的简化结构；不是任何省份的官方专业组表单。

```json
{
  "id": "my-plan",
  "version": 3,
  "name": "我的志愿草案",
  "entries": [
    {
      "id": "entry-01",
      "schoolId": "hdu",
      "major": "计算机科学与技术",
      "adjustment": true
    }
  ]
}
```

服务端在事务内检查传入version等于当前版本，成功更新为4；不相等返回409。校验用户所有权、schoolId存在、专业归属、同院校专业重复、当省可填数量。当前契约上限40，**不是全国统一规定**；确定目标省份后应以配置驱动替换固定值。

检查结果的 `probabilities` 固定为null。本版只显示报考条件、冲稳保结构和提示。平行志愿的顺序影响检索顺序，不应仅因为拖动顺序就宣称某校录取概率上升。没有可信概率模型时不要给出百分比“滑档率”。CSV在浏览器导出；PDF由浏览器打印保存，无额外下载API。

### 帖子可信度与人工复核

`Post.signal`: strong / medium / weak / disputed；`status`: pending / published / rejected。信号强度和发布状态相互独立，审核通过不自动等于strong。发布申请只接收四个创作字段，不接受客户端评分、身份或审核状态。

`Trust` 的五个0–100分对应 identity、specificity、corroboration、freshness、anomaly。注意anomaly为**异常安全度：分数越高异常越少**。explanation必须是同序的5条人话解释；supporting与opposing为独立证据计数，不是账号点赞数；expiresAt与version用于过期警示与可追溯规则版本。

`kind=helpful/disagree` 需已认证且对同用户同帖子同类别幂等，不能每次点击加票。`appeal` 需登录、reason至少10字，进入复核待办。人工审核reason至少5字，服务端记操作人、时间、原状态、决定、规则版本；并发处理已不在pending的记录返回409。当前页面提供投稿审核，专门的举报队列、规则编辑、聚类图和运营统计不是本版已实现功能。

### 认证文件

请求`multipart/form-data`，由浏览器自动设置boundary，不要手动设置Content-Type。`schoolId`为文本，`document`为单个文件。前端限制JPEG/PNG/PDF、最大5MiB。后端仍需核查真实文件签名、容量、恶意载荷、访问权和速率，上传成功不代表身份已认证。

返回申请ID、status、schoolId与submittedAt；禁止公开原件URL。材料仅用于身份验证，建议原件审核完成后按明确期限清除，公开展示到专业大类 / 年级即可。Mock只记录申请状态，不读取或持久化原件。

## 5. POST SSE协议

前端用fetch流式读取（原生EventSource不支持POST请求体）。HTTP响应：

```http
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
X-Accel-Buffering: no
```

事件顺序允许交错工具执行状态与回答；所有事件的`data`必须为一条完整JSON，空行结尾。`event`名称可同时提供，前端以JSON中的`type`为准。

```text
event: tool_start
data: {"type":"tool_start","tool":"official_search","text":"查询2025年浙江招生专业组位次"}

event: tool_end
data: {"type":"tool_end","tool":"official_search","text":"已找到3条官方来源"}

event: delta
data: {"type":"delta","text":"结合你的选科，可以进一步核对…"}

event: evidence
data: {"type":"evidence","sourceIds":["official-hdu","experience-p1","inference-01"]}

event: done
data: {"type":"done","conversationId":"conv-01"}

```

异常：`data: {"type":"error","text":"官方数据服务暂不可用，请稍后重试"}`，然后关闭连接；建立流前发生鉴权 / 输入错误用普通JSON非2xx返回。正常必须发done并关闭，否则前端标记连接中断。心跳可用`: heartbeat\n\n`，解析器忽略注释。前端处理UTF-8分块、CRLF分隔与多个事件共块；不把未完成JSON片段当成成功结果。

用户点击停止或关闭抽屉会AbortController中止请求，FastAPI应检查客户端断连并取消工具任务。工具事件只公开“查了什么、查到什么”的状态，**不传输隐藏思维链、内部提示词、密钥或认证材料**。conversationId必须绑定当前用户，禁止越权复用他人会话。当前聊天组件在关闭抽屉后清空内存消息，不承诺聊天历史同步。

## 6. FastAPI接入参考

以下是协议片段，不是已实现后端。实现时使用自身的session存储、Pydantic模型与权限依赖。

```python
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import json

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type", "X-Requested-With"],
)

def ok(data, request_id):
    return {"data": data, "requestId": request_id}

def fail(status, code, message, request_id):
    return JSONResponse(status_code=status, content={
        "error": {"code": code, "message": message},
        "requestId": request_id,
    })

def sse(event):
    return f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"

# 在router/依赖中：先鉴权、校验Origin、校验X-Requested-With，
# 再调用画像、官方数据、帖子检索、推荐与结果校验服务。
# async generator 定期检查 await request.is_disconnected()。
# return StreamingResponse(events(), media_type="text/event-stream",
#   headers={"Cache-Control":"no-cache, no-transform", "X-Accel-Buffering":"no"})
```

资料：[React TypeScript](https://react.dev/learn/typescript)、[Vite环境变量](https://vite.dev/guide/env-and-mode)、[FastAPI CORS](https://fastapi.tiangolo.com/tutorial/cors/)。

## 7. 联调顺序与尚需确认

1. 先实现登录与裁剪后的bootstrap；验证匿名不泄露画像、认证原件或别人的待审内容。
2. 实现Profile、Sources与推荐模块；用一个省份的真实来源校验口径一致性，验证不满足条件返回422。
3. 实现Plan乐观锁；模拟两个客户端同时更新，第二个必须409。
4. 打通POST SSE与证据ID；检查代理不缓冲、断网可见错误、停止请求能取消任务。
5. 实现投稿→可信度计算→队列→人工决策；最后接认证材料、反馈幂等、数据删除和审计。

正式使用前双方必须确定：目标省份与高考模式、志愿单位是院校专业组还是专业＋院校、年份及位次数据来源、账号注册 / 找回方案、认证资料保留期限、帖子来源和授权、可信度模型的指标含义、推荐验证基线，以及全国数据分页协议。当前UI是可评审和可联调的实现，不包含这些尚未指定的后台业务。
