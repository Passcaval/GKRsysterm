import test from "node:test";
import assert from "node:assert/strict";
import {
  blankProfile,
  cleanNavigatorProfile,
} from "../../src/frontend/src/navigator-domain.ts";
import { missingForIntent } from "../../src/frontend/src/workflow-domain.ts";
import { validateProfile } from "../../src/frontend/src/domain.ts";

test("省份位次三门选科足以开始推荐，分数和所有偏好不阻断", () => {
  const value = {
    ...blankProfile(),
    province: "浙江",
    rank: 20000,
    subjects: ["物理", "化学", "技术"],
    consent: true,
  };
  assert.deepEqual(missingForIntent(value, "admission"), []);
  assert.deepEqual(validateProfile(value), []);
  assert.deepEqual(missingForIntent({ ...value, subjects: [] }, "admission"), [
    "subjects",
  ]);
  assert.deepEqual(missingForIntent({ ...value, rank: null }, "admission"), [
    "rank",
  ]);
  assert.ok(
    validateProfile({ ...value, subjects: ["物理", "化学", "未知"] }).length,
  );
});
test("补充意向地域与院校会保留生源省份、画像版本与原对象", () => {
  const value = {
    ...blankProfile(),
    province: "浙江",
    version: 2,
    cities: ["江苏", " 杭州 ", "江苏", ""],
    preferredSchools: ["合成大学", "合成大学"],
    interests: ["计算机", ""],
  };
  const next = cleanNavigatorProfile(value);
  assert.deepEqual(next.cities, ["江苏", "杭州"]);
  assert.deepEqual(next.preferredSchools, ["合成大学"]);
  assert.deepEqual(next.interests, ["计算机"]);
  assert.equal(next.province, "浙江");
  assert.equal(next.version, 2);
  assert.equal(value.cities.length, 4);
});
