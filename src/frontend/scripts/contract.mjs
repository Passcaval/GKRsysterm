import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
const ref = (name) => ({ $ref: "#/components/schemas/" + name });
const str = (extra = {}) => ({ type: "string", ...extra });
const num = (extra = {}) => ({ type: "number", ...extra });
const int = (extra = {}) => ({ type: "integer", ...extra });
const bool = { type: "boolean" };
const arr = (items) => ({ type: "array", items });
const nullable = (s) => ({ anyOf: [s, { type: "null" }] });
const en = (values) => str({ enum: values });
const obj = (properties, required = Object.keys(properties), extra = {}) => ({
  type: "object",
  properties,
  required,
  additionalProperties: true,
  ...extra,
});
const input = (properties, required = Object.keys(properties)) =>
  obj(properties, required, { additionalProperties: false });
const id = str({ minLength: 1 });
const strings = arr(str());
const date = str({ format: "date-time" });
const statuses = [
  "queued",
  "running",
  "waiting_input",
  "validating",
  "succeeded",
  "partial",
  "failed",
  "cancelled",
];
const profileFields = {
  province_code: nullable(str()),
  exam_year: int({ minimum: 2024, maximum: 2035 }),
  exam_category: str(),
  subjects: { ...strings, uniqueItems: true, maxItems: 3 },
  score: nullable(int({ minimum: 0, maximum: 900 })),
  rank: nullable(int({ minimum: 1, maximum: 5000000 })),
  rank_cohort: nullable(str()),
  budget: obj({
    amount: nullable(num({ minimum: 0 })),
    currency: en(["CNY"]),
    period: en(["year"]),
    scope: en(["tuition", "total"]),
  }),
  preferred_regions: strings,
  preferred_majors: strings,
  preferred_schools: { ...strings, maxItems: 30 },
  accept_adjustment: bool,
  consent: bool,
  preferences: arr(
    obj({
      field: str(),
      value: str(),
      strength: en(["hard", "soft"]),
      priority: int({ minimum: 1 }),
    }),
  ),
};
const applicationFields = {
  application_id: id,
  reserved_user_id: id,
  status: en(["pending", "approved", "rejected"]),
  version: int({ minimum: 1 }),
  nickname: str(),
  email: str(),
  created_at: date,
  reviewed_at: nullable(date),
  reason: nullable(str()),
  evidence_text: str(),
  has_audio: bool,
};
const schemas = {
  User: obj({
    id,
    user_id: id,
    nickname: str(),
    email: str(),
    email_verified: bool,
    role: en(["student", "contributor", "reviewer", "admin"]),
    student_verified: bool,
    permissions: strings,
  }),
  Profile: obj(
    {
      ...profileFields,
      version: int({ minimum: 1 }),
      profile_version_id: id,
    },
    [
      ...Object.keys(profileFields).filter(
        (key) => key !== "preferred_schools",
      ),
      "version",
      "profile_version_id",
    ],
  ),
  ProfilePatch: input(
    { ...profileFields, expected_version: int({ minimum: 0 }) },
    ["expected_version"],
  ),
  ProfileParse: obj({
    proposed_changes: obj(profileFields, []),
    missing_fields: strings,
    questions: strings,
  }),
  ProfileParseInput: input({ text: str({ minLength: 1, maxLength: 10000 }) }),
  Source: obj(
    {
      id,
      kind: en(["official", "experience", "inference"]),
      title: str(),
      url: nullable(str({ format: "uri" })),
      year: int(),
      retrieved_at: date,
      excerpt: str(),
      version: nullable(str()),
      locator: nullable(str()),
      content_hash: nullable(str()),
      support_status: en(["supported", "refuted", "unverified", "withdrawn"]),
      freshness: en(["current", "expired", "unknown"]),
      scope: nullable(str()),
    },
    ["id", "kind", "title", "url", "year", "retrieved_at", "excerpt"],
  ),
  School: obj(
    {
      id,
      name: str(),
      short: str(),
      city: str(),
      province: str(),
      level: str(),
      type: str(),
      rank: nullable(int({ minimum: 1 })),
      tuition: nullable(num({ minimum: 0 })),
      majors: strings,
      required_subjects: strings,
      description: str(),
      color: str(),
      x: num({ minimum: 0, maximum: 100 }),
      y: num({ minimum: 0, maximum: 100 }),
      source_ids: strings,
      history: arr(obj({ year: int(), rank: int(), score: num() })),
      historical_risk: en(["reach", "match", "safe", "unknown"]),
      data_version: nullable(str()),
    },
    [
      "id",
      "name",
      "short",
      "city",
      "province",
      "level",
      "type",
      "rank",
      "tuition",
      "majors",
      "required_subjects",
      "description",
      "color",
      "x",
      "y",
      "source_ids",
      "history",
    ],
  ),
  Trust: obj({
    identity: nullable(num({ minimum: 0, maximum: 100 })),
    specificity: nullable(num({ minimum: 0, maximum: 100 })),
    corroboration: nullable(num({ minimum: 0, maximum: 100 })),
    freshness: nullable(num({ minimum: 0, maximum: 100 })),
    anomaly: nullable(num({ minimum: 0, maximum: 100 })),
    supporting: int({ minimum: 0 }),
    opposing: int({ minimum: 0 }),
    explanation: strings,
    expires_at: str(),
    version: str(),
  }),
  Claim: obj({
    id,
    text: str(),
    source_version: nullable(str()),
    support_status: en(["supported", "refuted", "unverified", "withdrawn"]),
    freshness: en(["current", "expired", "unknown"]),
    scope: nullable(str()),
    relations: arr(
      obj({
        evidence_id: id,
        relation: en(["supports", "refutes", "background"]),
      }),
    ),
  }),
  Post: obj(
    {
      id,
      school_id: id,
      is_mine: bool,
      title: str(),
      excerpt: str(),
      body: str(),
      topic: str(),
      author: str(),
      year: int(),
      signal: en(["strong", "medium", "weak", "disputed"]),
      status: en(["pending", "published", "rejected"]),
      helpful: int(),
      citations: int(),
      trust: ref("Trust"),
      source_ids: strings,
      version: int({ minimum: 1 }),
      campus_id: nullable(str()),
      major_id: nullable(str()),
      experienced_at: nullable(str()),
      visibility: en(["public", "private"]),
      claims: arr(ref("Claim")),
    },
    [
      "id",
      "school_id",
      "is_mine",
      "title",
      "excerpt",
      "body",
      "topic",
      "author",
      "year",
      "signal",
      "status",
      "helpful",
      "citations",
      "trust",
      "source_ids",
      "version",
    ],
  ),
  PlanEntry: obj(
    {
      id,
      school_id: id,
      major: str(),
      major_id: str(),
      admission_unit_id: str(),
      recommendation_item_id: str(),
      province_code: str(),
      exam_year: int(),
      adjustment: bool,
    },
    ["id", "school_id", "major", "adjustment"],
  ),
  Plan: obj(
    {
      id,
      version: int({ minimum: 0 }),
      name: str(),
      entries: arr(ref("PlanEntry")),
      max_entries: nullable(int({ minimum: 1 })),
    },
    ["id", "version", "name", "entries"],
  ),
  Simulation: obj(
    {
      eligible: nullable(bool),
      eligibility: obj({
        status: en(["pass", "fail", "unknown"]),
        reason: str(),
      }),
      warnings: strings,
      assessment: str(),
      basis_year: int(),
      probabilities: { type: "null" },
    },
    ["eligible", "warnings", "assessment", "basis_year", "probabilities"],
  ),
  Verification: obj(
    {
      id,
      school_id: id,
      status: en(["pending", "approved", "rejected"]),
      submitted_at: date,
      version: int({ minimum: 1 }),
    },
    ["id", "school_id", "status", "submitted_at"],
  ),
  Bootstrap: obj({
    user: nullable(ref("User")),
    profile: nullable(ref("Profile")),
    schools: arr(ref("School")),
    posts: arr(ref("Post")),
    sources: arr(ref("Source")),
    plan: ref("Plan"),
    favorites: strings,
    verifications: arr(ref("Verification")),
  }),
  Login: input({
    login_type: en(["email", "user_id"]),
    identifier: str({ minLength: 1 }),
    password: str({ minLength: 1 }),
  }),
  RegistrationInput: input(
    {
      nickname: str({
        minLength: 1,
        maxLength: 5,
        pattern: "^[\\p{Unified_Ideograph}A-Za-z]{1,5}$",
        description:
          "NFC后按Unicode码点计数1–5，仅Unified_Ideograph或ASCII英文字母；后端必须复核",
      }),
      email: str({ maxLength: 254 }),
      password: str({ minLength: 8, maxLength: 128 }),
      evidence_text: str({
        maxLength: 3000,
        description: "最多3000个Unicode码点",
      }),
      evidence_audio: str({
        format: "binary",
        description: "原始音频，最多120秒及10MiB；服务端复核格式与实际时长",
      }),
    },
    ["nickname", "email", "password"],
  ),
  RegistrationReceipt: obj({
    application_id: id,
    reserved_user_id: id,
    status: en(["pending", "approved", "rejected"]),
    status_token: str({ minLength: 16 }),
  }),
  RegistrationStatus: obj(applicationFields, [
    "application_id",
    "reserved_user_id",
    "status",
    "version",
    "created_at",
    "reason",
  ]),
  RegistrationDetail: obj(applicationFields, [
    "application_id",
    "reserved_user_id",
    "status",
    "version",
    "nickname",
    "email",
    "created_at",
    "reason",
    "evidence_text",
    "has_audio",
  ]),
  Decision: input({
    decision: en(["approve", "reject"]),
    reason: str(),
    expected_version: int({ minimum: 1 }),
  }),
  Question: obj({ field: id, text: str(), required: bool }),
  RecommendationItem: obj(
    {
      recommendation_item_id: id,
      admission_unit_id: id,
      school_id: id,
      school_name: str(),
      campus_id: nullable(str()),
      major: str(),
      major_id: str(),
      eligibility: obj({
        status: en(["pass", "fail", "unknown"]),
        missing_requirements: strings,
      }),
      historical_risk: obj({
        status: en(["reach", "match", "safe", "unknown"]),
        reason: str(),
      }),
      preference_match: obj({
        score: nullable(num({ minimum: 0, maximum: 100 })),
        coverage: num({ minimum: 0, maximum: 1 }),
        breakdown: arr(obj({ label: str(), score: nullable(num()) })),
      }),
      reasons: strings,
      evidence_ids: strings,
      warnings: strings,
    },
    [
      "recommendation_item_id",
      "admission_unit_id",
      "school_id",
      "campus_id",
      "major",
      "eligibility",
      "historical_risk",
      "preference_match",
      "reasons",
      "evidence_ids",
      "warnings",
    ],
  ),
  Run: obj({
    run_id: id,
    status: en(statuses),
    version: int({ minimum: 1 }),
    question: str(),
    profile_version_id: nullable(str()),
    original_profile_version_id: nullable(str()),
    data_version: nullable(str()),
    rule_version: nullable(str()),
    created_at: date,
    questions: arr(ref("Question")),
    items: arr(ref("RecommendationItem")),
    validation: obj({
      status: en(["pending", "passed", "failed"]),
      summary: str(),
    }),
    last_event_id: int({ minimum: 0 }),
    summary: str(),
    error: nullable(str()),
  }),
  RunAccepted: obj({ run_id: id, status: en(statuses) }, ["run_id", "status"]),
  CreateRun: input({
    question: str({ minLength: 1, maxLength: 4000 }),
    profile_version_id: nullable(str()),
    risk_preference: int({ minimum: 0, maximum: 100 }),
    intent: en(["campus_life", "admission", "risk"]),
  }),
  RunAnswers: input({
    expected_version: int({ minimum: 1 }),
    answers: obj({}, [], { additionalProperties: str() }),
  }),
  RunCancel: input({ expected_version: int({ minimum: 1 }) }),
  RunEvent: obj({
    event_id: int({ minimum: 1 }),
    event_type: en(["status", "question", "result", "error", "done"]),
    run_id: id,
    timestamp: date,
    payload: obj({}, [], { additionalProperties: true }),
  }),
  RecommendationFeedback: input({
    run_id: id,
    recommendation_item_id: id,
    kind: en(["preference", "correction"]),
    reason: str({ minLength: 1, maxLength: 3000 }),
  }),
  Accepted: obj({ accepted: bool }),
  PostInput: input(
    {
      school_id: id,
      topic: str(),
      title: str({ minLength: 5, maxLength: 200 }),
      body: str({ minLength: 80, maxLength: 10000 }),
      campus_id: nullable(str()),
      major_id: nullable(str()),
      experienced_at: nullable(str()),
      visibility: en(["public", "private"]),
      originality: en(["original"]),
    },
    ["school_id", "topic", "title", "body"],
  ),
  PostPatch: input(
    {
      title: str({ minLength: 5, maxLength: 200 }),
      body: str({ minLength: 80, maxLength: 10000 }),
      visibility: en(["public", "private"]),
      expected_version: int({ minimum: 1 }),
    },
    ["expected_version"],
  ),
  ExpectedVersion: input({ expected_version: int({ minimum: 1 }) }),
  PostFeedback: input(
    { kind: en(["helpful", "disagree", "appeal"]), reason: str() },
    ["kind", "reason"],
  ),
  AdmissionUnit: obj({
    id,
    school_id: id,
    campus_id: nullable(str()),
    campus_name: nullable(str()),
    unit_type: str(),
    province_code: str(),
    exam_year: int(),
    exam_category: str(),
    batch: str(),
    code: nullable(str()),
    majors: arr(obj({ id, name: str() })),
    required_subjects: strings,
    data_version: str(),
    source_ids: strings,
  }),
  UnitHistory: obj({
    comparable: bool,
    reason: str(),
    items: arr(
      obj({
        year: int(),
        unit_type: str(),
        minimum_filing_rank: nullable(int()),
        major_admission_rank: nullable(int()),
        source_ids: strings,
      }),
    ),
  }),
  History: obj({
    run_id: id,
    question: str(),
    status: en(statuses),
    created_at: date,
    profile_version_id: nullable(str()),
  }),
  Memory: obj({
    id,
    version: int({ minimum: 1 }),
    field: str(),
    value: str(),
    confirmed: bool,
  }),
  MemoryPatch: input({
    value: str(),
    confirmed: { type: "boolean", const: true },
    expected_version: int({ minimum: 1 }),
  }),
  Sharing: obj({ enabled: bool }),
  Error: obj({
    error: obj({
      code: id,
      message: str(),
      details: obj({}, [], { additionalProperties: true }),
    }),
    request_id: id,
  }),
  ChatEvent: obj(
    {
      type: en([
        "tool_start",
        "tool_end",
        "delta",
        "evidence",
        "done",
        "error",
      ]),
      text: str(),
      tool: str(),
      source_ids: strings,
      conversation_id: str(),
    },
    ["type"],
  ),
};
const pageOf = (name) =>
  obj({ items: arr(ref(name)), next_cursor: nullable(str()) });
for (const name of [
  "School",
  "Post",
  "AdmissionUnit",
  "RegistrationDetail",
  "Verification",
])
  schemas[name + "Page"] = pageOf(name);
const paths = {};
const json = (schema) => ({ "application/json": { schema } });
const envelope = (schema) => obj({ data: schema, request_id: id });
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 410, 413, 415, 422, 429, 500, 502, 503].map(
    (status) => [
      status,
      {
        description: "结构化错误：保留code、details、request_id",
        content: json(ref("Error")),
      },
    ],
  ),
);
function operation(
  path,
  method,
  summary,
  output,
  {
    body,
    code = 200,
    publicAccess = false,
    form = false,
    key = false,
    headers = [],
    query = [],
  } = {},
) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: id,
  }));
  if (method !== "get")
    parameters.push({
      name: "X-Requested-With",
      in: "header",
      required: true,
      schema: { type: "string", const: "NightVoyage" },
    });
  if (key)
    parameters.push({
      name: "Idempotency-Key",
      in: "header",
      required: true,
      schema: id,
      description:
        "同账号、同路径、同键同内容重试返回同一业务对象；不同内容409",
    });
  for (const name of headers)
    parameters.push({
      name,
      in: "header",
      required: name === "X-Application-Token",
      schema: str(),
    });
  for (const name of query)
    parameters.push({ name, in: "query", required: false, schema: str() });
  paths[path] ??= {};
  paths[path][method] = {
    operationId: method + "_" + path.replace(/[^a-zA-Z0-9]/g, "_"),
    summary,
    security: publicAccess ? [] : [{ session: [] }],
    parameters,
    ...(body
      ? {
          requestBody: {
            required: true,
            content: form
              ? { "multipart/form-data": { schema: body } }
              : json(body),
          },
        }
      : {}),
    responses: {
      [code]: {
        description: "成功；删除操作仍返回data:null，不使用204",
        content: json(envelope(output)),
      },
      ...errors,
    },
  };
}
operation(
  "/bootstrap",
  "get",
  "首屏聚合快照；不代表全量列表",
  ref("Bootstrap"),
  { publicAccess: true },
);
operation("/auth/login", "post", "邮箱或系统用户ID登录", ref("User"), {
  body: ref("Login"),
  publicAccess: true,
});
operation("/auth/logout", "post", "撤销当前正式会话", { type: "null" });
operation("/auth/me", "get", "本人正式会话", ref("User"));
operation(
  "/registration-applications",
  "post",
  "提交注册申请，保持未登录",
  ref("RegistrationReceipt"),
  {
    body: ref("RegistrationInput"),
    code: 202,
    publicAccess: true,
    form: true,
    key: true,
  },
);
operation(
  "/registration-applications/{application_id}",
  "get",
  "凭独立查询凭据获取申请状态",
  ref("RegistrationStatus"),
  { publicAccess: true, headers: ["X-Application-Token"] },
);
operation(
  "/admin/registration-applications",
  "get",
  "注册管理员待审队列",
  ref("RegistrationDetailPage"),
  { query: ["status", "cursor"] },
);
operation(
  "/admin/registration-applications/{application_id}",
  "get",
  "原始文字与音频证据详情，不返回密码及查询凭据",
  ref("RegistrationDetail"),
);
operation(
  "/admin/registration-applications/{application_id}/decision",
  "post",
  "批准普通账号或驳回释放待审占用",
  ref("RegistrationDetail"),
  { body: ref("Decision"), key: true },
);
operation(
  "/admin/registration-applications/{application_id}/audio",
  "get",
  "受保护原始语音",
  { type: "string" },
);
paths[
  "/admin/registration-applications/{application_id}/audio"
].get.responses[200] = {
  description: "受会话与对象权限保护的原始音频；不套JSON信封",
  content: { "audio/*": { schema: str({ format: "binary" }) } },
};
operation(
  "/me/profile",
  "get",
  "当前画像和不可变版本标识",
  nullable(ref("Profile")),
);
operation(
  "/me/profile",
  "patch",
  "局部更新画像，未填分数/位次保持null",
  ref("Profile"),
  { body: ref("ProfilePatch") },
);
operation(
  "/me/profile/parse",
  "post",
  "提取建议，等待用户确认",
  ref("ProfileParse"),
  { body: ref("ProfileParseInput") },
);
operation(
  "/me/profile/versions",
  "get",
  "本人画像历史版本",
  arr(ref("Profile")),
);
operation("/me/data", "delete", "清除可删除个人数据与共享授权", {
  type: "null",
});
for (const method of ["put", "delete"])
  operation("/me/favorites/{school_id}", method, "本人院校收藏", strings);
operation("/schools", "get", "服务端院校分页检索", ref("SchoolPage"), {
  publicAccess: true,
  query: ["query", "city", "major", "cursor"],
});
operation("/schools/{school_id}", "get", "院校详情按ID读取", ref("School"), {
  publicAccess: true,
});
operation(
  "/admission-units",
  "get",
  "按院校及招生口径读取招生单位",
  ref("AdmissionUnitPage"),
  { publicAccess: true, query: ["school_id", "cursor"] },
);
operation(
  "/admission-units/{unit_id}/history",
  "get",
  "区分投档最低位次与专业录取位次",
  ref("UnitHistory"),
  { publicAccess: true },
);
operation(
  "/recommendations",
  "post",
  "创建持久任务，仅返回任务句柄",
  ref("RunAccepted"),
  { body: ref("CreateRun"), code: 202, key: true },
);
operation(
  "/recommendations/{run_id}",
  "get",
  "任务状态与已校验结果",
  ref("Run"),
);
operation(
  "/recommendations/{run_id}/events",
  "get",
  "编号恢复的本人任务SSE",
  ref("RunEvent"),
  { headers: ["Last-Event-ID"] },
);
paths["/recommendations/{run_id}/events"].get.responses[200] = {
  description:
    "id等于event_id；result.payload.validated必须为true；断开不等于取消",
  content: { "text/event-stream": { schema: str() } },
  "x-event-schema": ref("RunEvent"),
};
operation(
  "/recommendations/{run_id}/answers",
  "post",
  "补问生成新画像版本并继续任务",
  ref("RunAccepted"),
  { body: ref("RunAnswers"), code: 202, key: true },
);
operation(
  "/recommendations/{run_id}/cancel",
  "post",
  "显式取消任务",
  ref("RunAccepted"),
  { body: ref("RunCancel"), code: 202, key: true },
);
operation(
  "/feedback",
  "post",
  "绑定任务和推荐项的偏好或事实纠错反馈",
  ref("Accepted"),
  { body: ref("RecommendationFeedback"), code: 201, key: true },
);
operation("/me/plan", "put", "按版本保存招生单位草案", ref("Plan"), {
  body: ref("Plan"),
});
operation(
  "/plans/simulations",
  "post",
  "逐项条件检查；未知不等于通过",
  ref("Simulation"),
  { body: input({ plan_id: id, version: int() }) },
);
operation("/posts", "get", "仅返回所选学校的公开分页来信", ref("PostPage"), {
  publicAccess: true,
  query: ["school_id", "topic", "query", "strong_only", "cursor"],
});
operation("/posts", "post", "原创投稿待审，与注册申请独立", ref("Post"), {
  body: ref("PostInput"),
  code: 201,
  key: true,
});
operation("/posts/{post_id}", "get", "按对象权限读取来信", ref("Post"), {
  publicAccess: true,
});
operation("/posts/{post_id}", "patch", "编辑产生版本并重新审核", ref("Post"), {
  body: ref("PostPatch"),
});
operation(
  "/posts/{post_id}",
  "delete",
  "删除并失效相关检索资格",
  { type: "null" },
  { body: ref("ExpectedVersion") },
);
operation(
  "/posts/{post_id}/feedback",
  "post",
  "帖子投票或评分申诉",
  ref("Accepted"),
  { body: ref("PostFeedback") },
);
operation(
  "/evidence/{evidence_id}",
  "get",
  "证据状态、原文定位、版本与范围",
  ref("Source"),
  { publicAccess: true },
);
operation(
  "/me/student-verification",
  "post",
  "正式账号的学校认证申请",
  ref("Verification"),
  {
    body: input({ school_id: id, document: str({ format: "binary" }) }),
    form: true,
    code: 202,
  },
);
operation(
  "/admin/student-verifications",
  "get",
  "独立学校认证审核队列",
  ref("VerificationPage"),
  { query: ["cursor"] },
);
operation(
  "/admin/student-verifications/{verification_id}/document",
  "get",
  "受保护的学校证明原件",
  str({ format: "binary" }),
);
paths[
  "/admin/student-verifications/{verification_id}/document"
].get.responses[200] = {
  description: "受对象权限保护的原件",
  content: {
    "application/octet-stream": { schema: str({ format: "binary" }) },
  },
};
operation(
  "/admin/student-verifications/{verification_id}/decision",
  "post",
  "确认学校范围或驳回材料",
  ref("Verification"),
  {
    body: input({
      decision: en(["approve", "reject"]),
      reason: str(),
      scope: str(),
      expected_version: int({ minimum: 1 }),
    }),
  },
);
operation(
  "/admin/reviews",
  "get",
  "仅内容审核权限的分页队列",
  ref("PostPage"),
  { query: ["cursor"] },
);
operation(
  "/admin/reviews/{post_id}",
  "post",
  "带期望版本的内容审核",
  ref("Post"),
  { body: ref("Decision") },
);
operation("/me/history", "get", "本人推荐历史", arr(ref("History")));
operation("/me/memories", "get", "本人可确认的偏好记忆", arr(ref("Memory")));
operation(
  "/me/memories/{memory_id}",
  "patch",
  "确认或修改记忆版本",
  ref("Memory"),
  { body: ref("MemoryPatch") },
);
operation("/me/memories/{memory_id}", "delete", "删除个人记忆", {
  type: "null",
});
operation(
  "/me/case-sharing-consent",
  "get",
  "独立的跨用户案例共享授权",
  ref("Sharing"),
);
operation(
  "/me/case-sharing-consent",
  "post",
  "授权去标识化案例共享",
  ref("Sharing"),
  { body: input({ consent: { type: "boolean", const: true } }) },
);
operation(
  "/me/case-sharing-consent",
  "delete",
  "立即撤回共享并启动派生缓存清理",
  { type: "null" },
);
operation(
  "/chat/stream",
  "post",
  "普通问答；不替代已校验推荐任务",
  ref("ChatEvent"),
  {
    body: input(
      {
        message: str({ minLength: 1, maxLength: 4000 }),
        conversation_id: str(),
      },
      ["message"],
    ),
  },
);
paths["/chat/stream"].post.responses[200] = {
  description: "普通问答UTF8 SSE；字段使用snake_case，不套成功信封",
  content: { "text/event-stream": { schema: str() } },
  "x-event-schema": ref("ChatEvent"),
};
const contract = {
  openapi: "3.1.0",
  info: {
    title: "夜航 · 技术方案对齐的前端联调契约",
    version: "0.4.0",
    description:
      "根据技术方案第4–9、12–13章迁移。此为可运行前端与Mock使用的联调提案，真实后端仍需共同验收。DTO使用snake_case，React内部显式映射；会话、注册查询凭据和学校认证分离。",
  },
  servers: [{ url: "http://127.0.0.1:8000/api/v1" }],
  paths,
  components: {
    schemas,
    securitySchemes: {
      session: {
        type: "apiKey",
        in: "cookie",
        name: "nv_session",
        description: "HttpOnly; Secure; SameSite，服务端执行CSRF和对象权限",
      },
    },
  },
};
const text = JSON.stringify(contract, null, 2) + "\n";
const root = new URL("../../../", import.meta.url);
const outputs = [new URL("../docs/openapi.json", import.meta.url)];
if (existsSync(new URL(".git", root)))
  outputs.push(new URL("docs/contracts/openapi.json", root));
if (process.argv.includes("--check")) {
  const stale = outputs.filter(
    (path) =>
      !existsSync(path) ||
      readFileSync(path, "utf8").replace(/\r\n/g, "\n") !== text,
  );
  if (stale.length) {
    console.error(
      "OpenAPI产物已过期，请执行 pnpm run contract：",
      stale.map((path) => path.pathname).join(", "),
    );
    process.exit(1);
  }
} else {
  for (const path of outputs) {
    mkdirSync(new URL("./", path), { recursive: true });
    writeFileSync(path, text);
  }
}
console.log(
  `OpenAPI v0.4 ${process.argv.includes("--check") ? "checked" : "generated"}: ${Object.values(paths).reduce((n, p) => n + Object.keys(p).length, 0)} operations, ${Object.keys(schemas).length} schemas`,
);
