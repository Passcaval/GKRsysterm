import { loginInput } from "./auth";
import { authenticateDemo } from "./demo-auth";
import type {
  Bootstrap,
  User,
  Profile,
  RegistrationInput,
  RegistrationApplication,
  RegistrationReceipt,
  CreateRunInput,
  RecommendationRun,
  RecommendationItem,
  RunEvent,
  PersonalMemory,
  HistoryEntry,
  Post,
  School,
  Source,
  Page,
  AdmissionUnit,
  Verification,
} from "./types";
import { hasPermission } from "./types";
import { classify, validateProfile } from "./domain";
import {
  missingForIntent,
  terminalRuns,
  validateRegistration,
  validateRun,
  validEmail,
} from "./workflow-domain";
import {
  ApiError,
  BASE,
  isMock,
  request,
  protectedBlob,
  resetSession,
  profileToWire,
  profileFromWire,
  userFromWire,
  fromWire,
  sessionEpoch,
} from "./transport";
import { RunEventDecoder } from "./run-sse";
interface Context {
  db: () => Bootstrap;
  save: (data: Bootstrap) => void;
  requireUser: (data: Bootstrap) => User;
}
type MockRun = RecommendationRun & {
  ownerId: string;
  input: CreateRunInput;
  profile: Profile | null;
  started: number;
  events: RunEvent[];
};
type MockApplication = RegistrationApplication & {
  token: string;
  passwordHash: string;
  salt: string;
  audio: File | null;
};
const applications: MockApplication[] = [];
const verificationDocuments = new Map<string, File>();
const accounts: { user: User; salt: string; hash: string }[] = [];
let nextUserId = 100;
const idempotency = new Map<string, { body: string; result: unknown }>();
const encoder = new TextEncoder();
async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 100000,
    },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
function memo<T>(scope: string, key: string, body: unknown, make: () => T): T {
  if (!key)
    throw new ApiError(
      422,
      "缺少幂等键",
      undefined,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
  const serialized = JSON.stringify(body);
  const previous = idempotency.get(scope + key);
  if (previous) {
    if (previous.body !== serialized)
      throw new ApiError(
        409,
        "同一幂等键不能用于不同内容",
        undefined,
        "IDEMPOTENCY_CONFLICT",
      );
    return structuredClone(previous.result) as T;
  }
  const result = make();
  idempotency.set(scope + key, {
    body: serialized,
    result: structuredClone(result),
  });
  return result;
}
function publicApplication(a: MockApplication): RegistrationApplication {
  const { token: _, passwordHash: __, salt: ___, audio: ____, ...view } = a;
  return structuredClone(view);
}
function page<T>(items: T[], cursor: string | null = null): Page<T> {
  const start = Number(cursor || 0);
  return {
    items: structuredClone(items.slice(start, start + 12)),
    nextCursor: start + 12 < items.length ? String(start + 12) : null,
  };
}
export function createWorkflowApi(ctx: Context) {
  const user = () => ctx.requireUser(ctx.db());
  const permission = (name: string) => {
    const u = user();
    if (!hasPermission(u, name))
      throw new ApiError(403, "没有此操作的权限", undefined, "FORBIDDEN");
    return u;
  };
  const stateKey = "night-voyage-workflow-v3";
  const read = (): {
    runs: MockRun[];
    versions: Record<string, Profile[]>;
    memories: Record<string, PersonalMemory[]>;
    sharing: Record<string, boolean>;
    feedback: unknown[];
    verifications?: Verification[];
  } => {
    try {
      return (
        JSON.parse(localStorage.getItem(stateKey) || "null") || {
          runs: [],
          versions: {},
          memories: {},
          sharing: {},
          feedback: [],
        }
      );
    } catch {
      return {
        runs: [],
        versions: {},
        memories: {},
        sharing: {},
        feedback: [],
      };
    }
  };
  const write = (state: ReturnType<typeof read>) =>
    localStorage.setItem(stateKey, JSON.stringify(state));
  const ownRun = (state: ReturnType<typeof read>, id: string) => {
    const u = user();
    const run = state.runs.find((r) => r.runId === id);
    if (!run) throw new ApiError(404, "任务不存在", undefined, "RUN_NOT_FOUND");
    if (run.ownerId !== u.id)
      throw new ApiError(403, "不能访问其他账号的任务", undefined, "FORBIDDEN");
    return run;
  };
  const event = (
    run: MockRun,
    type: RunEvent["eventType"],
    payload: Record<string, unknown>,
  ) => {
    run.lastEventId++;
    run.events.push({
      eventId: run.lastEventId,
      eventType: type,
      runId: run.runId,
      timestamp: new Date().toISOString(),
      payload,
    });
  };
  const exposedRun = (run: MockRun): RecommendationRun => {
    const {
      ownerId: _,
      input: __,
      profile: ___,
      started: ____,
      events: _____,
      ...view
    } = run;
    return structuredClone(view);
  };
  function switchUser(next: User | null) {
    const data = ctx.db();
    if (next) {
      const targetId = next.id;
      const scopes = (read().verifications || [])
        .filter((v) => v.ownerId === targetId && v.status === "approved")
        .map((v) => ({ schoolId: v.schoolId, scope: v.scope || "待确认" }));
      next = {
        ...next,
        verified: next.verified || !!scopes.length,
        studentVerificationScopes: scopes,
      };
    }
    if (data.user)
      localStorage.setItem(
        "nv-personal:" + data.user.id,
        JSON.stringify({
          profile: data.profile,
          plan: data.plan,
          favorites: data.favorites,
          verifications: data.verifications,
        }),
      );
    let personal: any = null;
    try {
      personal = next
        ? JSON.parse(localStorage.getItem("nv-personal:" + next.id) || "null")
        : null;
    } catch {}
    ctx.save({
      ...data,
      user: next,
      profile: personal?.profile ?? null,
      plan: personal?.plan ?? {
        id: "plan-" + (next?.id || "anonymous"),
        version: 1,
        name: "我的志愿草案",
        entries: [],
        maxEntries: 40,
      },
      favorites: personal?.favorites ?? [],
      verifications: personal?.verifications ?? [],
      posts: data.posts.map((p) => ({ ...p, isMine: p.ownerId === next?.id })),
    });
    resetSession();
  }
  async function saveProfile(
    p: Profile,
    expected = p.version || 0,
  ): Promise<Profile> {
    const errors = validateProfile(p);
    if (errors.length)
      throw new ApiError(422, errors.join("；"), undefined, "PROFILE_INVALID");
    if (!isMock)
      return profileFromWire(
        await request(
          "/me/profile",
          "PATCH",
          { ...profileToWire(p), expected_version: expected },
          { raw: true },
        ),
      );
    const u = user(),
      d = ctx.db();
    if ((d.profile?.version || 0) !== expected)
      throw new ApiError(
        409,
        "画像已在其他页面更新，输入已保留，请核对最新版本",
        undefined,
        "PROFILE_VERSION_CONFLICT",
      );
    const next = {
      ...p,
      version: expected + 1,
      profileVersionId: crypto.randomUUID(),
    };
    d.profile = next;
    ctx.save(d);
    const state = read();
    state.versions[u.id] ??= [];
    state.versions[u.id].push(next);
    write(state);
    return structuredClone(next);
  }
  function generateItems(run: MockRun): RecommendationItem[] {
    const d = ctx.db(),
      p = run.profile;
    return d.schools
      .flatMap((s) =>
        s.majors.map((major, index): RecommendationItem => {
          const known =
            p?.subjects.length === 3 &&
            p.province === "浙江" &&
            p.year === 2026;
          const passed =
            known && s.requiredSubjects.every((x) => p!.subjects.includes(x));
          const budgetKnown =
            p?.budget !== null &&
            p?.budget !== undefined &&
            s.tuition !== null &&
            p.budgetScope !== "total";
          const over = budgetKnown && s.tuition! > p!.budget!;
          const hardRegion =
            p?.preferences?.some(
              (x) => x.field === "preferred_regions" && x.strength === "hard",
            ) &&
            p.cities.length &&
            !p.cities.includes(s.city);
          const status =
            hardRegion || (known && (!passed || over))
              ? "fail"
              : known
                ? "pass"
                : "unknown";
          const riskKnown =
            run.input.intent === "risk" &&
            p?.province === "浙江" &&
            p?.year === 2026 &&
            !!p.rankCohort &&
            !!p.rank &&
            !!s.rank;
          return {
            recommendationItemId: run.runId + ":" + s.id + ":" + index,
            admissionUnitId: s.id + "-2026-unit-" + index,
            schoolId: s.id,
            schoolName: s.name,
            major,
            campusId: null,
            eligibility: {
              status,
              missingRequirements: known ? [] : ["选科及招生口径待确认"],
            },
            historicalRisk: {
              status: riskKnown
                ? classify(p!.rank, s.rank, run.input.riskPreference)
                : "unknown",
              reason: riskKnown
                ? "浙江2026普通类示例口径，非真实录取预测"
                : "暂无已确认的同省、同年份及同口径历史数据",
            },
            preferenceMatch: {
              score: p?.interests.length
                ? p.interests.includes(major)
                  ? 90
                  : 55
                : null,
              coverage: p?.interests.length ? 0.5 : 0,
              breakdown: [],
            },
            reasons: ["本地合成数据，仅用于演示推荐任务与条件检查"],
            evidenceIds: s.sourceIds,
            warnings: [
              "校区和招生单位代码仍需核对官方当年发布",
              ...(p?.budgetScope === "total"
                ? ["总支出预算不能与学校学费直接比较"]
                : []),
            ],
          };
        }),
      )
      .filter((item) => item.eligibility.status !== "fail");
  }
  function progress(run: MockRun) {
    if (terminalRuns.includes(run.status) || run.status === "waiting_input")
      return;
    const elapsed = Date.now() - run.started;
    const next =
      elapsed < 450
        ? "queued"
        : elapsed < 1100
          ? "running"
          : elapsed < 1700
            ? "validating"
            : "succeeded";
    if (next !== run.status) {
      run.status = next;
      run.version++;
      event(run, "status", { status: next, version: run.version });
    }
    if (next === "succeeded") {
      run.items = run.input.intent === "campus_life" ? [] : generateItems(run);
      if (
        run.items.some(
          (i) =>
            i.eligibility.status === "unknown" ||
            i.historicalRisk.status === "unknown",
        )
      )
        run.status = "partial";
      run.validation = {
        status: "passed",
        summary: "示例结构与硬条件已检查；真实规则、数据和证据仍需后端核验",
      };
      run.summary =
        run.input.intent === "campus_life"
          ? "校园生活查询无需高考分数；请在院校星图选择学校，阅读该校已公开的校园回声。"
          : "已生成可追溯的演示结果，待确认项单列；不提供录取概率。";
      event(run, "result", { validated: true, run: exposedRun(run) });
      event(run, "done", { status: run.status });
    }
  }
  return {
    async login(
      identifier: string,
      password: string,
      loginType?: "email" | "user_id",
    ): Promise<User> {
      const normalized = loginInput(identifier, password);
      identifier = normalized.identifier;
      loginType ??= normalized.login_type;
      if (isMock && loginType === "email" && !validEmail(identifier))
        throw new ApiError(
          422,
          "邮箱格式不正确，请重新输入。",
          undefined,
          "EMAIL_INVALID",
        );
      if (
        isMock &&
        loginType === "user_id" &&
        !/^U[A-Za-z0-9-]+$/.test(identifier)
      )
        throw new ApiError(
          422,
          "邮箱或用户ID格式不正确，请重新输入。",
          undefined,
          "IDENTIFIER_INVALID",
        );
      resetSession();
      if (!isMock)
        return userFromWire(
          await request(
            "/auth/login",
            "POST",
            { login_type: loginType, identifier, password },
            { raw: true, auth: false },
          ),
        );
      const fixture = authenticateDemo({
        login_type: loginType,
        identifier,
        password,
      });
      if (fixture) {
        switchUser(fixture);
        return structuredClone(ctx.db().user!);
      }
      const account = accounts.find(
        (a) =>
          (loginType === "email"
            ? a.user.email?.toLowerCase()
            : a.user.userId) ===
          (loginType === "email" ? identifier.toLowerCase() : identifier),
      );
      if (
        !account ||
        (await passwordHash(password, account.salt)) !== account.hash
      )
        throw new ApiError(
          401,
          "登录信息不正确或账号尚不可用",
          undefined,
          "LOGIN_FAILED",
        );
      switchUser(account.user);
      return structuredClone(ctx.db().user!);
    },
    async logout() {
      if (!isMock) await request("/auth/logout", "POST");
      else switchUser(null);
      resetSession();
      return null;
    },
    async deleteProfile() {
      if (!isMock) return request<null>("/me/data", "DELETE");
      const u = user(),
        d = ctx.db(),
        state = read();
      state.runs = state.runs.filter((r) => r.ownerId !== u.id);
      delete state.versions[u.id];
      delete state.memories[u.id];
      delete state.sharing[u.id];
      state.feedback = state.feedback.filter((f: any) => f.ownerId !== u.id);
      write(state);
      d.profile = null;
      d.plan = { ...d.plan, entries: [], version: d.plan.version + 1 };
      d.favorites = [];
      d.verifications = [];
      state.verifications = (state.verifications || []).filter(
        (v) => v.ownerId !== u.id,
      );
      write(state);
      d.posts = d.posts.filter((p) => p.ownerId !== u.id && !p.isMine);
      ctx.save(d);
      localStorage.removeItem("nv-personal:" + u.id);
      localStorage.removeItem("nv-compare");
      if (typeof sessionStorage !== "undefined")
        sessionStorage.removeItem("nv-last-run:" + u.id);
      return null;
    },
    async me() {
      return isMock
        ? ctx.db().user
        : userFromWire(
            await request("/auth/me", "GET", undefined, { raw: true }),
          );
    },
    async register(
      input: RegistrationInput,
      key: string,
    ): Promise<RegistrationReceipt> {
      if (
        Object.keys(input).some(
          (key) =>
            ![
              "nickname",
              "email",
              "password",
              "evidenceText",
              "evidenceAudio",
            ].includes(key),
        )
      )
        throw new ApiError(
          422,
          "注册申请含未声明字段",
          undefined,
          "VALIDATION_ERROR",
        );
      const errors = isMock ? validateRegistration(input) : [];
      if (errors.length)
        throw new ApiError(
          422,
          errors.join("；"),
          undefined,
          "VALIDATION_ERROR",
        );
      if (!isMock) {
        const form = new FormData();
        form.set("nickname", input.nickname.normalize("NFC"));
        form.set("email", input.email);
        form.set("password", input.password);
        if (input.evidenceText.trim())
          form.set("evidence_text", input.evidenceText);
        if (input.evidenceAudio)
          form.set("evidence_audio", input.evidenceAudio);
        return request("/registration-applications", "POST", form, {
          key,
          auth: false,
        });
      }
      const salt = crypto.randomUUID(),
        hash = await passwordHash(input.password, salt),
        fingerprint = await passwordHash(input.password, "request:" + key);
      const audioHash = input.evidenceAudio
        ? Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                await input.evidenceAudio.arrayBuffer(),
              ),
            ),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("")
        : null;
      return memo(
        "registration:",
        key,
        { ...input, password: fingerprint, evidenceAudio: audioHash },
        () => {
          const nickname = input.nickname.normalize("NFC");
          const email = input.email.toLowerCase();
          if (
            applications.some(
              (a) =>
                a.status !== "rejected" &&
                (a.nickname.toLowerCase() === nickname.toLowerCase() ||
                  a.email.toLowerCase() === email),
            ) ||
            accounts.some(
              (a) =>
                a.user.email?.toLowerCase() === email ||
                a.user.name.toLowerCase() === nickname.toLowerCase(),
            )
          )
            throw new ApiError(
              409,
              "标识已被使用或正在审核",
              undefined,
              "IDENTITY_OCCUPIED",
            );
          const a: MockApplication = {
            applicationId: crypto.randomUUID(),
            reservedUserId: "U" + String(++nextUserId).padStart(10, "0"),
            nickname,
            email: input.email,
            status: "pending",
            version: 1,
            createdAt: new Date().toISOString(),
            reviewedAt: null,
            reason: null,
            evidenceText: input.evidenceText,
            hasAudio: !!input.evidenceAudio,
            token: crypto.randomUUID() + crypto.randomUUID(),
            passwordHash: hash,
            salt,
            audio: input.evidenceAudio,
          };
          applications.push(a);
          return { ...publicApplication(a), statusToken: a.token };
        },
      );
    },
    async application(
      id: string,
      token: string,
    ): Promise<RegistrationApplication> {
      if (!isMock)
        return request(
          "/registration-applications/" + encodeURIComponent(id),
          "GET",
          undefined,
          { headers: { "X-Application-Token": token }, auth: false },
        );
      const a = applications.find(
        (a) => a.applicationId === id && a.token === token,
      );
      if (!a)
        throw new ApiError(
          404,
          "申请或查询凭据无效",
          undefined,
          "APPLICATION_NOT_FOUND",
        );
      const view = publicApplication(a);
      delete view.evidenceText;
      delete view.hasAudio;
      return view;
    },
    async registrationQueue(
      cursor: string | null = null,
    ): Promise<Page<RegistrationApplication>> {
      if (!isMock)
        return request(
          "/admin/registration-applications?status=pending" +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
        );
      permission("registration:review");
      return page(
        applications
          .filter((a) => a.status === "pending")
          .map(publicApplication),
        cursor,
      );
    },
    async applicationDetail(id: string): Promise<RegistrationApplication> {
      if (!isMock)
        return request(
          "/admin/registration-applications/" + encodeURIComponent(id),
        );
      permission("registration:review");
      const a = applications.find((a) => a.applicationId === id);
      if (!a) throw new ApiError(404, "申请不存在");
      return publicApplication(a);
    },
    async applicationAudio(id: string): Promise<Blob> {
      if (isMock) {
        permission("registration:review");
        const a = applications.find((a) => a.applicationId === id);
        if (!a?.audio) throw new ApiError(404, "音频不存在");
        return a.audio;
      }
      return protectedBlob(
        "/admin/registration-applications/" + encodeURIComponent(id) + "/audio",
      );
    },
    async decideRegistration(
      id: string,
      decision: "approve" | "reject",
      reason: string,
      expectedVersion: number,
      key: string,
    ): Promise<RegistrationApplication> {
      if (!isMock)
        return request(
          "/admin/registration-applications/" +
            encodeURIComponent(id) +
            "/decision",
          "POST",
          { decision, reason, expectedVersion },
          { key },
        );
      const u = permission("registration:review");
      return memo(
        u.id + ":decision:",
        key,
        { id, decision, reason, expectedVersion },
        () => {
          const a = applications.find((a) => a.applicationId === id);
          if (!a) throw new ApiError(404, "申请不存在");
          if (a.status !== "pending" || a.version !== expectedVersion)
            throw new ApiError(
              409,
              "申请已被处理，请刷新审核队列",
              undefined,
              "APPLICATION_VERSION_CONFLICT",
            );
          if (decision === "reject" && !reason.trim())
            throw new ApiError(
              422,
              "驳回必须填写原因",
              undefined,
              "REASON_REQUIRED",
            );
          if (decision === "approve")
            accounts.push({
              user: {
                id: crypto.randomUUID(),
                userId: a.reservedUserId,
                name: a.nickname,
                email: a.email,
                emailVerified: false,
                role: "student",
                permissions: [],
                verified: false,
              },
              salt: a.salt,
              hash: a.passwordHash,
            });
          a.status = decision === "approve" ? "approved" : "rejected";
          a.version++;
          a.reason = decision === "reject" ? reason : null;
          a.reviewedAt = new Date().toISOString();
          a.passwordHash = "";
          a.salt = "";
          return publicApplication(a);
        },
      );
    },
    profile: saveProfile,
    async profileVersions(): Promise<Profile[]> {
      if (!isMock)
        return (
          await request<any[]>("/me/profile/versions", "GET", undefined, {
            raw: true,
          })
        ).map(profileFromWire);
      const u = user();
      const versions = read().versions[u.id] || [];
      return versions.length
        ? versions
        : ctx.db().profile
          ? [ctx.db().profile!]
          : [];
    },
    async parseProfile(text: string): Promise<{
      proposedChanges: Partial<Profile>;
      missingFields: string[];
      questions: string[];
    }> {
      if (!isMock) {
        const result = await request<any>("/me/profile/parse", "POST", {
          text,
        });
        const proposed = { ...result.proposedChanges };
        for (const [wire, local] of [
          ["provinceCode", "province"],
          ["examYear", "year"],
          ["preferredRegions", "cities"],
          ["preferredMajors", "interests"],
        ]) {
          if (wire in proposed) {
            proposed[local] = proposed[wire];
            delete proposed[wire];
          }
        }
        if (proposed.budget && typeof proposed.budget === "object") {
          const budget = proposed.budget;
          proposed.budget = budget.amount;
          proposed.budgetCurrency = budget.currency;
          proposed.budgetPeriod = budget.period;
          proposed.budgetScope = budget.scope;
        }
        return { ...result, proposedChanges: proposed };
      }
      user();
      const proposed: Partial<Profile> = {};
      for (const province of ["浙江", "江苏", "上海", "北京"])
        if (text.includes(province)) proposed.province = province;
      const rank = text.match(/位次[为是约\s]*(\d+)/);
      if (rank) proposed.rank = Number(rank[1]);
      const score = text.match(/(\d{2,3})\s*分/);
      if (score) proposed.score = Number(score[1]);
      return {
        proposedChanges: proposed,
        missingFields: missingForIntent(
          { ...ctx.db().profile, ...proposed } as Profile,
          "risk",
        ),
        questions: ["请确认提取结果；未提及字段保持原值，不会自动保存。"],
      };
    },
    async createRun(
      input: CreateRunInput,
      key: string,
    ): Promise<RecommendationRun> {
      if (!isMock) {
        const accepted = await request<any>("/recommendations", "POST", input, {
          key,
        });
        return validateRun(
          accepted.items
            ? accepted
            : await request(
                "/recommendations/" + encodeURIComponent(accepted.runId),
              ),
        );
      }
      const u = user();
      if (!input.question.trim()) throw new ApiError(422, "请填写本次问题");
      return memo(u.id + ":run:", key, input, () => {
        const d = ctx.db();
        if (
          input.profileVersionId &&
          input.profileVersionId !== d.profile?.profileVersionId
        )
          throw new ApiError(
            409,
            "画像版本已变化，请确认后再生成",
            undefined,
            "PROFILE_VERSION_CONFLICT",
          );
        const missing = missingForIntent(d.profile, input.intent);
        const run: MockRun = {
          runId: crypto.randomUUID(),
          ownerId: u.id,
          input: structuredClone(input),
          profile: structuredClone(d.profile),
          started: Date.now(),
          events: [],
          status: missing.length ? "waiting_input" : "queued",
          version: 1,
          question: input.question,
          profileVersionId: d.profile?.profileVersionId ?? null,
          originalProfileVersionId: d.profile?.profileVersionId ?? null,
          dataVersion: "demo-zj-2026",
          ruleVersion: "demo-v2",
          createdAt: new Date().toISOString(),
          questions: missing.map((field) => ({
            field,
            text:
              {
                province_code: "请填写生源省份",
                exam_year: "请填写报考年份",
                subjects: "请填写选科，用逗号分隔",
                rank: "请填写省内位次",
                rank_cohort: "请填写位次口径（如：浙江普通类）",
                consent: "是否同意本次使用画像信息？",
              }[field] || field,
            required: true,
          })),
          items: [],
          validation: { status: "pending", summary: "结果尚未通过校验" },
          lastEventId: 0,
          summary: "",
          error: null,
        };
        event(run, "status", { status: run.status, version: run.version });
        if (missing.length)
          event(run, "question", { questions: run.questions });
        const state = read();
        state.runs.push(run);
        write(state);
        return exposedRun(run);
      });
    },
    async getRun(id: string): Promise<RecommendationRun> {
      if (!isMock)
        return validateRun(
          await request("/recommendations/" + encodeURIComponent(id)),
        );
      const state = read(),
        run = ownRun(state, id);
      progress(run);
      write(state);
      return exposedRun(run);
    },
    async answerRun(
      id: string,
      answers: Record<string, string>,
      expectedVersion: number,
      key: string,
    ): Promise<RecommendationRun> {
      if (!isMock) {
        await request(
          "/recommendations/" + encodeURIComponent(id) + "/answers",
          "POST",
          { answers, expectedVersion },
          { key },
        );
        return validateRun(
          await request("/recommendations/" + encodeURIComponent(id)),
        );
      }
      const u = user();
      return memo(
        u.id + ":answers:",
        key,
        { id, answers, expectedVersion },
        () => {
          const state = read(),
            run = ownRun(state, id);
          if (run.status !== "waiting_input" || run.version !== expectedVersion)
            throw new ApiError(
              409,
              "任务状态已更新，请重新读取",
              undefined,
              "RUN_VERSION_CONFLICT",
            );
          const d = ctx.db();
          const p: Profile = d.profile
            ? { ...d.profile }
            : {
                province: "",
                year: 2026,
                score: null,
                rank: null,
                subjects: [],
                cities: [],
                interests: [],
                budget: null,
                acceptAdjustment: false,
                consent: false,
                version: 0,
              };
          if (answers.province_code !== undefined)
            p.province = answers.province_code;
          if (answers.exam_year) p.year = Number(answers.exam_year);
          if (answers.rank) p.rank = Number(answers.rank);
          if (answers.rank_cohort) p.rankCohort = answers.rank_cohort;
          if (answers.subjects)
            p.subjects = answers.subjects.split(/[,，/ ]+/).filter(Boolean);
          if (answers.consent !== undefined)
            p.consent = answers.consent === "true";
          const errors = validateProfile(p),
            missing = missingForIntent(p, run.input.intent);
          if (errors.length || missing.length)
            throw new ApiError(
              422,
              errors.join("；") || "请回答所有必需问题",
              undefined,
              "PROFILE_INCOMPLETE",
              { missing_fields: missing },
            );
          p.version = (d.profile?.version || 0) + 1;
          p.profileVersionId = crypto.randomUUID();
          d.profile = p;
          ctx.save(d);
          state.versions[u.id] ??= [];
          state.versions[u.id].push(p);
          run.profile = structuredClone(p);
          run.profileVersionId = p.profileVersionId;
          run.status = "queued";
          run.questions = [];
          run.started = Date.now();
          run.version++;
          event(run, "status", { status: "queued", version: run.version });
          write(state);
          return exposedRun(run);
        },
      );
    },
    async cancelRun(
      id: string,
      expectedVersion: number,
      key: string,
    ): Promise<RecommendationRun> {
      if (!isMock) {
        await request(
          "/recommendations/" + encodeURIComponent(id) + "/cancel",
          "POST",
          { expectedVersion },
          { key },
        );
        return validateRun(
          await request("/recommendations/" + encodeURIComponent(id)),
        );
      }
      const u = user();
      return memo(u.id + ":cancel:", key, { id, expectedVersion }, () => {
        const state = read(),
          run = ownRun(state, id);
        if (
          run.version !== expectedVersion ||
          terminalRuns.includes(run.status)
        )
          throw new ApiError(
            409,
            "任务状态已变化，请重新读取",
            undefined,
            "RUN_VERSION_CONFLICT",
          );
        run.status = "cancelled";
        run.version++;
        event(run, "status", { status: run.status, version: run.version });
        event(run, "done", { status: run.status });
        write(state);
        return exposedRun(run);
      });
    },
    async *runEvents(
      id: string,
      lastEventId: number,
      signal: AbortSignal,
    ): AsyncGenerator<RunEvent> {
      if (isMock) {
        let cursor = lastEventId;
        while (!signal.aborted) {
          const state = read(),
            run = ownRun(state, id);
          progress(run);
          write(state);
          for (const e of run.events)
            if (e.eventId > cursor) {
              cursor = e.eventId;
              yield structuredClone(e);
            }
          if (terminalRuns.includes(run.status)) return;
          await new Promise((resolve) => setTimeout(resolve, 220));
        }
        return;
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      let timer = setTimeout(abort, 20000);
      const start = sessionEpoch();
      try {
        const response = await fetch(
          BASE + "/recommendations/" + encodeURIComponent(id) + "/events",
          {
            credentials: "include",
            signal: controller.signal,
            headers: {
              Accept: "text/event-stream",
              ...(lastEventId ? { "Last-Event-ID": String(lastEventId) } : {}),
            },
          },
        );
        if (response.status === 401) resetSession();
        if (!response.ok || !response.body) {
          const value = await response.json().catch(() => null);
          throw new ApiError(
            response.status,
            value?.error?.message || "任务监听不可用",
            value?.request_id,
            value?.error?.code || "STREAM_FAILED",
            value?.error?.details || {},
          );
        }
        if (
          !response.headers.get("content-type")?.includes("text/event-stream")
        )
          throw new ApiError(502, "任务流媒体类型不正确");
        const reader = response.body.getReader(),
          decoder = new TextDecoder(),
          parser = new RunEventDecoder(id, lastEventId);
        try {
          while (!signal.aborted) {
            clearTimeout(timer);
            timer = setTimeout(abort, 30000);
            const part = await reader.read();
            if (start !== sessionEpoch())
              throw new ApiError(0, "会话已切换", undefined, "SESSION_CHANGED");
            if (part.done) break;
            for (const e of parser.push(
              decoder.decode(part.value, { stream: true }),
            ))
              yield e;
          }
          for (const e of parser.push(decoder.decode())) yield e;
          parser.finish();
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      }
    },
    async recommendationFeedback(
      runId: string,
      itemId: string,
      kind: "preference" | "correction",
      reason: string,
      key: string,
    ) {
      if (!reason.trim()) throw new ApiError(422, "请填写反馈原因");
      if (!isMock)
        return request(
          "/feedback",
          "POST",
          { runId, recommendationItemId: itemId, kind, reason },
          { key },
        );
      const u = user();
      return memo(
        u.id + ":feedback:",
        key,
        { runId, itemId, kind, reason },
        () => {
          const state = read(),
            run = ownRun(state, runId);
          if (!run.items.some((i) => i.recommendationItemId === itemId))
            throw new ApiError(404, "推荐项不存在");
          state.feedback.push({
            ownerId: u.id,
            runId,
            recommendationItemId: itemId,
            profileVersionId: run.profileVersionId,
            kind,
            reason,
          });
          if (kind === "preference") {
            state.memories[u.id] ??= [];
            state.memories[u.id].push({
              id: crypto.randomUUID(),
              version: 1,
              field: "推荐偏好反馈",
              value: reason,
              confirmed: false,
            });
          }
          write(state);
          return { accepted: true };
        },
      );
    },
    async verify(schoolId: string, file: File): Promise<Verification> {
      if (
        !["image/jpeg", "image/png", "application/pdf"].includes(file.type) ||
        file.size > 5 * 1024 * 1024
      )
        throw new ApiError(422, "学校材料需为JPG/PNG/PDF且不超过5MiB");
      if (!isMock) {
        const form = new FormData();
        form.set("school_id", schoolId);
        form.set("document", file);
        return request("/me/student-verification", "POST", form);
      }
      const u = user(),
        d = ctx.db(),
        state = read();
      const v: Verification = {
        id: crypto.randomUUID(),
        schoolId,
        ownerId: u.id,
        status: "pending",
        submittedAt: new Date().toISOString(),
        version: 1,
        documentName: file.name,
        documentAvailable: true,
        scope: "",
        reason: null,
      };
      verificationDocuments.set(v.id, file);
      state.verifications ??= [];
      state.verifications.push(v);
      write(state);
      d.verifications.push(v);
      ctx.save(d);
      return v;
    },
    async verificationQueue(
      cursor: string | null = null,
    ): Promise<Page<Verification>> {
      if (!isMock)
        return request(
          "/admin/student-verifications" +
            (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
        );
      permission("verification:review");
      return page(
        (read().verifications || []).filter((v) => v.status === "pending"),
        cursor,
      );
    },
    async verificationDocument(id: string): Promise<Blob> {
      if (isMock) {
        permission("verification:review");
        const file = verificationDocuments.get(id);
        if (!file)
          throw new ApiError(404, "原件在此演示运行中已不可用，请驳回补充材料");
        return file;
      }
      return protectedBlob(
        "/admin/student-verifications/" + encodeURIComponent(id) + "/document",
      );
    },
    async decideVerification(
      id: string,
      decision: "approve" | "reject",
      reason: string,
      scope: string,
      expectedVersion: number,
    ): Promise<Verification> {
      if (!isMock)
        return request(
          "/admin/student-verifications/" +
            encodeURIComponent(id) +
            "/decision",
          "POST",
          { decision, reason, scope, expectedVersion },
        );
      permission("verification:review");
      const state = read(),
        v = state.verifications?.find((v) => v.id === id);
      if (!v) throw new ApiError(404, "申请不存在");
      if (v.status !== "pending" || v.version !== expectedVersion)
        throw new ApiError(409, "学校认证申请已更新");
      if (
        (decision === "reject" && !reason.trim()) ||
        (decision === "approve" && !scope.trim())
      )
        throw new ApiError(422, "批准需说明学校认证范围，驳回需给出理由");
      if (decision === "approve" && !verificationDocuments.has(id))
        throw new ApiError(422, "缺少原件不能批准");
      v.status = decision === "approve" ? "approved" : "rejected";
      v.version++;
      v.reason = reason || null;
      v.scope = decision === "approve" ? scope : "";
      write(state);
      const personalKey = "nv-personal:" + v.ownerId;
      let saved: any = null;
      try {
        saved = JSON.parse(localStorage.getItem(personalKey) || "null");
      } catch {}
      if (saved) {
        saved.verifications = (saved.verifications || []).map(
          (entry: Verification) => (entry.id === id ? v : entry),
        );
        localStorage.setItem(personalKey, JSON.stringify(saved));
      }
      return v;
    },
    async schools(
      query = "",
      cursor: string | null = null,
      city = "",
      major = "",
    ): Promise<Page<School>> {
      if (!isMock)
        return request(
          "/schools?" +
            new URLSearchParams({
              query,
              city,
              major,
              ...(cursor ? { cursor } : {}),
            }),
        );
      return page(
        ctx
          .db()
          .schools.filter(
            (s) =>
              (s.name + s.city + s.majors.join("")).includes(query) &&
              (!city || s.city === city) &&
              (!major || s.majors.includes(major)),
          ),
        cursor,
      );
    },
    async admissionUnits(
      schoolId: string,
      cursor: string | null = null,
    ): Promise<Page<AdmissionUnit>> {
      if (!isMock)
        return request(
          "/admission-units?" +
            new URLSearchParams({
              school_id: schoolId,
              ...(cursor ? { cursor } : {}),
            }),
        );
      const d = ctx.db(),
        s = d.schools.find((s) => s.id === schoolId);
      return page(
        s
          ? s.majors.map((m, i) => ({
              id: s.id + "-2026-unit-" + i,
              schoolId: s.id,
              campusId: null,
              campusName: null,
              unitType: "major",
              provinceCode: "浙江",
              examYear: 2026,
              examCategory: "普通类",
              batch: "普通本科",
              code: null,
              majors: [{ id: s.id + "-major-" + i, name: m }],
              requiredSubjects: s.requiredSubjects,
              dataVersion: "demo-zj-2026",
              sourceIds: s.sourceIds,
            }))
          : [],
        cursor,
      );
    },
    async unitHistory(id: string): Promise<{
      comparable: boolean;
      reason: string;
      items: {
        year: number;
        unitType: string;
        minimumFilingRank: number | null;
        majorAdmissionRank: number | null;
        sourceIds: string[];
      }[];
    }> {
      if (!isMock)
        return request(
          "/admission-units/" + encodeURIComponent(id) + "/history",
        );
      return {
        comparable: false,
        reason: "未核对真实跨年招生单位映射，不生成可比趋势",
        items: [],
      };
    },
    async school(id: string): Promise<School> {
      if (!isMock) return request("/schools/" + encodeURIComponent(id));
      const s = ctx.db().schools.find((s) => s.id === id);
      if (!s) throw new ApiError(404, "院校不存在");
      return s;
    },
    async posts(
      schoolId: string,
      topic = "",
      query = "",
      strong = false,
      cursor: string | null = null,
    ): Promise<Page<Post>> {
      if (!isMock)
        return request(
          "/posts?" +
            new URLSearchParams({
              school_id: schoolId,
              topic,
              query,
              strong_only: String(strong),
              ...(cursor ? { cursor } : {}),
            }),
        );
      return page(
        ctx
          .db()
          .posts.filter(
            (p) =>
              p.schoolId === schoolId &&
              p.status === "published" &&
              p.visibility !== "private" &&
              (!topic || topic === "全部回声" || p.topic === topic) &&
              (!strong || p.signal === "strong") &&
              (p.title + p.excerpt).includes(query),
          ),
        cursor,
      );
    },
    async post(id: string): Promise<Post> {
      if (!isMock) return request("/posts/" + encodeURIComponent(id));
      const d = ctx.db(),
        p = d.posts.find(
          (p) =>
            p.id === id &&
            ((p.status === "published" && p.visibility !== "private") ||
              p.isMine ||
              hasPermission(d.user, "content:review")),
        );
      if (!p) throw new ApiError(404, "来信不存在或无权限");
      return p;
    },
    async source(id: string): Promise<Source> {
      if (!isMock) return request("/evidence/" + encodeURIComponent(id));
      const s = ctx.db().sources.find((s) => s.id === id);
      if (!s) throw new ApiError(404, "证据不存在或已撤回");
      return {
        ...s,
        version: s.version || "demo-v1",
        supportStatus: s.supportStatus || "unverified",
        freshness: s.freshness || "unknown",
        scope: s.scope || "演示资料，适用范围待确认",
        locator: s.locator ?? null,
      };
    },
    async editPost(id: string, input: Partial<Post>, expectedVersion: number) {
      if (!isMock)
        return request<Post>("/posts/" + encodeURIComponent(id), "PATCH", {
          ...input,
          expectedVersion,
        });
      const d = ctx.db();
      user();
      const p = d.posts.find((p) => p.id === id && p.isMine);
      if (!p) throw new ApiError(403, "只能编辑自己的来信");
      if ((p.version || 1) !== expectedVersion)
        throw new ApiError(409, "帖子版本冲突");
      const editable = Object.fromEntries(
        Object.entries(input).filter(([key]) =>
          [
            "title",
            "body",
            "topic",
            "campusId",
            "majorId",
            "experiencedAt",
            "visibility",
          ].includes(key),
        ),
      );
      Object.assign(p, editable, {
        version: expectedVersion + 1,
        status: "pending",
        claims: [],
      });
      ctx.save(d);
      return p;
    },
    async deletePost(id: string, expectedVersion: number) {
      if (!isMock)
        return request<null>("/posts/" + encodeURIComponent(id), "DELETE", {
          expectedVersion,
        });
      const d = ctx.db();
      user();
      const p = d.posts.find((p) => p.id === id && p.isMine);
      if (!p) throw new ApiError(403, "只能删除自己的来信");
      if ((p.version || 1) !== expectedVersion)
        throw new ApiError(409, "帖子版本冲突");
      d.posts = d.posts.filter((p) => p.id !== id);
      ctx.save(d);
      return null;
    },
    async history(): Promise<HistoryEntry[]> {
      if (!isMock) return request("/me/history");
      const u = user();
      return read()
        .runs.filter((r) => r.ownerId === u.id)
        .map(exposedRun);
    },
    async memories(): Promise<PersonalMemory[]> {
      if (!isMock) return request("/me/memories");
      const u = user();
      return read().memories[u.id] || [];
    },
    async updateMemory(memory: PersonalMemory) {
      if (!isMock)
        return request<PersonalMemory>(
          "/me/memories/" + encodeURIComponent(memory.id),
          "PATCH",
          {
            value: memory.value,
            confirmed: true,
            expectedVersion: memory.version,
          },
        );
      const u = user(),
        s = read(),
        m = s.memories[u.id]?.find((m) => m.id === memory.id);
      if (!m) throw new ApiError(404, "偏好记忆不存在");
      if (m.version !== memory.version) throw new ApiError(409, "记忆版本冲突");
      Object.assign(m, {
        value: memory.value,
        confirmed: true,
        version: m.version + 1,
      });
      write(s);
      return m;
    },
    async deleteMemory(id: string) {
      if (!isMock)
        return request<null>(
          "/me/memories/" + encodeURIComponent(id),
          "DELETE",
        );
      const u = user(),
        s = read();
      s.memories[u.id] = (s.memories[u.id] || []).filter((m) => m.id !== id);
      write(s);
      return null;
    },
    async sharing(): Promise<{ enabled: boolean }> {
      if (!isMock) return request("/me/case-sharing-consent");
      return { enabled: read().sharing[user().id] === true };
    },
    async setSharing(enabled: boolean) {
      if (!isMock)
        return request(
          "/me/case-sharing-consent",
          enabled ? "POST" : "DELETE",
          enabled ? { consent: true } : undefined,
        );
      const u = user(),
        s = read();
      s.sharing[u.id] = enabled;
      write(s);
      return { enabled };
    },
  };
}
