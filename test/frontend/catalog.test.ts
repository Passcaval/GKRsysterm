import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadApi, installStorage } from "./helpers.ts";

test("全国院校名录访问层：全量任务、AI重试、筛选分页、显式审核与原件", async () => {
  installStorage();
  const seen: { path: string; body: any; headers: any }[] = [];
  const summary = {
    id: "catalog-1",
    status: "awaiting_review",
    version: 4,
    created_at: "2026-10-20T00:00:00Z",
    counts: { new: 2, changed: 0, unchanged: 0, conflict: 0 },
    official_counts: { ordinary: 1, adult: 1, total: 2 },
    error: null,
    review: {},
  };
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    seen.push({
      path: req.url!,
      body: text ? JSON.parse(text) : null,
      headers: req.headers,
    });
    if (req.url?.endsWith("/snapshots/0")) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end("fixture-raw");
      return;
    }
    let data: unknown = summary;
    if (req.url?.includes("/config"))
      data = {
        enabled: true,
        auto_start: true,
        model_configured: true,
        model_name: "fake-ai",
        publication_url: "https://www.moe.gov.cn/fixture",
        scope: "合成全国名录",
      };
    else if (req.url?.includes("/runs?"))
      data = { items: [summary], next_offset: 20 };
    else if (req.url?.includes("/catalog-1?"))
      data = {
        ...summary,
        changes: [
          {
            identifier: "4111000001",
            name: "合成大学",
            kind: "new",
            before: {},
            after: { education_level: "本科" },
          },
        ],
        total: 1,
        next_offset: null,
        snapshot: {},
        analysis: { rows_analyzed: 2, batches: [] },
      };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data, request_id: "catalog-fixture" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const loaded = await loadApi(
    "http",
    `http://127.0.0.1:${address.port}/api/v1`,
  );
  try {
    assert.equal((await loaded.api.catalogConfig()).autoStart, true);
    assert.equal((await loaded.api.catalogRuns(20)).nextOffset, 20);
    assert.equal(
      (await loaded.api.catalogRun("catalog-1", 100, "new", "合成")).changes[0]
        .after.educationLevel,
      "本科",
    );
    await loaded.api.catalogTrigger("fetch-key");
    await loaded.api.catalogAnalyze("catalog-1", 4, "ai-key");
    await loaded.api.catalogReview(
      "catalog-1",
      {
        expectedVersion: 4,
        decision: "approve",
        reason: "核对合成资料",
        identifiers: ["4111000001"],
        acknowledgeAnalysis: true,
      },
      "review-key",
    );
    assert.equal(
      await (await loaded.api.catalogRaw("catalog-1", 0)).text(),
      "fixture-raw",
    );
    const review = seen.find((x) => x.path.endsWith("/review"))!;
    assert.equal(review.headers["idempotency-key"], "review-key");
    assert.equal(review.headers["x-requested-with"], "NightVoyage");
    assert.deepEqual(review.body, {
      expected_version: 4,
      decision: "approve",
      reason: "核对合成资料",
      identifiers: ["4111000001"],
      acknowledge_analysis: true,
    });
    assert.ok(seen.some((x) => x.path.includes("offset=100&kind=new&q=")));
  } finally {
    await loaded.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("全国名录Mock模式不发起真实抓取", async () => {
  installStorage();
  const loaded = await loadApi("mock");
  try {
    await assert.rejects(
      () => loaded.api.catalogTrigger("test-key"),
      /演示模式/,
    );
  } finally {
    await loaded.cleanup();
  }
});
