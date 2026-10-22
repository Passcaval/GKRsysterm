import { streamChat } from "./chat-stream";
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
import { createWorkflowApi } from "./workflow-api";
import {
  isMock,
  BASE,
  request,
  ApiError,
  bootstrapFromWire,
  fromWire,
} from "./transport";
export { isMock, ApiError, apiMode } from "./transport";
const KEY = "night-voyage-demo-v1";
function db(): Bootstrap {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "null");
    const d: Bootstrap =
      value?.schema === 1
        ? { ...structuredClone(initial), ...value.data }
        : structuredClone(initial);
    for (const p of d.posts) {
      p.version ??= 1;
      if (p.isMine && !p.ownerId && d.user) p.ownerId = d.user.id;
    }
    if (d.profile) {
      d.profile.version ??= 1;
      d.profile.profileVersionId ??= "profile-demo-v1";
    }
    if (d.user) {
      d.user.permissions ??=
        d.user.role === "reviewer" ? ["content:review"] : [];
      d.user.userId ??= "UDEMO-STUDENT";
    }
    return d;
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
const delay = () => new Promise((resolve) => setTimeout(resolve, 180));
export const api = {
  async bootstrap(): Promise<Bootstrap> {
    if (!isMock)
      return bootstrapFromWire(
        await request("/bootstrap", "GET", undefined, { raw: true }),
      );
    await delay();
    const d = db();
    return {
      ...d,
      posts: d.posts.filter(
        (p) =>
          (p.status === "published" && p.visibility !== "private") ||
          p.isMine ||
          d.user?.permissions?.includes("content:review"),
      ),
    };
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
  async plan(plan: Plan): Promise<Plan> {
    if (!isMock) return request("/me/plan", "PUT", plan);
    const d = db();
    requireUser(d);
    if (d.plan.version !== plan.version)
      throw new ApiError(409, "方案已更新，请刷新后重试");
    if (d.plan.maxEntries && plan.entries.length > d.plan.maxEntries)
      throw new Error(`方案最多 ${d.plan.maxEntries} 项`);
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
      eligible:
        p.subjects.length !== 3
          ? null
          : plan.entries.every((e) => {
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
  async submitPost(
    input: {
      schoolId: string;
      topic: string;
      title: string;
      body: string;
      campusId?: string | null;
      majorId?: string | null;
      experiencedAt?: string | null;
      visibility?: "public" | "private";
      originality?: "original";
    },
    key = crypto.randomUUID(),
  ): Promise<Post> {
    if (!isMock) return request("/posts", "POST", input, { key });
    const d = db();
    requireUser(d);
    if (input.title.length < 5 || input.body.length < 80)
      throw new Error("请按字数要求填写标题和来信");
    const p: Post = {
      ...d.posts[0],
      ...input,
      isMine: true,
      ownerId: d.user!.id,
      version: 1,
      visibility: input.visibility || "public",
      id: "local-" + crypto.randomUUID(),
      author: "匿名贡献者 · 待核验",
      year: new Date().getFullYear(),
      excerpt: input.body.slice(0, 64),
      signal: "weak",
      status: "pending",
      helpful: 0,
      citations: 0,
      sourceIds: [],
      claims: [],
      trust: {
        identity: null,
        specificity: null,
        corroboration: null,
        freshness: 100,
        anomaly: null,
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
  async moderation(
    cursor: string | null = null,
  ): Promise<{ items: Post[]; nextCursor: string | null }> {
    if (!isMock)
      return request(
        "/admin/reviews" +
          (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      );
    const d = db();
    if (!d.user?.permissions?.includes("content:review"))
      throw new ApiError(403, "需要审核员权限");
    const rows = d.posts.filter((p) => p.status === "pending"),
      start = Number(cursor || 0);
    return {
      items: rows.slice(start, start + 12),
      nextCursor: start + 12 < rows.length ? String(start + 12) : null,
    };
  },
  async review(
    postId: string,
    decision: "approve" | "reject",
    reason: string,
    expectedVersion: number = 1,
  ): Promise<Post> {
    if (!isMock)
      return request(`/admin/reviews/${encodeURIComponent(postId)}`, "POST", {
        decision,
        reason,
        expectedVersion,
      });
    const d = db();
    if (!d.user?.permissions?.includes("content:review"))
      throw new ApiError(403, "需要审核员权限");
    const p = d.posts.find((p) => p.id === postId);
    if (!p) throw new Error("帖子不存在");
    if ((p.version || 1) !== expectedVersion)
      throw new ApiError(
        409,
        "帖子版本已更新",
        undefined,
        "POST_VERSION_CONFLICT",
      );
    if (p.status !== "pending") throw new ApiError(409, "该帖子已处理");
    if (reason.trim().length < 5) throw new Error("请至少填写5字审核理由");
    record({ userId: d.user.id, postId, kind: "review-" + decision, reason });
    p.status = decision === "approve" ? "published" : "rejected";
    p.version = (p.version || 1) + 1;
    save(d);
    return p;
  },
  async *chat(
    message: string,
    conversationId: string | undefined,
    signal: AbortSignal,
    history?: { role: "user" | "assistant"; content: string }[],
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
      const text = `这是普通资料问答的本地演示，没有调用模型，也不发布正式报考建议。你询问的“${message.slice(0, 70)}”可以结合院校官方资料和已公开校园回声继续探索。需要个性化筛选或风险分析时，请使用下方入口创建推荐任务，确认画像、回答补问，并查看校验后的结构化结果。`;
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
    yield* streamChat(message, conversationId, signal, history);
  },
  ...createWorkflowApi({ db, save, requireUser }),
};
