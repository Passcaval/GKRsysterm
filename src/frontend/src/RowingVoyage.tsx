import { useEffect, useRef, useState } from "react";
import type { Point } from "./voyage";
import { sailingPoint } from "./campus";
import rowingVideo from "./assets/rowing.webm";
import rowingSheet from "./assets/rowing-sheet.png";

export function RowingVoyage({
  from,
  to,
  onArrive,
}: {
  from: Point;
  to: Point;
  onArrive: () => void;
}) {
  const vessel = useRef<HTMLDivElement>(null);
  const [videoReady, setVideoReady] = useState(false);
  const arrive = useRef(onArrive);
  arrive.current = onArrive;
  useEffect(() => {
    const node = vessel.current;
    if (!node) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let active = true;
    let finished = false;
    const finish = () => {
      if (active && !finished) {
        finished = true;
        arrive.current();
      }
    };
    if (reduced.matches) {
      finish();
      return () => {
        active = false;
      };
    }
    const bounds = node.parentElement!.getBoundingClientRect();
    const frames = Array.from({ length: 41 }, (_, index) => {
      const t = index / 40;
      const point = sailingPoint(from, to, t);
      const ahead = sailingPoint(from, to, Math.min(1, t + 0.025));
      const behind = sailingPoint(from, to, Math.max(0, t - 0.025));
      const angle =
        (Math.atan2(
          (ahead.y - behind.y) * bounds.height,
          (ahead.x - behind.x) * bounds.width,
        ) *
          180) /
          Math.PI +
        90;
      return {
        left: `${point.x}%`,
        top: `${point.y}%`,
        transform: `translate(-50%,-50%) rotate(${angle}deg)`,
        offset: t,
      };
    });
    const animation = node.animate(frames, {
      duration: 3800,
      easing: "cubic-bezier(.32,.05,.25,1)",
      fill: "forwards",
    });
    animation.finished.then(finish).catch(() => {});
    const preferenceChanged = () => {
      if (reduced.matches) finish();
    };
    reduced.addEventListener("change", preferenceChanged);
    return () => {
      active = false;
      animation.cancel();
      reduced.removeEventListener("change", preferenceChanged);
    };
  }, [from.x, from.y, to.x, to.y]);
  const points = Array.from({ length: 41 }, (_, i) => {
    const p = sailingPoint(from, to, i / 40);
    return `${p.x},${p.y}`;
  }).join(" ");
  return (
    <>
      <svg
        className="sailing-route"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polyline points={points} />
      </svg>
      <div
        className="sailing-position"
        ref={vessel}
        aria-hidden="true"
        style={{ left: `${from.x}%`, top: `${from.y}%` }}
      >
        <span className="rowing-wake" />
        {!videoReady && (
          <span
            className="rowing-sprite"
            style={{ backgroundImage: `url(${rowingSheet})` }}
          />
        )}
        <video
          className="rowing-video"
          src={rowingVideo}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          onPlaying={() => setVideoReady(true)}
          onError={() => setVideoReady(false)}
        />
      </div>
    </>
  );
}
