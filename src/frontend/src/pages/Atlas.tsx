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
import { api, isMock } from "../api";
import { errorText } from "../transport";

export function Explore() {
  const { data, navigate } = useApp();
  const [dockedSchoolId, setDockedSchoolId] = useState<string | null>(() =>
    sessionStorage.getItem("nv-atlas-dock"),
  );
  const [sailingTo, setSailingTo] = useState<School | null>(null);
  const journeyDone = useRef(false);
  const [filters, setFilters] = useState(false),
    [view, setView] = useState<"map" | "list">("map");
  const [query, setQuery] = useState(""),
    [city, setCity] = useState("全部城市"),
    [major, setMajor] = useState("全部专业");
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
  const [remoteSchools, setRemoteSchools] = useState<School[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (isMock) return;
    let active = true;
    setRemoteSchools([]);
    setCursor(null);
    setLoading(true);
    setError("");
    const timer = setTimeout(
      () =>
        api
          .schools(
            query,
            null,
            city === "全部城市" ? "" : city,
            major === "全部专业" ? "" : major,
          )
          .then((page) => {
            if (active) {
              setRemoteSchools(page.items);
              setCursor(page.nextCursor);
            }
          })
          .catch((e) => {
            if (active) setError(errorText(e));
          })
          .finally(() => {
            if (active) setLoading(false);
          }),
      200,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, city, major]);
  const schools = isMock
    ? data.schools.filter(
        (s) =>
          (s.name + s.city + s.majors.join("")).includes(query) &&
          (city === "全部城市" || s.city === city) &&
          (major === "全部专业" || s.majors.includes(major)),
      )
    : remoteSchools;
  useEffect(() => {
    setSelected(null);
  }, [query, city, major, view]);
  function reset() {
    setQuery("");
    setCity("全部城市");
    setMajor("全部专业");
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
            <select
              aria-label="按城市筛选"
              value={city}
              onChange={(e) => setCity(e.target.value)}
            >
              {["全部城市", ...new Set(data.schools.map((s) => s.city))].map(
                (c) => (
                  <option key={c}>{c}</option>
                ),
              )}
            </select>
            <select
              aria-label="按专业筛选"
              value={major}
              onChange={(e) => setMajor(e.target.value)}
            >
              {[
                "全部专业",
                ...new Set(data.schools.flatMap((s) => s.majors)),
              ].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
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
              重置筛选
            </button>
          </div>
          <p>示例数据，仅供探索；最终请核对官方招生信息。</p>
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
            text="没有符合条件的院校，试着放宽筛选。"
            action="重置筛选"
            onAction={reset}
          />
        </div>
      )}
      {(loading || error || cursor) && (
        <div className="atlas-load-more" role="status">
          {loading ? (
            <span>正在读取院校…</span>
          ) : error ? (
            <span>{error}</span>
          ) : (
            <button
              className="button"
              onClick={async () => {
                setLoading(true);
                try {
                  const page = await api.schools(
                    query,
                    cursor,
                    city === "全部城市" ? "" : city,
                    major === "全部专业" ? "" : major,
                  );
                  setRemoteSchools((rows) => [
                    ...rows,
                    ...page.items.filter(
                      (s) => !rows.some((r) => r.id === s.id),
                    ),
                  ]);
                  setCursor(page.nextCursor);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setLoading(false);
                }
              }}
            >
              加载更多院校（当前{schools.length}所）
            </button>
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
        {isMock ? "示例位次与布局" : "当前仅显示已加载院校；布局不代表录取风险"}{" "}
        · 以当年官方发布为准
      </span>
    </section>
  );
}
