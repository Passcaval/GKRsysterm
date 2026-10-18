import test from "node:test";
import assert from "node:assert/strict";
import { campusPosts, sailingPoint } from "../../src/frontend/src/campus.ts";
import type { Post } from "../../src/frontend/src/types.ts";

const post = (id: string, schoolId: string, patch: Partial<Post> = {}): Post =>
  ({
    id,
    schoolId,
    status: "published",
    topic: "校园生活",
    title: "图书馆日常",
    excerpt: "安静的自习空间",
    author: "信息类学长",
    signal: "strong",
    ...patch,
  }) as Post;
test("院校回声不混入其他院校或未公开的内容，筛选也不能跨院校", () => {
  const posts = [
    post("a", "hdu"),
    post("b", "njupt"),
    post("c", "hdu", { status: "pending" }),
    post("d", "hdu", { status: "rejected" }),
    post("e", "hdu", { signal: "medium", topic: "专业与学风" }),
  ];
  assert.deepEqual(
    campusPosts(posts, "hdu").map((p) => p.id),
    ["a", "e"],
  );
  assert.deepEqual(
    campusPosts(posts, "hdu", "全部回声", true, "  图书馆 ").map((p) => p.id),
    ["a"],
  );
  assert.deepEqual(
    campusPosts(posts, "hdu", "专业与学风").map((p) => p.id),
    ["e"],
  );
  assert.equal(campusPosts(posts, "unknown").length, 0);
});
test("划船航线从当前停靠位置出发并准确到达所选星体，重合位置无异常", () => {
  const from = { x: 42, y: 82 },
    to = { x: 77, y: 31 };
  assert.deepEqual(sailingPoint(from, to, 0), from);
  assert.deepEqual(sailingPoint(from, to, 1), to);
  assert.deepEqual(sailingPoint(from, to, -1), from);
  assert.deepEqual(sailingPoint(from, to, 2), to);
  assert.notDeepEqual(sailingPoint(from, to, 0.5), { x: 59.5, y: 56.5 });
  assert.deepEqual(sailingPoint(from, from, 0.5), from);
});
