import { useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { useApp } from "./store";
import { lightBeamPolygon, zoomIntoChart } from "./voyage";
import voyager from "./assets/voyager.png";
import lighthouse from "./assets/lighthouse.png";

export function VoyageScene() {
  const { navigate } = useApp();
  const scene = useRef<HTMLDivElement>(null),
    lantern = useRef<HTMLSpanElement>(null),
    chart = useRef<HTMLButtonElement>(null);
  const light = {
    source: { x: 790, y: 120 },
    target: { x: 440, y: 380 },
  };
  const [zooming, setZooming] = useState(false);
  useLayoutEffect(() => {
    const beam = scene.current?.querySelector("polygon");
    const gradient = scene.current?.querySelector("#lighthouse-beam");
    const ray = scene.current?.querySelector(".lighthouse-light > path");
    const handGlow = scene.current?.querySelector(
      ".lighthouse-light > ellipse",
    );
    const lampGlow = scene.current?.querySelector(".lighthouse-light > circle");
    const measure = () => {
      if (!scene.current || !lantern.current || !chart.current) return;
      const s = scene.current.getBoundingClientRect(),
        l = lantern.current.getBoundingClientRect(),
        m = chart.current.getBoundingClientRect();
      if (!s.width || !s.height) return;
      const current = {
        source: {
          x: ((l.left + l.width / 2 - s.left) / s.width) * 1000,
          y: ((l.top + l.height / 2 - s.top) / s.height) * 660,
        },
        target: {
          x: ((m.left + m.width / 2 - s.left) / s.width) * 1000,
          y: ((m.top + m.height / 2 - s.top) / s.height) * 660,
        },
      };
      beam?.setAttribute(
        "points",
        lightBeamPolygon(current.source, current.target, 42),
      );
      gradient?.setAttribute("x1", String(current.source.x));
      gradient?.setAttribute("y1", String(current.source.y));
      gradient?.setAttribute("x2", String(current.target.x));
      gradient?.setAttribute("y2", String(current.target.y));
      ray?.setAttribute(
        "d",
        `M${current.source.x} ${current.source.y} L${current.target.x} ${current.target.y}`,
      );
      handGlow?.setAttribute("cx", String(current.target.x));
      handGlow?.setAttribute("cy", String(current.target.y));
      lampGlow?.setAttribute("cx", String(current.source.x));
      lampGlow?.setAttribute("cy", String(current.source.y));
    };
    const observer = new ResizeObserver(measure);
    if (scene.current) observer.observe(scene.current);
    let visible = true;
    const visibility = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
    });
    if (scene.current) visibility.observe(scene.current);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0,
      previousMotion: boolean | undefined;
    const track = () => {
      const moving = !reduced.matches;
      if (visible && (moving || previousMotion !== moving)) measure();
      previousMotion = moving;
      frame = requestAnimationFrame(track);
    };
    frame = requestAnimationFrame(track);
    measure();
    return () => {
      observer.disconnect();
      visibility.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);
  async function enter() {
    if (zooming || !scene.current || !chart.current) return;
    setZooming(true);
    await zoomIntoChart(scene.current, chart.current, () =>
      navigate("/explore"),
    );
    setZooming(false);
  }
  return (
    <figure className="voyage-figure">
      <div ref={scene} className="voyage-scene" data-testid="voyage-scene">
        <span className="scene-coordinate" aria-hidden="true">
          30° N / 120° E
        </span>
        <div className="scene-night-stars" aria-hidden="true" />
        <svg className="scene-sea" viewBox="0 0 1000 660" aria-hidden="true">
          <ellipse cx="410" cy="530" rx="320" ry="45" />
          <ellipse cx="410" cy="530" rx="245" ry="29" />
          <path d="M40 570 Q270 525 500 572 T980 565 M150 605 Q420 565 730 605" />
        </svg>
        <div className="lighthouse-art">
          <img src={lighthouse} alt="灰金色灯塔，灯室亮着温暖的金光" />
          <span ref={lantern} className="lantern-origin" aria-hidden="true" />
        </div>
        <svg
          className="lighthouse-light"
          viewBox="0 0 1000 660"
          preserveAspectRatio="none"
          aria-hidden="true"
          data-testid="lighthouse-light"
        >
          <defs>
            <linearGradient
              id="lighthouse-beam"
              gradientUnits="userSpaceOnUse"
              x1={light.source.x}
              y1={light.source.y}
              x2={light.target.x}
              y2={light.target.y}
            >
              <stop stopColor="#ffe4a3" stopOpacity=".45" />
              <stop offset=".7" stopColor="#e2c181" stopOpacity=".18" />
              <stop offset="1" stopColor="#ffe5a7" stopOpacity=".08" />
            </linearGradient>
            <filter id="beam-softness">
              <feGaussianBlur stdDeviation="3" />
            </filter>
            <radialGradient id="hand-light">
              <stop stopColor="#ffe5a3" stopOpacity=".65" />
              <stop offset="1" stopColor="#e1bc78" stopOpacity="0" />
            </radialGradient>
          </defs>
          <polygon
            points={lightBeamPolygon(light.source, light.target, 42)}
            fill="url(#lighthouse-beam)"
            filter="url(#beam-softness)"
          />
          <path
            d={`M${light.source.x} ${light.source.y} L${light.target.x} ${light.target.y}`}
            stroke="#ffe1a3"
            strokeWidth=".8"
            opacity=".32"
          />
          <ellipse
            cx={light.target.x}
            cy={light.target.y}
            rx="69"
            ry="36"
            fill="url(#hand-light)"
          />
          <circle
            cx={light.source.x}
            cy={light.source.y}
            r="21"
            fill="url(#hand-light)"
          />
        </svg>
        <div className="voyager-art">
          <div className="voyager-motion">
            <img src={voyager} alt="一个小人坐在木船上，双手捧着展开的星图" />
            <button
              ref={chart}
              className="chart-hotspot"
              aria-label="打开手中的星图，前往院校星图"
              disabled={zooming}
              onClick={() => void enter()}
            >
              <span className="chart-shimmer" />
              <span className="chart-crosshair" aria-hidden="true">
                ✧
              </span>
            </button>
          </div>
        </div>
        <div className="chart-invitation">
          <span className="invitation-line" />
          <span>
            {zooming ? "正在驶入你的星图…" : "点亮手中的星图，看看你的下一站"}
          </span>
          <ArrowUpRight size={14} />
        </div>
      </div>
      <figcaption>一束光，照见属于你的方向。</figcaption>
    </figure>
  );
}
