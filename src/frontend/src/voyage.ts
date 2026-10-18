export interface Point {
  x: number;
  y: number;
}
/** Beam widens towards the map; all coordinates share the scene's SVG space. */
export function lightBeamPolygon(
  source: Point,
  target: Point,
  halfWidth = 25,
): string {
  const dx = target.x - source.x,
    dy = target.y - source.y;
  const length = Math.hypot(dx, dy);
  if (length === 0)
    return `${source.x},${source.y} ${source.x},${source.y} ${source.x},${source.y}`;
  const nx = -dy / length,
    ny = dx / length;
  return [
    [source.x + nx * 2, source.y + ny * 2],
    [target.x + nx * halfWidth, target.y + ny * halfWidth],
    [target.x - nx * halfWidth, target.y - ny * halfWidth],
    [source.x - nx * 2, source.y - ny * 2],
  ]
    .map((p) => p.join(","))
    .join(" ");
}
/** Real-time camera move, keeping the chart at the transform origin. No video download. */
export async function zoomIntoChart(
  scene: HTMLElement,
  chart: HTMLElement,
  navigate: () => void,
) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    navigate();
    return;
  }
  const bounds = scene.getBoundingClientRect(),
    map = chart.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "voyage-transition";
  overlay.setAttribute("aria-hidden", "true");
  overlay.inert = true;
  const clone = scene.cloneNode(true) as HTMLElement;
  const movingBoat = scene.querySelector<HTMLElement>(".voyager-motion");
  const frozenBoat = clone.querySelector<HTMLElement>(".voyager-motion");
  if (movingBoat && frozenBoat) {
    frozenBoat.style.animation = "none";
    frozenBoat.style.transform = getComputedStyle(movingBoat).transform;
  }
  clone.classList.add("voyage-camera");
  Object.assign(clone.style, {
    position: "absolute",
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    margin: "0",
    maxWidth: "none",
    transformOrigin: `${map.left + map.width / 2 - bounds.left}px ${map.top + map.height / 2 - bounds.top}px`,
  });
  overlay.append(clone);
  document.body.append(overlay);
  const dx = innerWidth / 2 - (map.left + map.width / 2),
    dy = innerHeight / 2 - (map.top + map.height / 2);
  const scale = Math.min(18, Math.max(7, innerWidth / Math.max(1, map.width)));
  let navigated = false;
  try {
    overlay.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: 180,
      fill: "forwards",
    });
    await clone.animate(
      [
        { transform: "translate(0,0) scale(1)", filter: "brightness(1)" },
        {
          transform: `translate(${dx * 0.15}px,${dy * 0.15}px) scale(1.15)`,
          filter: "brightness(1.12)",
          offset: 0.22,
        },
        {
          transform: `translate(${dx}px,${dy}px) scale(${scale})`,
          filter: "brightness(1.5)",
        },
      ],
      { duration: 1350, easing: "cubic-bezier(.62,0,.18,1)", fill: "forwards" },
    ).finished;
    navigate();
    navigated = true;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    await overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 380,
      fill: "forwards",
    }).finished;
  } catch {
    if (!navigated) navigate();
  } finally {
    overlay.remove();
  }
}
