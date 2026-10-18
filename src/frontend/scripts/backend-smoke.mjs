// Called only by the isolated PostgreSQL backend test, never against user data.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.NV_TEST_API;
if (!/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/.test(base || ""))
  throw new Error("Only the isolated local test server is supported");
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const { build } = await import(
  pathToFileURL(viteRequire.resolve("esbuild")).href
);
const dir = await mkdtemp(join(tmpdir(), "nv-adapter-test-"));
const originalFetch = globalThis.fetch;
let cookie = "";
globalThis.fetch = async (url, options = {}) => {
  const headers = new Headers(options.headers);
  headers.set("Origin", "http://testserver");
  if (cookie) headers.set("Cookie", cookie);
  const response = await originalFetch(url, { ...options, headers });
  for (const value of response.headers.getSetCookie())
    cookie = value.split(";")[0];
  return response;
};
try {
  const outfile = join(dir, "api.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/api.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    define: {
      "import.meta.env": JSON.stringify({
        VITE_API_MODE: "http",
        VITE_API_BASE_URL: base,
      }),
    },
  });
  const { api, ApiError, isMock } = await import(pathToFileURL(outfile).href);
  assert.equal(isMock, false);
  assert.equal((await api.bootstrap()).user, null);
  await assert.rejects(
    api.login("bad@@example.test", "Test-only Strong Pass!"),
    (e) =>
      e instanceof ApiError &&
      e.status === 422 &&
      e.message.includes("请重新输入"),
  );
  const user = await api.login(
    "student@example.test",
    "Test-only Strong Pass!",
  );
  assert.equal(user.role, "student");
  assert.equal((await api.bootstrap()).user.id, user.id);
  await assert.rejects(api.moderation(), (e) => e.status === 403);
  await api.profile({
    province: "浙江",
    year: 2026,
    score: 600,
    rank: 20000,
    subjects: ["物理", "化学", "生物"],
    cities: ["测试市"],
    interests: ["计算机"],
    budget: 10000,
    acceptAdjustment: true,
    consent: true,
  });
  const recommendations = await api.recommendations(50);
  assert.equal(recommendations.length, 1);
  assert.equal(recommendations[0].tier, "unknown");
  assert.ok(recommendations[0].sourceIds.length);
  const snapshot = await api.bootstrap();
  const school = snapshot.schools[0];
  assert.ok((await api.favorite(school.id, true)).includes(school.id));
  const plan = await api.plan({
    ...snapshot.plan,
    entries: [
      {
        id: "live-entry",
        schoolId: school.id,
        major: recommendations[0].major,
        adjustment: true,
      },
    ],
  });
  assert.equal((await api.simulate(plan)).probabilities, null);
  await api.logout();
  assert.equal((await api.bootstrap()).user, null);
  assert.equal(
    (await api.login("admin@example.test", "Test-only Strong Pass!")).role,
    "admin",
  );
  assert.deepEqual(await api.moderation(), []);
  await api.logout();
  console.log("Real frontend adapter -> Uvicorn -> PostgreSQL smoke passed.");
} finally {
  globalThis.fetch = originalFetch;
  // mkdtemp created this unique directory; only generated test output is removed.
  await rm(dir, { recursive: true, force: true });
}
