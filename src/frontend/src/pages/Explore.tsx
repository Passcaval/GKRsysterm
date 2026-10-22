import { useState, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  LocateFixed,
  Plus,
  Minus,
  Sparkles,
  FileCheck2,
  MessagesSquare,
  Navigation,
} from "lucide-react";
import { isMock } from "../api";
import { api } from "../api";
import { useApp } from "../store";
import { SectionTitle, SignalBadge, LinkButton } from "../components";
import { classify } from "../domain";
import { layoutAtlas } from "../atlas-layout";
import type { School } from "../types";
import { VoyageScene } from "../VoyageScene";
import voyagerTop from "../assets/voyager-top.png";
import { atlasContext } from "../navigator-state";
import { useAtlasResults } from "../atlas-results";
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
  const { data, navigator, navigate } = useApp();
  const uniqueSchools = useMemo(
    () => [...new Map(schools.map((s) => [s.id, s])).values()],
    [schools],
  );
  const [zoom, setZoom] = useState(1);
  const [dockedInfo, setDockedInfo] = useState<School | null>(null);
  useEffect(() => {
    let active = true;
    if (dockedSchoolId)
      api
        .school(dockedSchoolId)
        .then((s) => {
          if (active) setDockedInfo(s);
        })
        .catch(() => {
          if (active) setDockedInfo(null);
        });
    else setDockedInfo(null);
    return () => {
      active = false;
    };
  }, [dockedSchoolId]);
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 340 });
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const measure = () => {
      setSize({ width: node.clientWidth, height: node.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
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
  const rank = navigator.profile?.rank ?? data.profile?.rank ?? 8000;
  const mapTier = (s: School) =>
    isMock ? classify(rank, s.rank) : s.historicalRisk || "unknown";
  const docked =
    dockedInfo ||
    uniqueSchools.find((s) => s.id === dockedSchoolId) ||
    data.schools.find((s) => s.id === dockedSchoolId);
  const layout = useMemo(
    () =>
      layoutAtlas(
        [...uniqueSchools, ...(docked ? [docked] : [])],
        size.width,
        size.height,
        !docked,
      ),
    [uniqueSchools, docked, size.width, size.height],
  );
  const firstSchoolId = uniqueSchools[0]?.id;
  useEffect(() => {
    viewport.current?.scrollTo(0, 0);
  }, [firstSchoolId]);
  const percent = (point: { x: number; y: number }) => ({
    x: (point.x / layout.width) * 100,
    y: (point.y / layout.height) * 100,
  });
  const boatPosition = percent(
    (docked && layout.positions.get(docked.id)) || layout.boat,
  );
  const dockVisible = uniqueSchools.some((s) => s.id === docked?.id);
  const sailingPosition = sailingTo && layout.positions.get(sailingTo.id);
  function locateBoat() {
    const point = (docked && layout.positions.get(docked.id)) || layout.boat;
    viewport.current?.scrollTo({
      left: point.x * zoom - size.width / 2,
      top: point.y * zoom - size.height / 2,
      behavior: "smooth",
    });
  }
  useEffect(() => {
    if (!sailingTo) return;
    setZoom(1);
  }, [sailingTo]);
  const mapSize = {
    width: layout.width * zoom,
    height: layout.height * zoom,
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
        <span>院校位置与层次 · {isMock ? "示例分布" : "探索布局"}</span>
      </div>
      <div
        className="map-body"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="院校星图，可滑动浏览，使用 Tab 选择院校"
      >
        <div className="map-canvas" style={mapSize}>
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
            style={{
              width: layout.width,
              height: layout.height,
              transform: `scale(${zoom})`,
            }}
          >
            {sailingTo && sailingPosition && (
              <RowingVoyage
                from={boatPosition}
                to={percent(sailingPosition)}
                onArrive={() => onArrive?.()}
              />
            )}
            {!dockVisible && !sailingTo && (
              <button
                className={`voyager-position ${sailingTo ? "vessel-departed" : ""}`}
                style={{
                  left: `${boatPosition.x}%`,
                  top: `${boatPosition.y}%`,
                }}
                onClick={() => window.dispatchEvent(new Event("nv-open-chat"))}
                aria-label={`你的船，${docked ? `停靠${docked.name}` : "从这里出发"}；点击和领航员聊聊`}
              >
                <span className="boat-ripple" aria-hidden="true" />
                <img src={voyagerTop} alt="俯视下坐在船上、手持星图的航海者" />
                <span className="position-label">
                  {docked ? "已停靠" : "你的位置"}{" "}
                  <b>{docked?.name ?? "从这里出发"}</b>
                </span>
              </button>
            )}
            {uniqueSchools.map((s) => (
              <button
                className={`star-node ${mapTier(s)} ${selectedSchoolId === s.id ? "selected" : ""}`}
                data-school-id={s.id}
                style={{
                  left: layout.positions.get(s.id)?.x,
                  top: layout.positions.get(s.id)?.y,
                  width: layout.nodeWidth,
                }}
                key={s.id}
                onClick={() =>
                  onSelect ? onSelect(s) : navigate("/school/" + s.id)
                }
                aria-label={`查看${s.name}，${isMock ? "示例" : "历史"}位次${s.rank ?? "待确认"}`}
                aria-pressed={onSelect ? selectedSchoolId === s.id : undefined}
                title={s.name}
              >
                <span
                  className={`star-glow ${docked?.id === s.id ? "docked-star" : ""}`}
                >
                  {docked?.id === s.id && !sailingTo ? (
                    <img src={voyagerTop} alt="我的船停靠在这里" />
                  ) : (
                    <span />
                  )}
                </span>
                <span className="star-name">
                  <span className="star-title">{s.name}</span>
                  <small>
                    {docked?.id === s.id ? "已停靠 · " : ""}
                    {s.city} · {s.rank?.toLocaleString() ?? "待确认"}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="map-bottom">
        {isMock ? (
          <div className="legend">
            <span className="safe">■ 保底探索</span>
            <span className="match">● 稳妥选择</span>
            <span className="reach">▲ 勇敢一试</span>
          </div>
        ) : (
          <span className="map-browse-note">布局仅用于浏览</span>
        )}
        {layout.height * zoom > size.height + 1 && (
          <span className="map-scroll-hint">上下滑动，探索更多院校</span>
        )}
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
              aria-label="定位到我的船"
              disabled={!!sailingTo}
              onClick={locateBoat}
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
  const { data, navigator, navigate } = useApp();
  const atlas = useAtlasResults(
    atlasContext(navigator.profile || data.profile),
  );
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
          <StarMap schools={atlas.value?.items || []} small />
          <p className="muted" role="status">
            {atlas.loading
              ? "正在展开位次附近的院校…"
              : atlas.error || atlas.value?.note}
          </p>
        </section>
        <section className="profile-snapshot">
          <div className="snapshot-top">
            <span className="eyebrow">ONE CONVERSATION</span>
            <span>✧</span>
          </div>
          <h2>
            不用填表，
            <br />
            边聊边整理。
          </h2>
          <p>
            把你的省份、位次、选考和想法直接说给领航员。对话里明确的信息会自动记下，用来调整星图和推荐。
          </p>
          <button
            className="button gold-button"
            onClick={() => ask("我想先看看适合我的方向")}
          >
            继续和领航员聊
            <ArrowRight size={16} />
          </button>
          <p className="muted">没有标准答案，先从一句话开始。</p>
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
