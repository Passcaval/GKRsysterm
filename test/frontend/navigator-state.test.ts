import test from "node:test";
import assert from "node:assert/strict";
import {
  atlasContext,
  loadNavigator,
  saveNavigator,
  emptyNavigator,
} from "../../src/frontend/src/navigator-state.ts";
import { storage, installStorage, loadApi } from "./helpers.ts";
import { createServer } from "node:http";
test("关闭后重建会话可恢复完整历史、会话编号和匿名画像，账号之间隔离", () => {
  const disk = storage();
  const value = {
    ...emptyNavigator(),
    messages: [
      {
        role: "user" as const,
        text: "浙江8000名，想去杭州读计算机",
        sourceIds: [],
      },
    ],
    conversationId: "conversation-fixture",
    profile: {
      province: "浙江",
      year: 2026,
      rank: 8000,
      score: null,
      subjects: ["物理", "化学", "生物"],
      cities: ["杭州"],
      interests: ["计算机"],
      budget: null,
      acceptAdjustment: false,
      consent: false,
    },
  };
  saveNavigator("anonymous", value, disk);
  assert.deepEqual(loadNavigator("anonymous", disk), value);
  assert.deepEqual(loadNavigator("different-account", disk), emptyNavigator());
  saveNavigator("anonymous", emptyNavigator(), disk);
  assert.deepEqual(loadNavigator("anonymous", disk), emptyNavigator());
});
test("星图默认浙江8000名，对话信息更新位次选科和偏好，手工城市专业可覆盖", () => {
  assert.deepEqual(atlasContext(null), {
    province: "浙江",
    year: 2026,
    rank: 8000,
    subjects: [],
    cities: [],
    majors: [],
    query: "",
  });
  const profile = {
    province: "浙江",
    year: 2026,
    rank: 25000,
    score: null,
    subjects: ["物理", "化学", "生物"],
    cities: ["杭州"],
    interests: ["计算机"],
    budget: null,
    acceptAdjustment: false,
    consent: false,
  };
  assert.equal(atlasContext(profile).rank, 25000);
  assert.deepEqual(atlasContext(profile).majors, ["计算机"]);
  assert.deepEqual(atlasContext(profile, "南京，苏州", "临床医学").cities, [
    "南京",
    "苏州",
  ]);
  assert.deepEqual(atlasContext(profile, "", "").majors, []);
});
test("匿名星图访问层发送省份位次、城市专业，正确读取历史参考且不要求登录", async () => {
  installStorage();
  let seen: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/api/v1/atlas/search");
    assert.equal(req.headers["x-requested-with"], "NightVoyage");
    let text = "";
    for await (const chunk of req) text += chunk;
    seen = JSON.parse(text);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        data: { items: [], basis: seen, ranked_count: 0, note: "test-fixture" },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const http = await loadApi("http", "http://127.0.0.1:" + port + "/api/v1");
  try {
    const result = await http.api.atlasSearch(
      atlasContext(null, "杭州", "计算机"),
    );
    assert.equal(seen.rank, 8000);
    assert.deepEqual(seen.cities, ["杭州"]);
    assert.deepEqual(seen.majors, ["计算机"]);
    assert.equal(result.rankedCount, 0);
  } finally {
    await http.cleanup();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
