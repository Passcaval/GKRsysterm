import test from "node:test";
import assert from "node:assert/strict";
import { lightBeamPolygon } from "../src/voyage.ts";
test("灯光中心精确连接灯室和星图，并保持目标端对称", () => {
  const source = { x: 820, y: 110 },
    target = { x: 430, y: 360 };
  const points = lightBeamPolygon(source, target, 42)
    .split(" ")
    .map((p) => p.split(",").map(Number));
  assert.equal(points.length, 4);
  assert.ok(Math.abs((points[1][0] + points[2][0]) / 2 - target.x) < 1e-9);
  assert.ok(Math.abs((points[1][1] + points[2][1]) / 2 - target.y) < 1e-9);
  assert.ok(Math.abs((points[0][0] + points[3][0]) / 2 - source.x) < 1e-9);
  assert.ok(
    Math.abs(
      Math.hypot(points[1][0] - points[2][0], points[1][1] - points[2][1]) - 84,
    ) < 1e-9,
  );
});
test("重合的光源与星图不会产生NaN或无限值", () => {
  const shape = lightBeamPolygon({ x: 0, y: 0 }, { x: 0, y: 0 });
  assert.ok(!/NaN|Infinity/.test(shape));
});
