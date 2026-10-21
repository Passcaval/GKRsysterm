import test from "node:test";
import assert from "node:assert/strict";
import { layoutAtlas } from "../../src/frontend/src/atlas-layout.ts";

const catalogue = Array.from({ length: 90 }, (_, i) => ({
  id: `catalogue-${i}`,
  name: "长春师范高等专科学校",
  rank: null,
  x: i < 60 ? 50 : Number.NaN,
  y: i < 60 ? 50 : -100,
}));

for (const [width, height] of [
  [288, 247],
  [366, 523],
  [744, 715],
  [1392, 591],
  [820, 180],
]) {
  test(`星图 ${width}×${height}：重复/无效服务端坐标不造成重叠，所有院校可滚动到达`, () => {
    const layout = layoutAtlas(catalogue, width, height);
    const points = [...layout.positions.values()];
    assert.equal(points.length, catalogue.length);
    assert.ok(layout.height > height);
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      assert.ok(a.x - layout.nodeWidth / 2 >= 0);
      assert.ok(a.x + layout.nodeWidth / 2 <= layout.width);
      assert.ok(a.y - layout.nodeHeight / 2 >= 0);
      assert.ok(a.y + layout.nodeHeight / 2 <= layout.height);
      for (const b of points.slice(i + 1)) {
        assert.ok(
          Math.abs(a.x - b.x) >= layout.nodeWidth ||
            Math.abs(a.y - b.y) >= layout.nodeHeight,
          `院校 ${i} 的名称/点击区域与另一院校重叠`,
        );
      }
      assert.ok(
        Math.abs(a.x - layout.boat.x) >= layout.nodeWidth / 2 + 76 ||
          Math.abs(a.y - layout.boat.y) >= layout.nodeHeight / 2 + 86,
        "初始船只与院校标签相互遮挡",
      );
    }
  });
}

test("加载下一页及重复记录不移动之前的院校", () => {
  const first = layoutAtlas(catalogue.slice(0, 30), 1200, 600);
  const next = layoutAtlas(
    [...catalogue.slice(0, 30), ...catalogue],
    1200,
    600,
  );
  for (const [id, point] of first.positions) {
    assert.deepEqual(next.positions.get(id), point);
  }
  assert.equal(next.positions.size, 90);
  // Both the rendered stars and the boat's destination look up this same map.
  const destination = next.positions.get("catalogue-80")!;
  assert.ok(destination.y > 600);
  assert.ok(Number.isFinite((destination.y / next.height) * 100));
});

test("筛选到单所院校及已停靠状态时，首个结果保持在首屏", () => {
  const layout = layoutAtlas([catalogue[80]], 288, 247, false);
  const school = layout.positions.get(catalogue[80].id)!;
  assert.ok(school.y - layout.nodeHeight / 2 >= 0);
  assert.ok(school.y + layout.nodeHeight / 2 <= 247);
});

test("空星图保留船位和有效画布", () => {
  const layout = layoutAtlas([], 320, 360);
  assert.equal(layout.positions.size, 0);
  assert.equal(layout.width, 320);
  assert.equal(layout.height, 360);
  assert.ok(layout.boat.x > 0 && layout.boat.x < layout.width);
  assert.ok(layout.boat.y > 0 && layout.boat.y < layout.height);
});
