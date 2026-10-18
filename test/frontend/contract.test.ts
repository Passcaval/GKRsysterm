import test from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const doc = JSON.parse(
  readFileSync(
    new URL("../../src/frontend/docs/openapi.json", import.meta.url),
    "utf8",
  ),
);
test("共享契约与前端副本保持一致", () => {
  const shared = new URL("../../docs/contracts/openapi.json", import.meta.url);
  assert.ok(
    existsSync(shared),
    "Shared contract must exist at the repository root",
  );
  assert.deepEqual(JSON.parse(readFileSync(shared, "utf8")), doc);
});
test("每个OpenAPI引用可解析，且操作标识唯一", () => {
  const ids: string[] = [];
  function walk(value: unknown) {
    if (!value || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value)) {
      if (k === "$ref") {
        assert.ok(String(v).startsWith("#/"));
        let target: unknown = doc;
        for (const part of String(v).slice(2).split("/"))
          target = (target as Record<string, unknown>)?.[part];
        assert.ok(target, `unresolved ${v}`);
      } else walk(v);
    }
  }
  walk(doc);
  for (const path of Object.values(doc.paths) as Record<
    string,
    { operationId: string }
  >[])
    for (const op of Object.values(path)) ids.push(op.operationId);
  assert.equal(ids.length, new Set(ids).size);
  assert.ok(ids.length >= 47);
  for (const path of [
    "/registration-applications",
    "/auth/login",
    "/me/profile",
    "/recommendations/{run_id}/events",
    "/feedback",
  ])
    assert.ok(doc.paths[path]);
  assert.equal(doc.paths["/auth/session"], undefined);
  assert.ok(doc.paths["/recommendations"].post.responses["202"]);
  assert.ok(doc.paths["/feedback"].post.responses["201"]);
  assert.ok(doc.paths["/me/profile"].patch);
});
test("所有写接口声明CSRF头，SSE具有专用媒体类型", () => {
  for (const methods of Object.values(doc.paths) as Record<
    string,
    { parameters?: { name: string }[] }
  >[])
    for (const [method, op] of Object.entries(methods))
      if (method !== "get")
        assert.ok(op.parameters?.some((p) => p.name === "X-Requested-With"));
  assert.ok(
    doc.paths["/chat/stream"].post.responses["200"].content[
      "text/event-stream"
    ],
  );
  assert.equal(
    doc.components.schemas.Simulation.properties.probabilities.type,
    "null",
  );
});

test("contract:check拒绝陈旧产物、不自动改写，并接受CRLF副本", () => {
  mkdirSync(new URL("../tmp/", import.meta.url), { recursive: true });
  const tempRoot = mkdtempSync(
    new URL("../tmp/contract-check-", import.meta.url),
  );
  try {
    const scripts = join(tempRoot, "src/frontend/scripts"),
      docs = join(tempRoot, "src/frontend/docs"),
      shared = join(tempRoot, "docs/contracts");
    for (const dir of [scripts, docs, shared, join(tempRoot, ".git")])
      mkdirSync(dir, { recursive: true });
    const script = join(scripts, "contract.mjs");
    copyFileSync(
      new URL("../../src/frontend/scripts/contract.mjs", import.meta.url),
      script,
    );
    assert.equal(
      spawnSync(process.execPath, [script], { encoding: "utf8" }).status,
      0,
    );
    const output = join(docs, "openapi.json"),
      sharedFile = join(shared, "openapi.json");
    writeFileSync(output, readFileSync(output, "utf8").replace(/\n/g, "\r\n"));
    assert.equal(
      spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" })
        .status,
      0,
    );
    writeFileSync(sharedFile, "stale");
    assert.equal(
      spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" })
        .status,
      1,
    );
    assert.equal(readFileSync(sharedFile, "utf8"), "stale");
  } finally {
    const expectedRoot = resolve(
      fileURLToPath(new URL("../tmp/", import.meta.url)),
    );
    assert.ok(resolve(tempRoot).startsWith(expectedRoot));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
