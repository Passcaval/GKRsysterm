import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const doc = JSON.parse(
  readFileSync(new URL("../docs/openapi.json", import.meta.url), "utf8"),
);
test("前端接口副本与共享契约一致", () => {
  const shared = JSON.parse(
    readFileSync(
      new URL("../../../docs/contracts/openapi.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(doc, shared);
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
  assert.equal(ids.length, 17);
  assert.ok(doc.paths["/auth/login"].post);
  assert.ok(doc.paths["/auth/logout"].post);
  assert.equal(doc.paths["/auth/session"], undefined);
  assert.deepEqual(doc.components.schemas.LoginRequest.required, [
    "login_type",
    "identifier",
    "password",
  ]);
  assert.equal(doc.components.schemas.LoginRequest.additionalProperties, false);
  const invalid =
    doc.paths["/auth/login"].post.responses[422].content["application/json"];
  assert.equal(invalid.schema.$ref, "#/components/schemas/Error");
  assert.equal(invalid.examples.invalidEmail.value.error.code, "EMAIL_INVALID");
  assert.ok(
    invalid.examples.invalidEmail.value.error.message.includes("请重新输入"),
  );
  assert.ok(invalid.examples.invalidEmail.value.requestId);
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
