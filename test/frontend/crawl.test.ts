import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadApi, installStorage } from "./helpers.ts";

const runView = {
  crawl_run_id: "run-1",
  status: "awaiting_review",
  trigger_type: "admin",
  created_at: "2026-10-19T00:00:00Z",
  finished_at: "2026-10-19T00:01:00Z",
  model_name: "test-model",
  prompt_version: "test-v1",
  config_fingerprint: "fingerprint",
  version: 3,
  row_count: 1,
  valid_row_count: 1,
  import_ids: [],
  warning_count: 0,
  error_count: 0,
  progress: { pages_done: 1, model_calls: 2 },
  pages_summary: { valid_rows: 1 },
  warnings: [],
  errors: [],
  row_total: 1,
  row_offset: 0,
  row_limit: 200,
  rows: [
    {
      row_id: "row-1",
      data: { school_name: "浙江大学", unit_code: "001" },
      evidence: "浙江大学计算机科学与技术专业学费6000元",
      locator: "table:1",
      confidence: 0.9,
      validation: { status: "valid", errors: [], warnings: [] },
    },
  ],
  imports: [],
  review: { reviewed_at: null, reviewed_by: null, reason: null },
  pages: [
    {
      page_id: "page-1",
      url: "https://example.test/plan.html",
      depth: 0,
      status: "extracted",
      http_status: 200,
      content_type: "text/html",
      content_hash: "hash",
      title: "招生计划",
      fetched_at: "2026-10-19T00:00:00Z",
      published_at: "2026-06-01T00:00:00Z",
      text_chars: 100,
      row_count: 1,
      has_snapshot: true,
      error: null,
    },
  ],
};

const summary = {
  crawl_run_id: "run-1",
  status: "awaiting_review",
  trigger_type: "admin",
  created_at: "2026-10-19T00:00:00Z",
  finished_at: null,
  model_name: "test-model",
  prompt_version: "test-v1",
  config_fingerprint: "fingerprint",
  version: 3,
  row_count: 1,
  valid_row_count: 1,
  import_ids: [],
  warning_count: 0,
  error_count: 0,
};

test("招生抓取访问层：配置摘要、触发幂等、运行详情、审核与原文快照", async () => {
  installStorage();
  const seen: { url: string; method: string; headers: any; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body =
      req.headers["content-type"]?.includes("application/json") && text
        ? JSON.parse(text)
        : text;
    const path = req.url!.split("?")[0];
    seen.push({
      url: req.url!,
      method: req.method!,
      headers: req.headers,
      body,
    });
    const json = (data: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data, request_id: "req-fixture" }));
    };
    if (path === "/api/v1/admin/admission-sources") {
      json({
        config_path: "/app/config/admission_sources.json",
        config_error: null,
        model_configured: true,
        model_name: "test-model",
        config: {
          version: 1,
          scope: {
            province_code: "浙江",
            exam_year: 2026,
            exam_category: "普通类",
          },
          sources: [],
          discovery: {
            enabled: true,
            auto_start: true,
            entrypoints: ["https://www.zjzs.net/"],
            allowed_hosts: ["www.zjzs.net"],
            allowed_suffixes: [".gov.cn"],
            max_depth: 2,
            max_pages: 20,
            max_links_per_page: 30,
            keywords: ["招生计划"],
          },
          crawl: {},
          model: {},
          publish: { require_review: true },
          config_fingerprint: "fingerprint",
        },
      });
      return;
    }
    if (path === "/api/v1/admin/admissions/crawl" && req.method === "GET") {
      json({ items: [summary], next_cursor: null });
      return;
    }
    if (path === "/api/v1/admin/admissions/crawl" && req.method === "POST") {
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: summary, request_id: "req-fixture" }));
      return;
    }
    if (
      path === "/api/v1/admin/admissions/crawl/run-1" &&
      req.method === "GET"
    ) {
      json(runView);
      return;
    }
    if (
      path === "/api/v1/admin/admissions/crawl/run-1/review" &&
      req.method === "POST"
    ) {
      json(runView);
      return;
    }
    if (
      path ===
      "/api/v1/admin/admissions/crawl/run-1/pages/page-1/raw"
    ) {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(Buffer.from("snapshot"));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "NOT_FOUND", message: "not found", details: {} },
        request_id: "req-fixture",
      }),
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const mod = await loadApi("http", base);
  try {
    const config = await mod.api.admissionSources();
    assert.equal(config.modelConfigured, true);
    assert.equal(config.config.scope.provinceCode, "浙江");
    assert.equal(config.config.discovery.allowedHosts[0], "www.zjzs.net");

    const page = await mod.api.crawlRuns();
    assert.equal(page.items[0].crawlRunId, "run-1");
    assert.equal(page.nextCursor, null);

    const triggered = await mod.api.triggerCrawl("idem-1");
    assert.equal(triggered.crawlRunId, "run-1");
    const triggerCall = seen.find(
      (item) =>
        item.url === "/api/v1/admin/admissions/crawl" &&
        item.method === "POST",
    );
    assert.equal(triggerCall?.headers["idempotency-key"], "idem-1");

    const run = await mod.api.crawlRun("run-1");
    assert.equal(run.status, "awaiting_review");
    assert.equal(run.pages[0].pageId, "page-1");
    assert.equal(run.rows[0].rowId, "row-1");
    assert.equal(run.progress.pagesDone, 1);

    const reviewed = await mod.api.reviewCrawl(
      "run-1",
      {
        decision: "approve",
        reason: "ok",
        expectedVersion: 3,
        supersedesImportId: "import-1",
        acknowledgePublishedAtFallback: true,
        rowsOverride: { "page-1": [{ school_code: "10335" }] },
      },
      "idem-2",
    );
    assert.equal(reviewed.crawlRunId, "run-1");
    const reviewCall = seen.find((item) =>
      item.url.endsWith("/review"),
    );
    assert.equal(reviewCall?.body.expected_version, 3);
    assert.equal(reviewCall?.body.supersedes_import_id, "import-1");
    assert.equal(reviewCall?.body.acknowledge_published_at_fallback, true);
    assert.deepEqual(reviewCall?.body.rows_override, {
      "page-1": [{ school_code: "10335" }],
    });
    assert.equal(reviewCall?.headers["idempotency-key"], "idem-2");

    const blob = await mod.api.crawlPageRaw("run-1", "page-1");
    assert.equal(
      new TextDecoder().decode(await blob.arrayBuffer()),
      "snapshot",
    );
  } finally {
    await mod.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Mock 模式明确拒绝真实招生抓取", async () => {
  installStorage();
  const mod = await loadApi("mock");
  try {
    await assert.rejects(
      () => mod.api.admissionSources(),
      (error: any) => error?.status === 503,
    );
    await assert.rejects(
      () => mod.api.triggerCrawl("mock"),
      (error: any) => error?.status === 503,
    );
  } finally {
    await mod.cleanup();
  }
});
