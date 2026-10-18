import { useState, useRef, useEffect } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  MapPin,
  LocateFixed,
  Plus,
  Minus,
  Sparkles,
  ChevronRight,
  FileCheck2,
  MessagesSquare,
  Navigation,
} from "lucide-react";
import { useApp } from "../store";
import { isMock } from "../api";
import { SectionTitle, SignalBadge, LinkButton } from "../components";
import { classify, rankPosition, tierSymbol } from "../domain";
import type { School } from "../types";
import { VoyageScene } from "../VoyageScene";
import voyagerTop from "../assets/voyager-top.png";
import { RowingVoyage } from "../RowingVoyage";
export function StarMap({
  schools,
  small = false,
  onSelect,
  fullscreen = false,
  selectedSchoolId,
  dockedSchoolId,
  sailingTo,
  onArrive,
}: {
  schools: School[];
  small?: boolean;
  onSelect?: (s: School) => void;
  fullscreen?: boolean;
  selectedSchoolId?: string;
  dockedSchoolId?: string | null;
  sailingTo?: School | null;
  onArrive?: () => void;
}) {
  const { data, navigate } = useApp();
  const [zoom, setZoom] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );
  function pointerLight(x: number, y: number) {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      root.current
        ?.querySelectorAll<HTMLElement>(".star-node")
        .forEach((node) => {
          const star = node
            .querySelector(".star-glow")
            ?.getBoundingClientRect();
          if (star)
            node.style.setProperty(
              "--proximity",
              String(
                Math.max(
                  0,
                  1 -
                    Math.hypot(
                      x - star.left - star.width / 2,
                      y - star.top - star.height / 2,
                    ) /
                      165,
                ),
              ),
            );
        });
    });
  }
  const rank = data.profile?.rank ?? (isMock ? 23500 : 0);
  const docked = data.schools.find((s) => s.id === dockedSchoolId);
  const ranks = data.schools.map((s) => s.rank);
  const boatPosition = {
    x: docked || rank ? rankPosition(docked?.rank ?? rank, ranks) : 50,
    y: docked?.y ?? 82,
  };
  return (
    <div
      ref={root}
      className={`star-map ${small ? "small" : ""} ${fullscreen ? "fullscreen" : ""}`}
      onPointerMove={(e) => {
        if (e.pointerType !== "touch") pointerLight(e.clientX, e.clientY);
      }}
      onPointerLeave={() => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        root.current
          ?.querySelectorAll<HTMLElement>(".star-node")
          .forEach((n) => n.style.setProperty("--proximity", "0"));
      }}
    >
      <div className="map-top">
        <span>
          <span className="live-dot" /> 你的院校探索图
        </span>
        <span>
          {data.profile?.province || "未设省份"} ·{" "}
          {data.profile?.subjects.map((s) => s[0]).join("") || "选科待补充"} ·
          {isMock ? "示例分布" : "历史资料分布"}
        </span>
      </div>
      <div className="map-body">
        <div className="map-stars" />
        <svg
          viewBox="0 0 900 340"
          preserveAspectRatio="none"
          className="map-lines"
          aria-hidden="true"
        >
          <path d="M20 270 Q220 10 510 180 T910 40" />
          <path d="M40 300 Q330 90 900 280" />
          <path d="M0 120 Q400 350 870 20" />
        </svg>
        <div
          className="map-nodes"
          inert={!!sailingTo}
          style={{ transform: `scale(${zoom})` }}
        >
          {sailingTo && (
            <RowingVoyage
              from={boatPosition}
              to={{ x: rankPosition(sailingTo.rank, ranks), y: sailingTo.y }}
              onArrive={() => onArrive?.()}
            />
          )}
          <button
            className={`voyager-position ${sailingTo ? "vessel-departed" : ""}`}
            style={{
              left: `${boatPosition.x}%`,
              top: `${boatPosition.y}%`,
            }}
            onClick={() => navigate("/profile")}
            aria-label={`你的船，${docked ? `停靠${docked.name}` : rank ? `省内位次${rank.toLocaleString()}` : "尚未填写位次"}；点击修改考生档案`}
          >
            <span className="boat-ripple" aria-hidden="true" />
            <img src={voyagerTop} alt="俯视下坐在船上、手持星图的航海者" />
            <span className="position-label">
              {docked ? "已停靠" : "你的位置"}{" "}
              <b>
                {docked?.name ?? (rank ? rank.toLocaleString() : "待填写位次")}
              </b>
            </span>
          </button>
          {schools.map((s) => (
            <button
              className={`star-node ${isMock ? classify(rank, s.rank) : "unknown"} ${selectedSchoolId === s.id ? "selected" : ""}`}
              data-school-id={s.id}
              style={{
                left: `${rankPosition(
                  s.rank,
                  data.schools.map((x) => x.rank),
                )}%`,
                top: `${s.y}%`,
              }}
              key={s.id}
              onClick={() =>
                onSelect ? onSelect(s) : navigate("/school/" + s.id)
              }
              aria-label={`查看${s.name}，${isMock ? "示例" : "历史"}位次${s.rank}`}
              aria-pressed={onSelect ? selectedSchoolId === s.id : undefined}
            >
              <span className="star-glow">
                <span />
              </span>
              <span className="star-name">
                <span className="map-tier" aria-hidden="true">
                  {tierSymbol[isMock ? classify(rank, s.rank) : "unknown"]}
                </span>{" "}
                {s.name}
                <small>
                  {s.city} · {s.rank.toLocaleString()}
                </small>
              </span>
            </button>
          ))}
        </div>
        <div className="map-axis">
          {isMock ? (
            <>
              ← 相对稳妥 <span>示例历史录取位次</span> 更有挑战 →
            </>
          ) : (
            <span>历史位次参考，须核对专业与统计口径</span>
          )}
        </div>
      </div>
      <div className="map-bottom">
        <div className="legend">
          {isMock ? (
            <>
              <span className="safe">■ 保底探索</span>
              <span className="match">● 稳妥选择</span>
              <span className="reach">▲ 勇敢一试</span>
            </>
          ) : (
            <span>◇ 条件与历史可比性待核对</span>
          )}
        </div>
        {!small && (
          <div className="zoom">
            <button
              aria-label="缩小星图"
              disabled={!!sailingTo}
              onClick={() => setZoom((z) => Math.max(0.8, z - 0.1))}
            >
              <Minus size={15} />
            </button>
            <button
              aria-label="重置星图"
              disabled={!!sailingTo}
              onClick={() => setZoom(1)}
            >
              <LocateFixed size={15} />
            </button>
            <button
              aria-label="放大星图"
              disabled={!!sailingTo}
              onClick={() => setZoom((z) => Math.min(1.35, z + 0.1))}
            >
              <Plus size={15} />
            </button>
          </div>
        )}
        {small && (
          <button className="text-button" onClick={() => navigate("/explore")}>
            展开星图
            <ArrowUpRight size={14} />
          </button>
        )}
      </div>
    </div>
  );
}
export function Home({ openChat }: { openChat: () => void }) {
  const { data, navigate } = useApp();
  const [question, setQuestion] = useState("");
  function ask(text: string) {
    sessionStorage.setItem("nv-question", text);
    openChat();
  }
  return (
    <div className="home">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">
            <span className="gold-line" /> YOUR NEXT CHAPTER STARTS HERE
          </span>
          <h1>
            前方有很多可能，
            <br />
            找到<span>属于你的那一站。</span>
          </h1>
          <p>
            让官方数据指引方向，让真实经历照亮选择。
            <br />
            从你的分数、热爱和期待出发，一起看见更远的未来。
          </p>
          <form
            className="hero-prompt"
            onSubmit={(e) => {
              e.preventDefault();
              if (question.trim()) ask(question);
            }}
          >
            <Sparkles size={20} />
            <input
              aria-label="向领航员提问"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="告诉我你的分数，和想去的远方…"
            />
            <button type="submit" aria-label="发送问题">
              <ArrowRight size={19} />
            </button>
          </form>
          <div className="prompt-suggestions">
            <span>试着问问</span>
            {["628 分，想在江浙沪读计算机", "帮我看看适合的大学"].map((t) => (
              <button key={t} onClick={() => ask(t)}>
                {t}
                <ArrowUpRight size={11} />
              </button>
            ))}
          </div>
        </div>
        <VoyageScene />
      </section>
      <div className="trust-strip">
        <div>
          <FileCheck2 size={18} />
          <span>
            官方数据<small>每个数字，都有出处</small>
          </span>
        </div>
        <div>
          <MessagesSquare size={18} />
          <span>
            真实回声<small>听见学长学姐的亲历</small>
          </span>
        </div>
        <div>
          <Navigation size={18} />
          <span>
            有据推荐<small>每条建议，都说得清</small>
          </span>
        </div>
        <span className="strip-note">数据 · 体验 · 判断，清晰区分</span>
      </div>
      <div className="home-columns">
        <section className="explore-preview">
          <SectionTitle
            eyebrow="A SKY FULL OF POSSIBILITIES"
            title="你的未来，不止一种可能"
          >
            <LinkButton onClick={() => navigate("/explore")}>
              探索全部院校
            </LinkButton>
          </SectionTitle>
          <StarMap schools={data.schools} small />
        </section>
        <section className="profile-snapshot">
          <div className="snapshot-top">
            <span className="eyebrow">MY VOYAGE</span>
            <span>✧</span>
          </div>
          <h2>
            先认识你，
            <br />
            再一起看世界。
          </h2>
          <p>每一条航线，都从你的坐标开始。</p>
          {data.profile ? (
            <>
              <div className="score-row">
                <div>
                  <strong>{data.profile.score}</strong>
                  <small>高考分数</small>
                </div>
                <span />
                <div>
                  <strong>{data.profile.rank.toLocaleString()}</strong>
                  <small>全省位次</small>
                </div>
              </div>
              <div className="profile-chips">
                <span>
                  <MapPin size={12} />
                  {data.profile.province} · {data.profile.year}
                </span>
                <span>{data.profile.subjects.join(" / ")}</span>
              </div>
              <button
                className="button gold-button"
                onClick={() => navigate("/routes")}
              >
                看看我的推荐航线
                <ArrowRight size={16} />
              </button>
              <button
                className="text-button"
                onClick={() => navigate("/profile")}
              >
                调整我的考生档案
                <ChevronRight size={13} />
              </button>
            </>
          ) : (
            <button
              className="button gold-button"
              onClick={() => navigate("/profile")}
            >
              建立我的档案
              <ArrowRight size={15} />
            </button>
          )}
        </section>
      </div>
      <section className="echo-preview">
        <SectionTitle
          eyebrow="LETTERS FROM SOMEONE WHO’S BEEN THERE"
          title="有些答案，藏在真实的校园里"
        >
          <LinkButton onClick={() => navigate("/explore")}>
            选一所院校，听听回声
          </LinkButton>
        </SectionTitle>
        <div className="letter-grid">
          {data.posts
            .filter((p) => p.status === "published" && p.signal === "strong")
            .slice(0, 3)
            .map((p, i) => (
              <button
                className={`letter letter-${i}`}
                key={p.id}
                onClick={() => navigate("/post/" + p.id)}
              >
                <div className="letter-top">
                  <span>
                    {data.schools.find((s) => s.id === p.schoolId)?.name}
                  </span>
                  <span className="postmark">
                    校园来信
                    <br />
                    {p.year} · VOICE
                  </span>
                </div>
                <span className="letter-topic">{p.topic}</span>
                <h3>{p.title}</h3>
                <p>{p.excerpt}</p>
                <div className="letter-bottom">
                  <span>{p.author}</span>
                  <SignalBadge signal={p.signal} />
                </div>
              </button>
            ))}
        </div>
      </section>
      <div className="home-invitation">
        <span>✧</span>
        <div>
          <h3>走过这段路的你，也可以成为一束光。</h3>
          <p>加入灯塔计划，把真实的校园经历，寄给还在选择的他们。</p>
        </div>
        <button className="text-button" onClick={() => navigate("/lighthouse")}>
          写下我的回声
          <ArrowUpRight size={17} />
        </button>
      </div>
    </div>
  );
}
