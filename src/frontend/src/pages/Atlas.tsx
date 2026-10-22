import { useEffect, useState, useRef } from "react";
import {
  SlidersHorizontal,
  Search,
  LayoutGrid,
  List,
  X,
  ArrowRight,
  Anchor,
} from "lucide-react";
import { useApp } from "../store";
import { StarMap } from "./Explore";
import { SchoolCard, Empty } from "../components";
import type { School } from "../types";
import { isMock } from "../api";
import { atlasContext } from "../navigator-state";
import { useAtlasResults } from "../atlas-results";

export function Explore() {
  const { data, navigator, navigate } = useApp();
  const profile = navigator.profile || data.profile;
  const preferenceKey = JSON.stringify(profile);
  const [dockedSchoolId, setDockedSchoolId] = useState<string | null>(() =>
    sessionStorage.getItem("nv-atlas-dock"),
  );
  const [sailingTo, setSailingTo] = useState<School | null>(null);
  const journeyDone = useRef(false);
  const [filters, setFilters] = useState(false),
    [view, setView] = useState<"map" | "list">("map");
  const [query, setQuery] = useState(""),
    [city, setCity] = useState(profile?.cities.join("、") || ""),
    [major, setMajor] = useState(profile?.interests.join("、") || "");
  const [applied, setApplied] = useState({ query: "", city, major });
  useEffect(() => {
    const city = profile?.cities.join("、") || "",
      major = profile?.interests.join("、") || "";
    setCity(city);
    setMajor(major);
    setQuery("");
    setApplied({ query: "", city, major });
  }, [preferenceKey]);
  const context = atlasContext(
    profile,
    applied.city,
    applied.major,
    applied.query,
  );
  const contextKey = JSON.stringify(context);
  const result = useAtlasResults(context);
  const schools = result.value?.items || [];
  const loading = result.loading,
    error = result.error;
  const [selected, setSelected] = useState<School | null>(null);
  function arrive() {
    if (!sailingTo || journeyDone.current) return;
    journeyDone.current = true;
    sessionStorage.setItem("nv-atlas-dock", sailingTo.id);
    localStorage.setItem("nv-echo-school", sailingTo.id);
    setDockedSchoolId(sailingTo.id);
    navigate("/echoes/" + encodeURIComponent(sailingTo.id));
  }
  function depart(school: School) {
    if (sailingTo) return;
    journeyDone.current = false;
    setFilters(false);
    setSailingTo(school);
  }
  useEffect(() => {
    setSelected(null);
  }, [contextKey, view]);
  function reset() {
    const city = profile?.cities.join("、") || "",
      major = profile?.interests.join("、") || "";
    setQuery("");
    setCity(city);
    setMajor(major);
    setApplied({ query: "", city, major });
  }
  return (
    <section
      className={`atlas-shell ${view === "list" ? "atlas-list-mode" : ""}`}
      aria-label="全屏院校星图"
    >
      <header className="atlas-heading">
        <span className="eyebrow">YOUR CONSTELLATION</span>
        <h1>院校星图</h1>
        <p>
          每一颗星，都是一种可能。<span> 靠近星光，看看属于你的方向。</span>
        </p>
      </header>
      <button
        className={`atlas-filter-toggle ${filters ? "active" : ""}`}
        aria-expanded={filters}
        aria-controls="atlas-filters"
        disabled={!!sailingTo}
        onClick={() => setFilters(!filters)}
      >
        <SlidersHorizontal size={16} />
        <span>筛选与列表</span>
        <small>{schools.length} 所</small>
      </button>
      {filters && (
        <section
          id="atlas-filters"
          className="atlas-filters"
          aria-label="院校筛选"
        >
          <div className="atlas-filter-heading">
            <h2>找到你在意的坐标</h2>
            <button
              className="icon-button"
              aria-label="收起院校筛选"
              onClick={() => setFilters(false)}
            >
              <X size={17} />
            </button>
          </div>
          <label className="search">
            <Search size={16} />
            <input
              aria-label="搜索院校或专业"
              placeholder="搜索院校、城市或专业"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <div className="atlas-filter-row">
            <label>
              城市或省份
              <input
                aria-label="按城市筛选"
                placeholder="如 杭州、南京"
                value={city}
                onChange={(e) => setCity(e.target.value)}
              />
            </label>
            <label>
              专业方向
              <input
                aria-label="按专业筛选"
                placeholder="如 计算机、临床医学"
                value={major}
                onChange={(e) => setMajor(e.target.value)}
              />
            </label>
          </div>
          <p>
            当前依据：{context.province} · {context.rank.toLocaleString()} 名
            {!profile?.rank
              ? "（默认参考位次，可在领航员中补充）"
              : "（来自领航员）"}
          </p>
          <button
            className="button gold-button"
            disabled={loading}
            onClick={() => {
              setApplied({ query, city, major });
              setSelected(null);
            }}
          >
            {loading ? "正在查找院校…" : "应用筛选"}
          </button>
          <div className="atlas-filter-row">
            <div className="segmented">
              <button
                className={view === "map" ? "active" : ""}
                onClick={() => {
                  setView("map");
                  setFilters(false);
                }}
              >
                <LayoutGrid size={15} />
                星图
              </button>
              <button
                className={view === "list" ? "active" : ""}
                onClick={() => {
                  setView("list");
                  setFilters(false);
                }}
              >
                <List size={15} />
                列表
              </button>
            </div>
            <button className="text-button" onClick={reset}>
              恢复对话条件
            </button>
          </div>
          <p>
            {result.value?.note ||
              "按历史位次距离排序；未知数据会明确标注，录取条件以官方发布为准。"}
          </p>
        </section>
      )}
      {view === "map" ? (
        <StarMap
          schools={schools}
          fullscreen
          onSelect={setSelected}
          selectedSchoolId={selected?.id}
          dockedSchoolId={dockedSchoolId}
          sailingTo={sailingTo}
          onArrive={arrive}
        />
      ) : (
        <div className="atlas-list-scroll">
          <div className="school-grid">
            {schools.map((s) => (
              <SchoolCard school={s} key={s.id} />
            ))}
          </div>
        </div>
      )}
      {!schools.length && !loading && !error && (
        <div className="atlas-empty">
          <Empty
            text={
              result.value?.note ||
              "没有取得符合条件的可引用资料，试着放宽城市或专业。"
            }
            action="重置筛选"
            onAction={reset}
          />
        </div>
      )}
      {(loading || error) && (
        <div className="atlas-load-more" role="status">
          {loading ? (
            <span>正在查找位次附近的院校与官方资料…</span>
          ) : (
            <>
              <span>{error}</span>
              <button className="button" onClick={result.retry}>
                重试
              </button>
            </>
          )}
        </div>
      )}
      {selected && view === "map" && !sailingTo && (
        <aside
          className="atlas-selection"
          aria-label={`${selected.name}简要档案`}
        >
          <button
            className="selection-close icon-button"
            aria-label="关闭院校简要档案"
            onClick={() => setSelected(null)}
          >
            <X size={16} />
          </button>
          <SchoolCard school={selected} />
          <div className="atlas-echo-entry">
            <p>听听在这里生活的人的声音</p>
            <button
              className="button gold-button"
              onClick={() => depart(selected)}
              aria-label={`划船前往${selected.name}的回声广场`}
            >
              前往回声广场 <ArrowRight size={17} />
            </button>
          </div>
        </aside>
      )}
      {sailingTo && (
        <div className="sailing-status" role="status">
          <Anchor size={18} />
          <div>
            <strong>正在划向{sailingTo.name}</strong>
            <small>下一站 · 回声广场</small>
          </div>
          <button className="text-button" onClick={arrive}>
            跳过动画 <ArrowRight size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="取消本次航行"
            onClick={() => setSailingTo(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <span className="atlas-disclaimer">
        {context.province} · 参考位次 {context.rank.toLocaleString()} ·{" "}
        {isMock ? "示例" : "历史参考，非录取概率"} · 以当年官方发布为准
      </span>
    </section>
  );
}
