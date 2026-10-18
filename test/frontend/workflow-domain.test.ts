import test from "node:test";
import assert from "node:assert/strict";
import {
  validateNickname,
  validEmail,
  missingForIntent,
  visibleRunItems,
} from "../../src/frontend/src/workflow-domain.ts";
import { RunEventDecoder } from "../../src/frontend/src/run-sse.ts";
import { schemaErrors } from "../../src/frontend/src/schema.ts";
import type { RecommendationRun } from "../../src/frontend/src/types.ts";
test("昵称按NFC及Unicode码点处理，扩展汉字合法且不做NFKC或空格裁剪", () => {
  for (const name of ["小明", "Alice", "中Ab文", "𠀀𠀀𠀀𠀀𠀀"])
    assert.equal(validateNickname(name), true, name);
  for (const name of [
    "",
    "AliceA",
    "小明1",
    "a_b",
    "小 明",
    "Émile",
    "ＡBC",
    "😀",
    " Bob",
  ])
    assert.equal(validateNickname(name), false, name);
  for (const mail of ["User+tag@example.com", "a.b@foo-bar.example.com"])
    assert.equal(validEmail(mail), true);
  for (const mail of [
    ".a@example.com",
    "a..b@example.com",
    "a@-b.com",
    "a@b_.com",
    "a @b.com",
    "a@localhost",
    "a".repeat(65) + "@example.com",
  ])
    assert.equal(validEmail(mail), false, mail);
});
test("校园查询不被成绩阻断，风险分析按需询问；未校验和硬条件失败的项不发布", () => {
  assert.deepEqual(missingForIntent(null, "campus_life"), []);
  assert.ok(missingForIntent(null, "risk").includes("rank_cohort"));
  const run = {
    status: "running",
    validation: { status: "pending" },
    items: [{ recommendationItemId: "one", eligibility: { status: "pass" } }],
  } as RecommendationRun;
  assert.deepEqual(visibleRunItems(run), []);
  run.status = "partial";
  run.validation.status = "passed";
  assert.equal(visibleRunItems(run).length, 1);
  run.items[0].eligibility.status = "fail";
  assert.deepEqual(visibleRunItems(run), []);
});
test("推荐SSE跨块、CRLF、心跳、去重和乱序丢弃，严格限制run及校验后结果", () => {
  const event = (id: number, type: string, payload: unknown, run = "r1") =>
    `id: ${id}\r\ndata: ${JSON.stringify({ event_id: id, event_type: type, run_id: run, timestamp: "2026-10-18T00:00:00Z", payload })}\r\n\r\n`;
  const text =
    ": heartbeat\r\n\r\n" +
    event(1, "status", { status: "running" }) +
    event(2, "result", { validated: true, text: "杭电" }) +
    event(2, "result", { validated: true }) +
    event(1, "status", { status: "queued" }) +
    event(3, "done", { status: "partial" });
  const parser = new RunEventDecoder("r1");
  const output = [];
  for (let i = 0; i < text.length; i += 3)
    output.push(...parser.push(text.slice(i, i + 3)));
  parser.finish();
  assert.deepEqual(
    output.map((e) => e.eventId),
    [1, 2, 3],
  );
  assert.equal(parser.lastEventId, 3);
  assert.throws(
    () =>
      new RunEventDecoder("r1").push(event(1, "result", { validated: false })),
    /校验/,
  );
  assert.throws(
    () => new RunEventDecoder("r1").push(event(1, "status", {}, "another")),
    /无效/,
  );
  const truncated = new RunEventDecoder("r1");
  truncated.push("data: {");
  assert.throws(() => truncated.finish(), /断开/);
});
test("运行时Schema检查必填、枚举、nullable、数值、码点长度及未声明字段", () => {
  const schema = {
    type: "object",
    required: ["status", "value"],
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["pending"] },
      value: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
      name: { type: "string", maxLength: 1 },
    },
  };
  assert.deepEqual(
    schemaErrors(schema, { status: "pending", value: null, name: "𠀀" }, {}),
    [],
  );
  assert.ok(
    schemaErrors(schema, { status: "oops", value: 0, extra: 1 }, {}).length >=
      3,
  );
});
