import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, rm } from "node:fs/promises";
const require = createRequire(import.meta.url);
const viteRequire = createRequire(require.resolve("vite"));
const { build } = await import(
  pathToFileURL(viteRequire.resolve("esbuild")).href
);
test("演示工作流：权限、投稿待审、人工发布、重复审核冲突、方案乐观锁与数据清除", async () => {
  const storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    value: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
    configurable: true,
  });
  const dir = new URL("../tmp/mock-test/", import.meta.url);
  await mkdir(dir, { recursive: true });
  try {
    const outfile = new URL("api.mjs", dir);
    await build({
      entryPoints: [fileURLToPath(new URL("../src/api.ts", import.meta.url))],
      outfile: fileURLToPath(outfile),
      bundle: true,
      write: true,
      platform: "node",
      format: "esm",
      define: { "import.meta.env": '{"VITE_API_MODE":"mock"}' },
    });
    const { api } = await import(outfile.href);
    const initial = await api.bootstrap();
    await assert.rejects(
      api.moderation(),
      (e: unknown) => (e as { status: number }).status === 403,
    );
    await assert.rejects(
      api.feedback("p1", "helpful"),
      (e: unknown) => (e as { status: number }).status === 403,
    );
    const post = await api.submitPost({
      schoolId: "hdu",
      topic: "校园生活",
      title: "测试用校园来信",
      body: "明确标注的本地测试内容，不代表任何真实校园经历。".repeat(5),
    });
    assert.equal(post.status, "pending");
    assert.equal(post.trust.supporting, 0);
    assert.equal(post.trust.identity, 0);
    assert.equal(post.isMine, true);
    await api.login("reviewer@example.test", "NightVoyageDemo!");
    assert.ok(
      (await api.moderation()).some((p: { id: string }) => p.id === post.id),
    );
    assert.equal(
      (await api.review(post.id, "approve", "自动化测试：检查状态转换")).status,
      "published",
    );
    await assert.rejects(
      api.review(post.id, "reject", "再次审核应产生冲突"),
      (e: unknown) => (e as { status: number }).status === 409,
    );
    const plan = await api.plan({
      ...initial.plan,
      entries: [
        {
          id: "e1",
          schoolId: "hdu",
          major: "计算机科学与技术",
          adjustment: true,
        },
      ],
    });
    assert.equal(plan.version, initial.plan.version + 1);
    await assert.rejects(
      api.plan(initial.plan),
      (e: unknown) => (e as { status: number }).status === 409,
    );
    await api.deleteProfile();
    const cleared = await api.bootstrap();
    assert.equal(cleared.profile, null);
    assert.equal(cleared.plan.entries.length, 0);
    assert.deepEqual(cleared.favorites, []);
  } finally {
    assert.ok(
      fileURLToPath(dir).startsWith(
        fileURLToPath(new URL("../tmp/", import.meta.url)),
      ),
    );
    await rm(dir, { recursive: true, force: true });
  }
});
