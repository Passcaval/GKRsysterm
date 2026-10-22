import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadApi, installStorage } from "./helpers.ts";

test("联网招生知识库：HTTP状态字段、刷新幂等键和Mock不联网", async () => {
  installStorage();
  const requests: { path: string; key?: string; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      path: req.url!,
      key: req.headers["idempotency-key"] as string,
      body,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        request_id: "knowledge-fixture",
        data:
          req.method === "POST"
            ? { id: "job-fixture", status: "queued" }
            : {
                enabled: true,
                configured: true,
                source_count: 12,
                ttl_hours: 24,
                latest_job: {
                  id: "job-fixture",
                  status: "succeeded",
                  error: null,
                  created_at: "2026-10-22T00:00:00Z",
                },
              },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const http = await loadApi("http", "http://127.0.0.1:" + port + "/api/v1");
  try {
    const status = await http.api.admissionKnowledge();
    assert.equal(status.sourceCount, 12);
    assert.equal(status.latestJob?.status, "succeeded");
    assert.equal(
      (await http.api.syncAdmissionKnowledge("sync-fixture")).status,
      "queued",
    );
    assert.equal(requests[1].path, "/api/v1/admin/admission-knowledge/sync");
    assert.equal(requests[1].key, "sync-fixture");
    assert.deepEqual(JSON.parse(requests[1].body), {});
  } finally {
    await http.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const mock = await loadApi("mock");
  try {
    assert.equal((await mock.api.admissionKnowledge()).configured, false);
    await assert.rejects(
      mock.api.syncAdmissionKnowledge("mock-sync"),
      /演示模式/,
    );
  } finally {
    await mock.cleanup();
  }
});
