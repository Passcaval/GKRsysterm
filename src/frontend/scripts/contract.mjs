import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = (extra = {}) => ({ type: "string", ...extra });
const int = (extra = {}) => ({ type: "integer", ...extra });
const bool = { type: "boolean" };
const arr = (items) => ({ type: "array", items });
const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required,
});
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const en = (values) => str({ enum: values });
const schemas = {
  User: obj({
    id: str(),
    name: str(),
    role: en(["student", "contributor", "reviewer", "admin"]),
    verified: bool,
  }),
  Profile: obj({
    province: str({ description: "生源省份中文简称，如浙江" }),
    year: int({ minimum: 2024, maximum: 2035 }),
    score: int({
      minimum: 0,
      maximum: 900,
      description: "省份特定满分与赋分要求由后端校验",
    }),
    rank: int({ minimum: 1, maximum: 5000000 }),
    subjects: { ...arr(str()), minItems: 3, maxItems: 3, uniqueItems: true },
    cities: arr(str()),
    interests: arr(str()),
    budget: int({ minimum: 0 }),
    acceptAdjustment: bool,
    consent: { type: "boolean", const: true },
  }),
  Source: obj({
    id: str(),
    kind: en(["official", "experience", "inference"]),
    title: str(),
    url: nullable(
      str({
        format: "uri",
        description: "真实官方来源必须给出原文 HTTPS URL；演示可为 null",
      }),
    ),
    year: int(),
    retrievedAt: str({ format: "date-time" }),
    excerpt: str(),
  }),
  School: obj({
    id: str(),
    name: str(),
    short: str(),
    city: str(),
    province: str(),
    level: str(),
    type: str(),
    rank: int({
      minimum: 1,
      description: "仅可同省、同批次、同选科、同专业组比较的历史位次",
    }),
    tuition: int({ minimum: 0 }),
    majors: arr(str()),
    requiredSubjects: arr(str()),
    description: str(),
    color: str({ pattern: "^#[0-9a-fA-F]{6}$" }),
    x: { type: "number", minimum: 0, maximum: 100 },
    y: { type: "number", minimum: 0, maximum: 100 },
    sourceIds: arr(str()),
    history: arr(obj({ year: int(), rank: int(), score: int() })),
  }),
  Trust: obj({
    identity: int({ minimum: 0, maximum: 100 }),
    specificity: int({ minimum: 0, maximum: 100 }),
    corroboration: int({ minimum: 0, maximum: 100 }),
    freshness: int({ minimum: 0, maximum: 100 }),
    anomaly: int({
      minimum: 0,
      maximum: 100,
      description: "越高表示异常安全度越高，非异常概率",
    }),
    supporting: int({ minimum: 0 }),
    opposing: int({ minimum: 0 }),
    explanation: { ...arr(str()), minItems: 5, maxItems: 5 },
    expiresAt: str({ format: "date" }),
    version: str(),
  }),
  Post: obj({
    isMine: bool,
    id: str(),
    schoolId: str(),
    title: str(),
    excerpt: str(),
    body: str(),
    topic: str(),
    author: str({ description: "脱敏展示名，不能包含实名、学号或联系方式" }),
    year: int(),
    signal: en(["strong", "medium", "weak", "disputed"]),
    helpful: int({ minimum: 0 }),
    citations: int({ minimum: 0 }),
    status: en(["published", "pending", "rejected"]),
    trust: ref("Trust"),
    sourceIds: arr(str()),
  }),
  Recommendation: obj({
    schoolId: str(),
    major: str(),
    tier: en(["reach", "match", "safe"]),
    matchScore: int({
      minimum: 0,
      maximum: 100,
      description: "偏好匹配度，不得当作录取概率",
    }),
    reasons: arr(str()),
    warnings: arr(str()),
    sourceIds: arr(str()),
    postIds: arr(str()),
  }),
  PlanEntry: obj({
    id: str(),
    schoolId: str(),
    major: str(),
    adjustment: bool,
  }),
  Plan: obj({
    id: str(),
    version: int({ minimum: 1 }),
    name: str(),
    entries: { ...arr(ref("PlanEntry")), maxItems: 40 },
  }),
  Simulation: obj({
    eligible: bool,
    warnings: arr(str()),
    assessment: str(),
    basisYear: int(),
    probabilities: {
      type: "null",
      description: "v0.1 不提供未经校准的录取概率",
    },
  }),
  Verification: obj({
    id: str(),
    status: en(["pending", "approved", "rejected"]),
    schoolId: str(),
    submittedAt: str({ format: "date-time" }),
  }),
  Error: obj({
    error: obj(
      {
        code: str(),
        message: str(),
        details: arr(obj({ field: str(), message: str() })),
      },
      ["code", "message"],
    ),
    requestId: str(),
  }),
  LoginRequest: obj({
    login_type: en(["email", "user_id"]),
    identifier: str({ minLength: 1, maxLength: 254 }),
    password: str({ minLength: 1, maxLength: 256 }),
  }),
  PostInput: obj({
    schoolId: str(),
    topic: str(),
    title: str({ minLength: 5, maxLength: 80 }),
    body: str({ minLength: 80, maxLength: 10000 }),
  }),
  FeedbackInput: obj(
    {
      kind: en(["helpful", "disagree", "appeal"]),
      reason: str({ maxLength: 2000 }),
    },
    ["kind"],
  ),
  ReviewInput: obj({
    decision: en(["approve", "reject"]),
    reason: str({ minLength: 5, maxLength: 2000 }),
  }),
  ChatRequest: obj(
    { message: str({ minLength: 1, maxLength: 4000 }), conversationId: str() },
    ["message"],
  ),
  ChatEvent: {
    oneOf: [
      ...["tool_start", "tool_end"].map((type) =>
        obj({
          type: { const: type, type: "string" },
          tool: str(),
          text: str(),
        }),
      ),
      obj({ type: { const: "delta", type: "string" }, text: str() }),
      obj({
        type: { const: "evidence", type: "string" },
        sourceIds: arr(str()),
      }),
      obj({ type: { const: "done", type: "string" }, conversationId: str() }),
      obj({ type: { const: "error", type: "string" }, text: str() }),
    ],
  },
};
schemas.Bootstrap = obj({
  user: nullable(ref("User")),
  profile: nullable(ref("Profile")),
  schools: arr(ref("School")),
  posts: arr(ref("Post")),
  sources: arr(ref("Source")),
  plan: ref("Plan"),
  favorites: arr(str()),
  verifications: arr(ref("Verification")),
});
const envelope = (schema) => obj({ data: schema, requestId: str() });
const json = (schema) => ({ "application/json": { schema } });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503].map((status) => [
    status,
    {
      description:
        {
          401: "会话过期或未登录",
          403: "权限不足",
          409: "版本冲突",
          422: "字段或省份规则校验失败",
          429: "限流",
        }[status] || "请求失败",
      content: json(ref("Error")),
    },
  ]),
);
const paths = {};
function operation(
  path,
  method,
  summary,
  schema,
  { input, publicAccess = false, form = false, description = "" } = {},
) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: str(),
  }));
  if (method !== "get")
    parameters.push({
      name: "X-Requested-With",
      in: "header",
      required: true,
      schema: { type: "string", const: "NightVoyage" },
      description:
        "结合严格 Origin 白名单与 SameSite cookie 校验 CSRF。文件上传也必须携带。",
    });
  paths[path] ??= {};
  paths[path][method] = {
    operationId: method + "_" + path.replace(/[^a-zA-Z0-9]/g, "_"),
    summary,
    description,
    security: publicAccess ? [] : [{ session: [] }],
    ...(parameters.length ? { parameters } : {}),
    ...(input
      ? {
          requestBody: {
            required: true,
            content: form
              ? { "multipart/form-data": { schema: input } }
              : json(input),
          },
        }
      : {}),
    responses: {
      200: {
        description: "成功，空操作也返回 JSON data:null，不使用 204",
        content: json(envelope(schema)),
      },
      ...errors,
    },
  };
}
operation("/bootstrap", "get", "加载当前可见的初始视图", ref("Bootstrap"), {
  publicAccess: true,
  description:
    "v0.1 聚合快照。匿名返回公开院校与已发布帖子，个人字段为空；仅审核员可收到完整待审内容。所有 sourceIds 必须可解析。当前前端对快照做本地筛选，不适用于无限数据集合。",
});
operation(
  "/auth/login",
  "post",
  "统一登录：由服务端确定身份并设置 HttpOnly 安全会话",
  ref("User"),
  {
    input: ref("LoginRequest"),
    publicAccess: true,
    description:
      "沿用统一登录请求。login_type仅为标识类型，不是校验结果或用户角色。后端独立校验邮箱或系统ID，格式不合格返回422，error.message须包含原因和重新输入提示；合法格式但认证失败返回统一401，不泄露账号是否存在。",
  },
);
paths["/auth/login"].post.responses[422] = {
  description:
    "后端校验标识失败；不签发会话。前端沿用现有错误展示，保留输入并允许修改重试。",
  content: {
    "application/json": {
      schema: ref("Error"),
      examples: {
        invalidEmail: {
          value: {
            error: {
              code: "EMAIL_INVALID",
              message: "邮箱格式不正确，请重新输入。",
              details: [
                {
                  field: "identifier",
                  message: "请输入符合格式要求的邮箱地址",
                },
              ],
            },
            requestId: "req-email-invalid",
          },
        },
        invalidIdentifier: {
          value: {
            error: {
              code: "IDENTIFIER_INVALID",
              message: "邮箱或用户 ID 格式不正确，请重新输入。",
              details: [
                {
                  field: "identifier",
                  message: "请输入有效邮箱或系统分配的用户 ID",
                },
              ],
            },
            requestId: "req-identifier-invalid",
          },
        },
      },
    },
  },
};
operation("/auth/logout", "post", "退出并吊销会话", { type: "null" });
operation("/me/profile", "put", "完整替换考生档案", ref("Profile"), {
  input: ref("Profile"),
});
operation(
  "/me/data",
  "delete",
  "删除当前用户可删除的个人数据",
  { type: "null" },
  {
    description:
      "删除画像、收藏、志愿、认证材料与未发布投稿；已发布内容匿名化。法定保留的审计记录需告知。撤销未结束会话/任务。",
  },
);
for (const method of ["put", "delete"])
  operation(
    "/me/favorites/{schoolId}",
    method,
    method === "put" ? "收藏院校（幂等）" : "取消收藏（幂等）",
    arr(str()),
  );
operation(
  "/recommendations",
  "post",
  "按档案与风险偏好生成建议",
  arr(ref("Recommendation")),
  {
    input: obj({ riskPreference: int({ minimum: 0, maximum: 100 }) }),
    description:
      "后端完成选科、学费、政策与省份条件校验，不兼容的高考模式返回422。不得仅用单篇弱信号帖子形成结论。",
  },
);
operation(
  "/recommendations/explain",
  "post",
  "解释院校被排除或纳入的原因",
  obj({ text: str(), sourceIds: arr(str()) }),
  { input: obj({ schoolId: str() }) },
);
operation("/me/plan", "put", "整体保存志愿顺序并校验版本", ref("Plan"), {
  input: ref("Plan"),
  description:
    "version为客户端读到的版本；原子 compare-and-swap，冲突409；entries数组顺序即志愿顺序。服务端校验专业归属、重复院校专业、当前省份志愿个数。",
});
operation(
  "/plans/simulations",
  "post",
  "检查指定版本的志愿方案",
  ref("Simulation"),
  {
    input: obj({ planId: str(), version: int({ minimum: 1 }) }),
    description:
      "必须核验方案所有权与版本，过期409。v0.1为条件及结构检查，不提供录取概率。",
  },
);
operation("/posts", "post", "提交匿名来信进入审核", ref("Post"), {
  input: ref("PostInput"),
  description:
    "初始状态pending。由服务端完成清洗、隐私与广告识别、可信度计算，客户端不能提交signal、trust、author或status。",
});
operation(
  "/posts/{postId}/feedback",
  "post",
  "提交帮助投票、不同体验或可信度申诉",
  obj({ accepted: bool }),
  {
    input: ref("FeedbackInput"),
    description:
      "helpful/disagree需认证用户且每用户每帖每类幂等；appeal需登录且reason至少10字。生成申诉/反馈记录，供人工复核。",
  },
);
operation(
  "/verifications",
  "post",
  "上传脱敏后的身份凭证",
  ref("Verification"),
  {
    input: obj({ schoolId: str(), document: str({ format: "binary" }) }),
    form: true,
    description:
      "仅JPG/PNG/PDF，5MiB以内，服务端校验真实magic bytes、病毒与解压炸弹，私有加密存储，禁止公开URL。",
  },
);
operation("/admin/reviews", "get", "获取审核员可见待审队列", arr(ref("Post")), {
  description:
    "要求reviewer或admin，普通用户403。包含待审帖子、可信度分项和可见证据；不授予注册审批权限。",
});
operation(
  "/admin/reviews/{postId}",
  "post",
  "记录人工决定并转换状态",
  ref("Post"),
  {
    input: ref("ReviewInput"),
    description:
      "reviewer或admin可用；pending→published或rejected，已处理返回409；写入不可变审计记录。",
  },
);
operation("/chat/stream", "post", "POST SSE流式Agent对话", ref("ChatEvent"), {
  input: ref("ChatRequest"),
  description:
    "详见接口说明SSE章节。每条data为完整JSON ChatEvent，必须以done结束；错误使用error。禁止返回模型隐藏思维链，只提供工具公开执行状态。引用的学校、帖子与证据必须在bootstrap中可解析。",
});
paths["/chat/stream"].post.responses[200] = {
  description:
    "text/event-stream; charset=utf-8，UTF-8 SSE，不包data/requestId响应信封",
  content: {
    "text/event-stream": {
      schema: str(),
      example:
        'event: delta\ndata: {"type":"delta","text":"可以先了解…"}\n\nevent: done\ndata: {"type":"done","conversationId":"conv-01"}\n\n',
    },
  },
  "x-event-schema": ref("ChatEvent"),
};
const contract = {
  openapi: "3.1.0",
  info: {
    title: "夜航 Night Voyage · 前后端对接契约",
    version: "0.1.0",
    description:
      "基于技术方案的新增接口设计提案，非既有后端接口。与src/api.ts同步；中文说明见docs/API.md。",
  },
  servers: [
    { url: "http://127.0.0.1:8000/api/v1", description: "FastAPI本地联调" },
  ],
  paths,
  components: {
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "nv_session",
        description: "HttpOnly; Secure(生产); SameSite=Lax；服务端存会话和角色",
      },
    },
    schemas,
  },
};
const outputs = [
  new URL("../docs/openapi.json", import.meta.url),
  new URL("../../../docs/contracts/openapi.json", import.meta.url),
];
const serialized = JSON.stringify(contract, null, 2) + "\n";
const check = process.argv.includes("--check");
for (const output of outputs) {
  if (check) {
    let actual;
    try {
      actual = readFileSync(output, "utf8");
    } catch {
      throw new Error(
        `Missing contract: ${output.pathname}; run pnpm run contract`,
      );
    }
    if (actual.replace(/\r\n/g, "\n") !== serialized)
      throw new Error(
        `Stale contract: ${output.pathname}; run pnpm run contract`,
      );
  } else {
    mkdirSync(new URL(".", output), { recursive: true });
    writeFileSync(output, serialized);
  }
}
console.log(
  `OpenAPI ${check ? "verified" : "generated"} in both locations: ${Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0)} operations, ${Object.keys(schemas).length} schemas`,
);
