// Use a disposable HTTP fixture to exercise the real fetch adapter, not mock mode.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL, fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const { build } = await import(
  pathToFileURL(viteRequire.resolve("esbuild")).href
);
test("真实HTTP适配：响应信封、写请求头、409冲突、SSE中文分块与中止", async () => {
  let received: unknown;
  let csrf = "";
  const server = createServer(async (req, res) => {
    if (req.url === "/api/v1/chat/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const bytes = Buffer.from(
        'data: {"type":"delta","text":"杭电"}\r\n\r\ndata: {"type":"done","conversationId":"c-http"}\n\n',
      );
      for (let i = 0; i < bytes.length; i += 3) {
        res.write(bytes.subarray(i, i + 3));
        await new Promise((resolve) => setImmediate(resolve));
      }
      res.end();
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    received = body ? JSON.parse(body) : undefined;
    csrf = String(req.headers["x-requested-with"] || "");
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/v1/me/plan") {
      res.writeHead(409);
      res.end(
        JSON.stringify({
          error: { code: "PLAN_VERSION_CONFLICT", message: "版本冲突" },
          requestId: "req-conflict",
        }),
      );
      return;
    }
    if (req.url === "/api/v1/recommendations") {
      res.end(JSON.stringify({ data: [], requestId: "req-ok" }));
      return;
    }
    res.end(JSON.stringify({ data: null, requestId: "req-ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const dir = new URL("../tmp/http-test/", import.meta.url);
  await mkdir(dir, { recursive: true });
  try {
    const outfile = new URL("api.mjs", dir);
    await build({
      entryPoints: [fileURLToPath(new URL("../src/api.ts", import.meta.url))],
      outfile: fileURLToPath(outfile),
      bundle: true,
      platform: "node",
      format: "esm",
      define: {
        "import.meta.env": JSON.stringify({
          VITE_API_MODE: "http",
          VITE_API_BASE_URL: `http://127.0.0.1:${port}/api/v1`,
        }),
      },
    });
    const { api, ApiError, isMock } = await import(outfile.href);
    assert.equal(isMock, false);
    assert.deepEqual(await api.recommendations(63), []);
    assert.deepEqual(received, { riskPreference: 63 });
    assert.equal(csrf, "NightVoyage");
    await assert.rejects(
      api.plan({ id: "p", version: 1, name: "test", entries: [] }),
      (e: unknown) =>
        e instanceof ApiError &&
        (e as { status: number }).status === 409 &&
        (e as { requestId: string }).requestId === "req-conflict",
    );
    const events = [];
    for await (const e of api.chat(
      "测试",
      undefined,
      new AbortController().signal,
    ))
      events.push(e);
    assert.deepEqual(events, [
      { type: "delta", text: "杭电" },
      { type: "done", conversationId: "c-http" },
    ]);
    const c = new AbortController();
    c.abort();
    await assert.rejects(
      async () => {
        for await (const _ of api.chat("中止", undefined, c.signal)) {
        }
      },
      (e: unknown) => (e as Error).name === "AbortError",
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert.ok(
      fileURLToPath(dir).startsWith(
        fileURLToPath(new URL("../tmp/", import.meta.url)),
      ),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
