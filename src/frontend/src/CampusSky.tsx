import { useState } from "react";
import { ArrowLeft, ArrowUpRight, MapPin, Pause, Play } from "lucide-react";
import { useApp } from "./store";
import type { School } from "./types";
import nightSky from "./assets/campus-night.png";

export function CampusSky({
  school,
  count,
}: {
  school: School;
  count: number | null;
}) {
  const { navigate } = useApp();
  const [paused, setPaused] = useState(false);
  return (
    <section
      className={`campus-sky ${paused ? "sky-paused" : ""}`}
      aria-label={`${school.name}回声广场`}
    >
      <img
        className="campus-night-art"
        src={nightSky}
        alt="航海者坐在船上，手持星图，仰望金色星空"
      />
      <div className="meteor-field" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="campus-sky-copy">
        <button className="text-button" onClick={() => navigate("/explore")}>
          <ArrowLeft size={14} /> 返回星图 · 换一所院校
        </button>
        <span className="eyebrow">ONE CAMPUS. A THOUSAND ECHOES.</span>
        <p className="campus-coordinate">
          <span className="live-dot" /> 当前院校{" "}
          <span>
            {school.province} / {school.city}
          </span>
        </p>
        <h1>
          {school.name}
          <span>回声广场</span>
        </h1>
        <p className="campus-sky-description">
          星光引你抵达，真实的声音让你靠近。
          <br />
          听听在这里学习、生活的人，写给未来的信。
        </p>
        <div className="campus-sky-meta">
          <span>
            <MapPin size={12} />
            {school.city}
          </span>
          <span>{school.level}</span>
          <span>
            {count === null ? "按需读取本校来信" : `${count} 封已公开来信`}
          </span>
        </div>
        <button
          className="text-button campus-profile-link"
          onClick={() => navigate("/school/" + school.id)}
        >
          查看这所院校的档案 <ArrowUpRight size={14} />
        </button>
      </div>
      <button
        className="sky-motion-toggle"
        aria-pressed={paused}
        aria-label={paused ? "播放流星动效" : "暂停流星动效"}
        onClick={() => setPaused(!paused)}
      >
        {paused ? <Play size={12} /> : <Pause size={12} />}{" "}
        <span>{paused ? "播放星夜" : "暂停流星"}</span>
      </button>
      <span className="campus-sky-caption">抬头看星光，也听见真实的日常。</span>
    </section>
  );
}
