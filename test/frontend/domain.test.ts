import test from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  validateProfile,
  eligible,
  moveEntry,
  rankPosition,
} from "../../src/frontend/src/domain.ts";
import type {
  Profile,
  School,
  PlanEntry,
} from "../../src/frontend/src/types.ts";
const profile: Profile = {
  province: "浙江",
  year: 2026,
  score: 628,
  rank: 23500,
  subjects: ["物理", "化学", "生物"],
  cities: ["杭州"],
  interests: [],
  budget: 10000,
  acceptAdjustment: true,
  consent: true,
};
test("星图与用户位置使用同一位次坐标，筛选不会移动参照，边界不会溢出", () => {
  const ranks = [4800, 24500, 28000, 65000];
  assert.ok(rankPosition(4800, ranks) > rankPosition(28000, ranks));
  assert.equal(rankPosition(23500, ranks), rankPosition(23500, [...ranks]));
  assert.equal(rankPosition(1, ranks), 88);
  assert.equal(rankPosition(5000000, ranks), 10);
  assert.equal(rankPosition(1, []), 50);
});
test("画像拒绝重复选科、非法位次和未授权的数据使用", () => {
  assert.deepEqual(validateProfile(profile), []);
  assert.equal(
    validateProfile({
      ...profile,
      subjects: ["物理", "物理", "化学"],
      rank: 0,
      consent: false,
    }).length,
    3,
  );
  assert.ok(validateProfile({ ...profile, rank: NaN }).length);
});
test("风险偏好只改变分类，不生成录取概率", () => {
  assert.equal(classify(23500, 4800), "reach");
  assert.equal(classify(23500, 28000), "match");
  assert.equal(classify(23500, 65000), "safe");
  assert.equal(classify(23500, 28000, 0), "safe");
  assert.equal(classify(23500, 23500, 100), "reach");
});
test("选科要求必须全部满足", () => {
  const school = { requiredSubjects: ["物理", "化学"] } as School;
  assert.equal(eligible(profile, school), true);
  assert.equal(
    eligible({ ...profile, subjects: ["历史", "政治", "地理"] }, school),
    false,
  );
});
test("编排调整保持稳定ID，越界不丢失条目且不修改原数组", () => {
  const entries = [{ id: "a" }, { id: "b" }, { id: "c" }] as PlanEntry[];
  assert.deepEqual(
    moveEntry(entries, 0, 2).map((e) => e.id),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    entries.map((e) => e.id),
    ["a", "b", "c"],
  );
  assert.deepEqual(moveEntry(entries, 0, -1), entries);
});
