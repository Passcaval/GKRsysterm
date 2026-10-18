import type {
  Bootstrap,
  Profile,
  Plan,
  Recommendation,
  Simulation,
  Post,
  User,
  ChatEvent,
  Verification,
} from "./types";
import { initial } from "./data";
import { classify, eligible, validateProfile } from "./domain";
import { EventDecoder } from "./sse";
import { canReview, loginInput } from "./auth";
import { authenticateDemo } from "./demo-auth";
export const isMock = import.meta.env?.VITE_API_MODE !== "http";
const BASE = (import.meta.env?.VITE_API_BASE_URL || "/api/v1").replace(
  /\/$/,
  "",
);
const KEY = "night-voyage-demo-v1";
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
  ) {
    super(message);
  }
}
function db(): Bootstrap {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null");
    return value?.schema === 1
      ? { ...structuredClone(initial), ...value.data }
      : structuredClone(initial);
  } catch {
    return structuredClone(initial);
  }
}
function save(data: Bootstrap) {
  localStorage.setItem(KEY, JSON.stringify({ schema: 1, data }));
}
function requireUser(d: Bootstrap) {
  if (!d.user) throw new ApiError(401, "请先在“我的”登录");
  return d.user;
}
function record(event: Record<string, unknown>) {
  const key = "night-voyage-demo-events";
  let events: Record<string, unknown>[] = [];
  try {
    events = JSON.parse(localStorage.getItem(key) || "[]");
  } catch {}
  const exists = events.some(
    (e) =>
      e.userId === event.userId &&
      e.postId === event.postId &&
      e.kind === event.kind &&
      event.kind !== "appeal",
  );
  if (!exists) {
    events.push({ ...event, createdAt: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(events));
  }
}
async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(BASE + path, {
      method,
      credentials: "include",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...(method !== "GET" ? { "X-Requested-With": "NightVoyage" } : {}),
      },
      body:
        body === undefined
          ? undefined
          : body instanceof FormData
            ? body
            : JSON.stringify(body),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok)
      throw new ApiError(
        response.status,
        value?.error?.message || `请求失败（${response.status}）`,
        value?.request_id ?? value?.requestId,
      );
    if (!value || !("data" in value))
      throw new ApiError(502, "接口返回格式不符合约定");
    return value.data as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(
      0,
      e instanceof DOMException && e.name === "AbortError"
        ? "请求超时，请稍后重试"
        : "暂时无法连接服务，请检查网络后重试",
    );
  } finally {
    clearTimeout(timer);
  }
}
const delay = () => new Promise((resolve) => setTimeout(resolve, 180));
export const api = {
  async bootstrap(): Promise<Bootstrap> {
    if (!isMock) return request("/bootstrap");
    await delay();
    return db();
  },
  async login(identifier: string, password: string): Promise<User> {
    const input = loginInput(identifier, password);
    if (!isMock) return request("/auth/login", "POST", input);
    await delay();
    const user = authenticateDemo(input);
    if (!user) throw new ApiError(401, "账号或密码错误");
    const d = db();
    d.user = user;
    save(d);
    return d.user;
  },
  async logout() {
    if (!isMock) return request<null>("/auth/logout", "POST");
    const d = db();
    d.user = null;
    save(d);
    return null;
  },
  async profile(profile: Profile): Promise<Profile> {
    const errors = validateProfile(profile);
    if (errors.length) throw new Error(errors.join("；"));
    if (!isMock) return request("/me/profile", "PUT", profile);
    const d = db();
    requireUser(d);
    d.profile = profile;
    save(d);
    return profile;
  },
  async deleteProfile() {
    if (!isMock) return request<null>("/me/data", "DELETE");
    const d = db();
    requireUser(d);
    localStorage.removeItem("night-voyage-demo-events");
    d.profile = null;
    d.plan = { ...d.plan, entries: [], version: d.plan.version + 1 };
    d.favorites = [];
    d.verifications = [];
    d.posts = d.posts.filter((p) => !p.isMine);
    save(d);
    return null;
  },
  async favorite(schoolId: string, active: boolean): Promise<string[]> {
    if (!isMock)
      return request(
        `/me/favorites/${encodeURIComponent(schoolId)}`,
        active ? "PUT" : "DELETE",
      );
    const d = db();
    requireUser(d);
    d.favorites = active
      ? [...new Set([...d.favorites, schoolId])]
      : d.favorites.filter((id) => id !== schoolId);
    save(d);
    return d.favorites;
  },
  async recommendations(risk: number): Promise<Recommendation[]> {
    if (!isMock)
      return request("/recommendations", "POST", { riskPreference: risk });
    await delay();
    const d = db();
    const p = d.profile;
    if (!p) throw new Error("请先建立考生档案");
    if (p.province !== "浙江")
      throw new Error("演示数据仅覆盖浙江，其他省份暂不支持生成推荐");
    return d.schools
      .filter((s) => eligible(p, s) && s.tuition <= p.budget)
      .map((s) => ({
        schoolId: s.id,
        major: s.majors[0],
        tier: classify(p.rank, s.rank, risk),
        matchScore: Math.max(
          45,
          Math.round(96 - Math.abs(p.rank - s.rank) / 1400),
        ),
        reasons: [
          `选科符合示例报考条件，${s.city}符合${p.cities.includes(s.city) ? "你的城市偏好" : "可探索的地域范围"}`,
          `学费 ${s.tuition} 元/年，在你的预算内`,
        ],
        warnings: [
          "规则演示，不代表录取概率；请核对同省、同批次、同专业组和当年的招生政策",
        ],
        sourceIds: [...s.sourceIds, "inference-demo"],
        postIds: d.posts
          .filter(
            (x) =>
              x.schoolId === s.id &&
              x.signal === "strong" &&
              x.status === "published",
          )
          .map((x) => x.id),
      }));
  },
  async explanation(
    schoolId: string,
  ): Promise<{ text: string; sourceIds: string[] }> {
    if (!isMock)
      return request("/recommendations/explain", "POST", { schoolId });
    const d = db();
    const s = d.schools.find((x) => x.id === schoolId);
    if (!s || !d.profile) throw new Error("请选择院校并完善档案");
    return {
      text: !eligible(d.profile, s)
        ? "当前选科不满足该示例专业的要求。"
        : s.tuition > d.profile.budget
          ? "该校示例学费超过你设置的预算。"
          : `这所学校已在可探索范围内；与当前位次的差距会影响冲稳保分类。请结合专业、招生计划和最新政策进一步判断。`,
      sourceIds: s.sourceIds,
    };
  },
  async plan(plan: Plan): Promise<Plan> {
    if (!isMock) return request("/me/plan", "PUT", plan);
    const d = db();
    requireUser(d);
    if (d.plan.version !== plan.version)
      throw new ApiError(409, "方案已更新，请刷新后重试");
    if (plan.entries.length > 40) throw new Error("演示方案最多 40 项");
    d.plan = { ...plan, version: plan.version + 1 };
    save(d);
    return d.plan;
  },
  async simulate(plan: Plan): Promise<Simulation> {
    if (!isMock)
      return request("/plans/simulations", "POST", {
        planId: plan.id,
        version: plan.version,
      });
    await delay();
    const d = db();
    const p = d.profile;
    if (!p) throw new Error("请先完善档案");
    const tiers = plan.entries.map((e) =>
      classify(
        p.rank,
        d.schools.find((s) => s.id === e.schoolId)?.rank || p.rank,
      ),
    );
    return {
      eligible: plan.entries.every((e) => {
        const s = d.schools.find((s) => s.id === e.schoolId);
        return !!s && eligible(p, s);
      }),
      warnings: [
        ...(!tiers.includes("safe") ? ["方案尚缺少保底层次的院校。"] : []),
        ...(plan.entries.some((e) => !e.adjustment)
          ? ["部分志愿未接受调剂，请核对退档规则。"]
          : []),
      ],
      assessment: plan.entries.length
        ? "已检查示例选科条件与冲稳保分布。平行志愿顺序影响检索顺序，不应被解释为改变单校录取概率。"
        : "请先加入志愿。",
      basisYear: 2025,
      probabilities: null,
    };
  },
  async submitPost(input: {
    schoolId: string;
    topic: string;
    title: string;
    body: string;
  }): Promise<Post> {
    if (!isMock) return request("/posts", "POST", input);
    const d = db();
    requireUser(d);
    if (input.title.length < 5 || input.body.length < 80)
      throw new Error("请按字数要求填写标题和来信");
    const p: Post = {
      ...d.posts[0],
      ...input,
      isMine: true,
      id: "local-" + crypto.randomUUID(),
      author: "匿名贡献者 · 待核验",
      year: new Date().getFullYear(),
      excerpt: input.body.slice(0, 64),
      signal: "weak",
      status: "pending",
      helpful: 0,
      citations: 0,
      sourceIds: [],
      trust: {
        identity: 0,
        specificity: 0,
        corroboration: 0,
        freshness: 100,
        anomaly: 0,
        supporting: 0,
        opposing: 0,
        explanation: [
          "身份尚未经过核验。",
          "内容细节等待人工核验，尚未评分。",
          "尚无独立来源交叉印证。",
          "这是一篇新提交的演示来信，政策适用性待核对。",
          "尚未执行异常检测，不能据此认定安全。",
        ],
        expiresAt: new Date(Date.now() + 30 * 86400000)
          .toISOString()
          .slice(0, 10),
        version: "demo-pending-v1",
      },
    };
    d.posts.unshift(p);
    save(d);
    return p;
  },
  async feedback(
    postId: string,
    kind: "helpful" | "disagree" | "appeal",
    reason = "",
  ): Promise<{ accepted: boolean }> {
    if (!isMock)
      return request(`/posts/${encodeURIComponent(postId)}/feedback`, "POST", {
        kind,
        reason,
      });
    const d = db();
    const u = requireUser(d);
    if (kind !== "appeal" && !u.verified)
      throw new ApiError(403, "社区投票仅限认证用户；你可以提交评分申诉");
    if (kind === "appeal" && reason.trim().length < 10)
      throw new Error("请至少填写10字复核理由");
    record({ userId: u.id, postId, kind, reason });
    return { accepted: true };
  },
  async verify(schoolId: string, file: File): Promise<Verification> {
    const form = new FormData();
    form.set("schoolId", schoolId);
    form.set("document", file);
    if (!isMock) return request("/verifications", "POST", form);
    const d = db();
    if (!d.user) throw new ApiError(401, "请先登录");
    const v: Verification = {
      id: crypto.randomUUID(),
      schoolId,
      status: "pending",
      submittedAt: new Date().toISOString(),
    };
    d.verifications.unshift(v);
    save(d);
    return v;
  },
  async moderation(): Promise<Post[]> {
    if (!isMock) return request("/admin/reviews");
    const d = db();
    if (!canReview(d.user)) throw new ApiError(403, "需要内容审核权限");
    return d.posts.filter((p) => p.status === "pending");
  },
  async review(
    postId: string,
    decision: "approve" | "reject",
    reason: string,
  ): Promise<Post> {
    if (!isMock)
      return request(`/admin/reviews/${encodeURIComponent(postId)}`, "POST", {
        decision,
        reason,
      });
    const d = db();
    if (!d.user || !canReview(d.user))
      throw new ApiError(403, "需要内容审核权限");
    const p = d.posts.find((p) => p.id === postId);
    if (!p) throw new Error("帖子不存在");
    if (p.status !== "pending") throw new ApiError(409, "该帖子已处理");
    if (reason.trim().length < 5) throw new Error("请至少填写5字审核理由");
    record({ userId: d.user.id, postId, kind: "review-" + decision, reason });
    p.status = decision === "approve" ? "published" : "rejected";
    save(d);
    return p;
  },
  async *chat(
    message: string,
    conversationId: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<ChatEvent> {
    if (isMock) {
      yield {
        type: "tool_start",
        tool: "official_search",
        text: "查询示例院校与选科要求",
      };
      await delay();
      if (signal.aborted) return;
      yield {
        type: "tool_end",
        tool: "official_search",
        text: "找到 8 所示例院校",
      };
      yield {
        type: "tool_start",
        tool: "experience_search",
        text: "检索已发布的强信号回声",
      };
      await delay();
      if (signal.aborted) return;
      yield {
        type: "tool_end",
        tool: "experience_search",
        text: "完成示例证据检索",
      };
      const p = db().profile;
      const text = p
        ? `根据你在${p.province}的档案（${p.score}分、位次${p.rank.toLocaleString()}），可以先了解杭州电子科技大学与南京邮电大学的计算机、电子信息方向。\n\n建议同时核对选科要求、历年专业组位次和招生计划，再结合已核验的校园体验。你提到的“${message.slice(0, 70)}”也需要与个人偏好一起考虑。\n\n这是本地演示回复，没有调用真实大模型。示例位次与帖子不能用于实际填报。`
        : "请先建立考生档案。生源省份、报考年份、选科和位次决定可适用的数据范围。此处为演示回复。";
      for (const chunk of text.match(/.{1,14}|\n/g) || []) {
        if (signal.aborted) return;
        yield { type: "delta", text: chunk };
        await new Promise((r) => setTimeout(r, 20));
      }
      yield {
        type: "evidence",
        sourceIds: [
          "official-hdu",
          "official-njupt",
          "experience-p1",
          "inference-demo",
        ],
      };
      yield {
        type: "done",
        conversationId: conversationId || crypto.randomUUID(),
      };
      return;
    }
    const res = await fetch(BASE + "/chat/stream", {
      method: "POST",
      credentials: "include",
      signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        "X-Requested-With": "NightVoyage",
      },
      body: JSON.stringify({ message, conversationId }),
    });
    if (!res.ok || !res.body)
      throw new ApiError(res.status, "对话服务暂时不可用");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = new EventDecoder();
    let done = false;
    const timer = setTimeout(() => reader.cancel(), 120000);
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        for (const event of parser.push(
          decoder.decode(part.value, { stream: true }),
        )) {
          if (event.type === "done") done = true;
          if (event.type === "error")
            throw new Error(event.text || "模型服务返回错误");
          yield event;
        }
      }
      for (const e of parser.push(decoder.decode())) {
        if (e.type === "done") done = true;
        yield e;
      }
      parser.finish();
      if (!done) throw new Error("回答连接已中断，请重试");
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  },
};
