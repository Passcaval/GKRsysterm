import type { Post } from "./types";
import type { Point } from "./voyage";

/** A campus board never mixes letters from other schools or unpublished drafts. */
export function campusPosts(
  posts: Post[],
  schoolId: string,
  topic = "全部回声",
  strongOnly = false,
  query = "",
) {
  const term = query.trim().toLocaleLowerCase();
  return posts.filter(
    (p) =>
      p.schoolId === schoolId &&
      p.status === "published" &&
      (topic === "全部回声" || p.topic === topic) &&
      (!strongOnly || p.signal === "strong") &&
      `${p.title} ${p.excerpt} ${p.author}`.toLocaleLowerCase().includes(term),
  );
}

/** Percentage-space curve; the displayed marker and animation share endpoints. */
export function sailingPoint(from: Point, to: Point, t: number): Point {
  const progress = Math.max(0, Math.min(1, t));
  const dx = to.x - from.x,
    dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  const bend = Math.min(7, distance / 5);
  const control = {
    x: (from.x + to.x) / 2 - (distance ? (dy / distance) * bend : 0),
    y: (from.y + to.y) / 2 + (distance ? (dx / distance) * bend : 0),
  };
  return {
    x:
      (1 - progress) ** 2 * from.x +
      2 * (1 - progress) * progress * control.x +
      progress ** 2 * to.x,
    y:
      (1 - progress) ** 2 * from.y +
      2 * (1 - progress) * progress * control.y +
      progress ** 2 * to.y,
  };
}
