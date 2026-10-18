import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadApi, installStorage } from "./helpers.ts";
const run = {
  run_id: "run-http",
  status: "waiting_input",
  version: 1,
  question: "问校园生活",
  profile_version_id: null,
  original_profile_version_id: null,
  data_version: null,
  rule_version: null,
  created_at: "2026-10-18T00:00:00Z",
  questions: [],
  items: [],
  validation: { status: "pending", summary: "尚未校验" },
  last_event_id: 0,
  summary: "",
  error: null,
};
test("HTTP真实适配：202任务句柄、snake_case、幂等键、结构化错误、申请凭据、SSE恢复与运行时校验", async () => {
  installStorage();
  const seen: { url: string; method: string; headers: any; body: any }[] = [];
  let invalid = false;
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body =
      req.headers["content-type"]?.includes("application/json") && text
        ? JSON.parse(text)
        : text;
    seen.push({
      url: req.url!,
      method: req.method!,
      headers: req.headers,
      body,
    });
    const json = (status: number, data: any) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data, request_id: "req-fixture" }));
    };
    if (req.url === "/api/v1/recommendations" && req.method === "POST") {
      json(202, invalid ? [] : { run_id: run.run_id, status: run.status });
      return;
    }
    if (req.url === "/api/v1/recommendations/run-http") {
      json(200, run);
      return;
    }
    if (req.url === "/api/v1/recommendations/run-http/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const event = (id: number, type: string, payload: any) =>
        `id: ${id}\r\ndata: ${JSON.stringify({ event_id: id, event_type: type, run_id: run.run_id, timestamp: "2026-10-18T00:00:00Z", payload })}\r\n\r\n`;
      const bytes = Buffer.from(
        ": 心跳\r\n\r\n" +
          event(1, "status", { status: "running" }) +
          event(2, "result", { validated: true, summary: "杭电" }) +
          event(2, "result", { validated: true }) +
          event(3, "done", { status: "partial" }),
      );
      for (let i = 0; i < bytes.length; i += 3) {
        res.write(bytes.subarray(i, i + 3));
        await new Promise((resolve) => setImmediate(resolve));
      }
      res.end();
      return;
    }
    if (req.url === "/api/v1/me/profile/parse") {
      json(200, {
        proposed_changes: {
          province_code: "浙江",
          rank: 23500,
          budget: {
            amount: 15000,
            currency: "CNY",
            period: "year",
            scope: "total",
          },
        },
        missing_fields: ["subjects"],
        questions: ["请确认"],
      });
      return;
    }
    if (req.url === "/api/v1/me/plan") {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "PLAN_VERSION_CONFLICT",
            message: "版本冲突",
            details: {
              field_errors: { version: ["已过期"] },
              missing_fields: ["admission_unit_id"],
            },
          },
          request_id: "req-conflict",
        }),
      );
      return;
    }
    if (req.url === "/api/v1/registration-applications/app-one") {
      json(200, {
        application_id: "app-one",
        reserved_user_id: "U0000000001",
        status: "pending",
        version: 1,
        created_at: "2026-10-18T00:00:00Z",
        reason: null,
      });
      return;
    }
    if (req.url === "/api/v1/auth/login") {
      json(200, {
        id: "user-one",
        user_id: "U0000000001",
        nickname: "小明",
        email: "test@example.com",
        email_verified: false,
        student_verified: false,
        role: "student",
        permissions: [],
      });
      return;
    }
    if (req.url === "/api/v1/auth/logout") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.url === "/api/v1/chat/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(
        'data: {"type":"delta","text":"普通问答"}\n\ndata: {"type":"done","conversation_id":"conv-http"}\n\n',
      );
      return;
    }
    if (req.url === "/api/v1/recommendations/expired") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "SESSION_EXPIRED",
            message: "会话已失效",
            details: {},
          },
          request_id: "req-expired",
        }),
      );
      return;
    }
    json(404, null);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const { api, ApiError, apiMode, cleanup } = await loadApi(
    "http",
    `http://127.0.0.1:${port}/api/v1`,
  );
  try {
    const input = {
      question: "问校园生活",
      intent: "campus_life",
      profileVersionId: null,
      riskPreference: 60,
    };
    const result = await api.createRun(input, "idempotency-http");
    assert.equal(result.runId, "run-http");
    assert.equal(result.status, "waiting_input");
    const create = seen.find((x) => x.url === "/api/v1/recommendations")!;
    assert.deepEqual(create.body, {
      question: "问校园生活",
      intent: "campus_life",
      profile_version_id: null,
      risk_preference: 60,
    });
    assert.equal(create.headers["idempotency-key"], "idempotency-http");
    assert.equal(create.headers["x-requested-with"], "NightVoyage");
    assert.ok(
      seen.some(
        (x) =>
          x.url === "/api/v1/recommendations/run-http" && x.method === "GET",
      ),
    );
    const login = await api.login("test@example.com", "mock-password", "email");
    assert.equal(login.name, "小明");
    assert.equal(login.userId, "U0000000001");
    assert.equal(seen.at(-1)!.body.login_type, "email");
    const proposal = await api.parseProfile("浙江，预算15000元");
    assert.equal(proposal.proposedChanges.province, "浙江");
    assert.equal(proposal.proposedChanges.budget, 15000);
    assert.equal(proposal.proposedChanges.budgetScope, "total");
    assert.equal("year" in proposal.proposedChanges, false);
    assert.equal("provinceCode" in proposal.proposedChanges, false);
    await assert.rejects(
      api.plan({ id: "p", name: "测试", version: 1, entries: [] }),
      (e: any) =>
        e instanceof ApiError &&
        e.status === 409 &&
        e.code === "PLAN_VERSION_CONFLICT" &&
        e.requestId === "req-conflict" &&
        e.details.field_errors.version[0] === "已过期",
    );
    await api.application("app-one", "capability-only-in-header");
    const application = seen.at(-1)!;
    assert.equal(
      application.headers["x-application-token"],
      "capability-only-in-header",
    );
    assert.equal(application.url.includes("capability"), false);
    const events = [];
    for await (const e of api.runEvents(
      run.run_id,
      1,
      new AbortController().signal,
    ))
      events.push(e);
    assert.deepEqual(
      events.map((e) => e.eventId),
      [2, 3],
    );
    assert.equal(seen.at(-1)!.headers["last-event-id"], "1");
    const chat = [];
    for await (const e of api.chat(
      "普通问题",
      undefined,
      new AbortController().signal,
    ))
      chat.push(e);
    assert.deepEqual(chat, [
      { type: "delta", text: "普通问答" },
      { type: "done", conversationId: "conv-http" },
    ]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      async () => {
        for await (const _ of api.chat("停止", undefined, controller.signal)) {
        }
      },
      (e: any) => e.name === "AbortError",
    );
    invalid = true;
    await assert.rejects(
      api.createRun(input, "bad-response"),
      (e: any) => e.status === 502 && e.code === "SCHEMA_INVALID",
    );
    await assert.rejects(api.logout(), (e: any) => e.status === 502);
    await assert.rejects(
      api.getRun("expired"),
      (e: any) => e.status === 401 && e.code === "SESSION_EXPIRED",
    );
    assert.equal(apiMode(undefined, true), "http");
    assert.equal(apiMode("mock", true), "mock");
    assert.throws(() => apiMode("httpp", true));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});
