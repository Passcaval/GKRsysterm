import test from "node:test";
import assert from "node:assert/strict";
import { EventDecoder } from "../src/sse.ts";
test("SSE handles byte/chunk boundaries, CRLF, comments, and multiple events", () => {
  const p = new EventDecoder();
  assert.deepEqual(
    p.push(': heartbeat\r\n\r\nevent: delta\r\ndata: {"type":"del'),
    [],
  );
  assert.deepEqual(p.push('ta","text":"杭州"}\r'), []);
  assert.deepEqual(
    p.push('\n\r\ndata: {"type":"done","conversationId":"c1"}\n\n'),
    [
      { type: "delta", text: "杭州" },
      { type: "done", conversationId: "c1" },
    ],
  );
  p.finish();
});
test("SSE refuses malformed JSON and incomplete stream instead of silently succeeding", () => {
  assert.throws(() => new EventDecoder().push("data: invalid\n\n"));
  const p = new EventDecoder();
  p.push('data: {"type":"delta"');
  assert.throws(() => p.finish(), /断开/);
  assert.throws(
    () => new EventDecoder().push('data: {"type":"unknown"}\n\n'),
    /未知/,
  );
});
