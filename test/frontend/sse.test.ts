import test from "node:test";
import assert from "node:assert/strict";
import { EventDecoder } from "../../src/frontend/src/sse.ts";
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
test("SSE profile_update carries the auto-applied profile", () => {
  const payload = {
    type: "profile_update",
    signal_id: "signal-1",
    applied: true,
    profile: {
      province: "浙江",
      year: 2026,
      version: 3,
      profileVersionId: "profile-1",
    },
    conversation_profile: {
      province: "浙江",
      year: 2026,
      score: 628,
      rank: 33226,
      subjects: [],
    },
    expected_version: 2,
    question: "已根据这次对话记下：生源省份 → 浙江",
    source_ids: ["source-1"],
    changes: [
      { field: "province", label: "生源省份", old: "河南", new: "浙江" },
    ],
  };
  assert.deepEqual(
    new EventDecoder().push("data: " + JSON.stringify(payload) + "\n\n"),
    [
      {
        type: "profile_update",
        signalId: "signal-1",
        applied: true,
        profile: {
          province: "浙江",
          year: 2026,
          version: 3,
          profileVersionId: "profile-1",
        },
        conversationProfile: {
          province: "浙江",
          year: 2026,
          score: 628,
          rank: 33226,
          subjects: [],
        },
        expectedVersion: 2,
        question: "已根据这次对话记下：生源省份 → 浙江",
        sourceIds: ["source-1"],
        changes: [
          { field: "province", label: "生源省份", old: "河南", new: "浙江" },
        ],
      },
    ],
  );
  assert.throws(
    () =>
      new EventDecoder().push(
        'data: {"type":"profile_update","signal_id":"signal-1"}\n\n',
      ),
    /字段/,
  );
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
