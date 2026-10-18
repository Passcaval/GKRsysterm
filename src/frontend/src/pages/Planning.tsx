import { useEffect, useState } from "react";
import {
  ArrowRight,
  ArrowUp,
  ArrowDown,
  Plus,
  X,
  Download,
  Printer,
  AlertTriangle,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { useApp } from "../store";
import { api, isMock } from "../api";
import { classify, moveEntry, tierLabel, tierSymbol } from "../domain";
import {
  PageTitle,
  SectionTitle,
  SchoolCard,
  TierBadge,
  Modal,
  Evidence,
  Empty,
} from "../components";
import type { PlanEntry, Recommendation, Simulation, Tier } from "../types";
function Routes() {
  const { data, navigate, notify } = useApp();
  const [risk, setRisk] = useState(50);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<string[] | null>(null);
  const [why, setWhy] = useState("");
  const [explanation, setExplanation] = useState("");
  useEffect(() => {
    let active = true;
    setBusy(true);
    const t = setTimeout(() => {
      api
        .recommendations(risk)
        .then((v) => {
          if (active) {
            setRecommendations(v);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setBusy(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, [risk, data.profile]);
  return (
    <>
      <PageTitle
        eyebrow="A ROUTE WITH REASONS"
        title="每一条航线，都通向可能"
        description="冲一冲，稳一稳，也为自己留一个安心的港口。所有推荐都应该说得清依据。"
      />
      <div className="risk-control panel">
        <div>
          <h3>你的选择节奏</h3>
          <p>调整偏好，重新探索适合你的选择。</p>
        </div>
        <label>
          <span>更稳妥</span>
          <input
            type="range"
            aria-label="风险偏好"
            min="0"
            max="100"
            value={risk}
            onChange={(e) => setRisk(Number(e.target.value))}
          />
          <span>更有挑战</span>
          <output>{risk}</output>
        </label>
      </div>
      {busy && (
        <p role="status" className="muted">
          正在更新推荐航线…
        </p>
      )}
      {error ? (
        <Empty
          text={error}
          action="完善考生档案"
          onAction={() => navigate("/profile")}
        />
      ) : recommendations.length === 0 && !busy ? (
        <Empty text="当前没有可展示的候选，请核对数据覆盖范围、报考条件与官方资料。" />
      ) : null}
      {!error &&
        (
          (isMock
            ? ["reach", "match", "safe"]
            : ["unknown", "reach", "match", "safe"]) as Tier[]
        ).map((t) => (
          <section className={`route-lane ${t}`} key={t}>
            <div className="route-lane-title">
              <span>{tierSymbol[t]}</span>
              <div>
                <h2>
                  {tierLabel[t]}
                  {t === "unknown"
                    ? " · 补充依据后再判断"
                    : t === "reach"
                      ? " · 向热爱靠近"
                      : t === "match"
                        ? " · 与期待相逢"
                        : " · 给未来一份安心"}
                </h2>
                <p>
                  {t === "unknown"
                    ? "条件或历史可比性尚待确认，不能视为已满足报考要求"
                    : t === "reach"
                      ? "存在较大位次挑战，谨慎评估"
                      : t === "match"
                        ? "参考历史位次，继续核验当年计划"
                        : "仍有政策与计划变化风险"}
                </p>
              </div>
              <span className="muted">
                {recommendations.filter((r) => r.tier === t).length} 个选择
              </span>
            </div>
            <div className="school-grid">
              {recommendations
                .filter((r) => r.tier === t)
                .map((r) => {
                  const s = data.schools.find((s) => s.id === r.schoolId);
                  return s ? (
                    <div className="recommendation" key={s.id + ":" + r.major}>
                      <SchoolCard school={s} compact tier={r.tier} />
                      <div className="recommendation-reasons">
                        <span className="source-tag inference">
                          {r.matchScore === null
                            ? "偏好匹配度待补充"
                            : `偏好匹配度 ${r.matchScore}/100`}{" "}
                          · 非录取概率
                        </span>
                        <p>{r.reasons.join("；")}</p>
                        {r.postIds.length > 0 && (
                          <button
                            className="text-button"
                            onClick={() => navigate("/post/" + r.postIds[0])}
                          >
                            参考 {r.postIds.length} 篇强信号回声
                            <ArrowRight size={12} />
                          </button>
                        )}
                        <button
                          className="text-button"
                          onClick={() => setEvidence(r.sourceIds)}
                        >
                          查看推荐依据
                          <ArrowRight size={13} />
                        </button>
                        <details>
                          <summary>风险与适用范围</summary>
                          {r.warnings.map((w) => (
                            <p key={w}>{w}</p>
                          ))}
                        </details>
                      </div>
                    </div>
                  ) : null;
                })}
            </div>
            {!recommendations.some((r) => r.tier === t) && !busy && (
              <p className="muted">当前偏好下暂无此层次推荐。</p>
            )}
          </section>
        ))}
      <div className="panel explain-panel">
        <h3>为什么没有推荐我心里的那所学校？</h3>
        <p className="muted">把限制条件讲清楚，也是推荐的一部分。</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const v = await api.explanation(why);
              setExplanation(v.text);
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        >
          <select
            required
            aria-label="选择要解释的院校"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
          >
            <option value="">选择院校</option>
            {data.schools.map((s) => (
              <option value={s.id} key={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button className="button">
            查看原因
            <ArrowRight size={15} />
          </button>
        </form>
        {explanation && <p className="explanation">{explanation}</p>}
      </div>
      {evidence && (
        <Modal
          title="推荐依据 · 数据与推断分别标注"
          onClose={() => setEvidence(null)}
        >
          <Evidence ids={evidence} />
        </Modal>
      )}
    </>
  );
}
function Compare() {
  const { data, navigate, notify } = useApp();
  const [ids, setIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("nv-compare") || "[]")
        .filter((id: string) => data.schools.some((s) => s.id === id))
        .slice(0, 4);
    } catch {
      return [];
    }
  });
  const [add, setAdd] = useState("");
  useEffect(() => {
    localStorage.setItem("nv-compare", JSON.stringify(ids));
  }, [ids]);
  const schools = ids.map((id) => data.schools.find((s) => s.id === id)!);
  return (
    <>
      <PageTitle
        eyebrow="SIDE BY SIDE, CLEARER CHOICES"
        title="把在意的，放在一起看"
        description="最多并排对比 4 所院校。数据、体验和推断，各自保留边界。"
      />
      <div className="toolbar">
        <select
          aria-label="选择对比院校"
          value={add}
          onChange={(e) => setAdd(e.target.value)}
        >
          <option value="">选择要加入的院校</option>
          {data.schools
            .filter((s) => !ids.includes(s.id))
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <button
          className="button"
          disabled={!add || ids.length === 4}
          onClick={() => {
            if (ids.length === 4) {
              notify("最多对比四所");
              return;
            }
            setIds([...ids, add]);
            setAdd("");
          }}
        >
          <Plus size={15} />
          加入对比
        </button>
        <span className="muted">{ids.length} / 4 个舱位</span>
      </div>
      {!ids.length ? (
        <Empty text="先选择你在意的院校，逐项看清差异。" />
      ) : (
        <div className="table-wrap compare-table panel">
          <table>
            <thead>
              <tr>
                <th>你关心的维度</th>
                {schools.map((s) => (
                  <th key={s.id}>
                    <button
                      className="text-button"
                      onClick={() => navigate("/school/" + s.id)}
                    >
                      {s.name}
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`移除${s.name}`}
                      onClick={() => setIds(ids.filter((id) => id !== s.id))}
                    >
                      <X size={14} />
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["城市", ...schools.map((s) => s.city)],
                ["院校层次", ...schools.map((s) => s.level)],
                [
                  "2025示例位次",
                  ...schools.map((s) => s.rank.toLocaleString()),
                ],
                [
                  "学费 / 年",
                  ...schools.map((s) => `¥ ${s.tuition.toLocaleString()}`),
                ],
                [
                  "示例选科",
                  ...schools.map((s) => s.requiredSubjects.join(" + ")),
                ],
                ["可探索专业", ...schools.map((s) => s.majors.join(" / "))],
                [
                  "强信号回声",
                  ...schools.map(
                    (s) =>
                      `${data.posts.filter((p) => p.schoolId === s.id && p.signal === "strong" && p.status === "published").length} 篇`,
                  ),
                ],
              ].map((row, i) => (
                <tr
                  className={new Set(row.slice(1)).size > 1 ? "different" : ""}
                  key={i}
                >
                  {row.map((cell, j) =>
                    j === 0 ? (
                      <th scope="row" key={j}>
                        {cell}
                      </th>
                    ) : (
                      <td key={j}>{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="notice">
        <ShieldCheck size={20} />
        <p>
          高亮行表示各校存在差异。位次与学费属于数据层，回声属于体验层；目前均为演示内容，请结合最新官方信息作判断。
        </p>
      </div>
    </>
  );
}
function Workbench() {
  const { data, update, notify, navigate } = useApp();
  const [simulation, setSimulation] = useState<Simulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const [error, setError] = useState("");
  async function save(entries: PlanEntry[]) {
    setBusy(true);
    setSimulation(null);
    try {
      update({ plan: await api.plan({ ...data.plan, entries }) });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function csv() {
    const lines = [
      ["序号", "院校", "专业", "服从调剂", "说明"],
      ...data.plan.entries.map((e, i) => [
        i + 1,
        data.schools.find((s) => s.id === e.schoolId)?.name,
        e.major,
        e.adjustment ? "是" : "否",
        "演示草案，非正式填报",
      ]),
    ];
    const text =
      "\uFEFF" +
      lines
        .map((row) =>
          row
            .map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"')
            .join(","),
        )
        .join("\r\n");
    const url = URL.createObjectURL(
      new Blob([text], { type: "text/csv;charset=utf-8;" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "夜航-志愿草案.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="workbench">
      <PageTitle
        eyebrow="TURN POSSIBILITIES INTO A PLAN"
        title="你的志愿，慢慢有了方向"
        description="按自己的期待编排顺序；用条件检查发现缺口，用证据做最后的核对。"
      >
        <span className="source-tag">草案版本 v{data.plan.version}</span>
      </PageTitle>
      <div className="toolbar no-print">
        <span className="muted">
          已编排 {data.plan.entries.length} 个志愿 · 演示上限 40
        </span>
        <div className="spacer" />
        <button
          className="button"
          disabled={!data.plan.entries.length}
          onClick={csv}
        >
          <Download size={15} />
          导出 CSV
        </button>
        <button
          className="button"
          disabled={!data.plan.entries.length}
          onClick={() => window.print()}
        >
          <Printer size={15} />
          打印 / 保存 PDF
        </button>
      </div>
      {error && (
        <div className="notice amber" role="alert">
          <p>{error}</p>
          <button className="text-button" onClick={() => location.reload()}>
            刷新方案
          </button>
        </div>
      )}
      <div className="workbench-grid">
        <section className="panel plan-list">
          <SectionTitle title="我的志愿草案">
            <button
              className="text-button no-print"
              onClick={() => navigate("/explore")}
            >
              <Plus size={14} />
              添加院校
            </button>
          </SectionTitle>
          <p className="muted no-print">
            拖动条目或用上下箭头调整顺序，修改后自动保存。
          </p>
          {data.plan.entries.map((e, i) => {
            const s = data.schools.find((s) => s.id === e.schoolId);
            return (
              <article
                className="plan-entry"
                key={e.id}
                draggable={!busy}
                onDragStart={() => setDrag(i)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (drag !== null && !busy)
                    void save(moveEntry(data.plan.entries, drag, i));
                  setDrag(null);
                }}
              >
                <span className="plan-order">
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="plan-info">
                  <h3>
                    {s?.name || "已失效院校"}{" "}
                    {s && (
                      <TierBadge
                        tier={
                          isMock
                            ? classify(data.profile?.rank || 23500, s.rank)
                            : "unknown"
                        }
                      />
                    )}
                  </h3>
                  <label>
                    <span className="sr-only">{s?.name}专业</span>
                    <select
                      disabled={busy}
                      value={e.major}
                      onChange={(event) =>
                        void save(
                          data.plan.entries.map((x) =>
                            x.id === e.id
                              ? { ...x, major: event.target.value }
                              : x,
                          ),
                        )
                      }
                    >
                      {s?.majors.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <label className="switch-label">
                    <input
                      disabled={busy}
                      type="checkbox"
                      checked={e.adjustment}
                      onChange={(event) =>
                        void save(
                          data.plan.entries.map((x) =>
                            x.id === e.id
                              ? { ...x, adjustment: event.target.checked }
                              : x,
                          ),
                        )
                      }
                    />
                    服从专业调剂
                  </label>
                </div>
                <div className="plan-controls no-print">
                  <button
                    disabled={busy || i === 0}
                    aria-label={`上移第${i + 1}个志愿`}
                    onClick={() =>
                      void save(moveEntry(data.plan.entries, i, i - 1))
                    }
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    disabled={busy || i === data.plan.entries.length - 1}
                    aria-label={`下移第${i + 1}个志愿`}
                    onClick={() =>
                      void save(moveEntry(data.plan.entries, i, i + 1))
                    }
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    disabled={busy}
                    aria-label={`移除第${i + 1}个志愿`}
                    onClick={() =>
                      void save(data.plan.entries.filter((x) => x.id !== e.id))
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
              </article>
            );
          })}
          {!data.plan.entries.length && (
            <Empty
              text="从一所心仪的学校开始，慢慢完成你的草案。"
              action="去探索院校"
              onAction={() => navigate("/explore")}
            />
          )}
          <p className="muted">
            {busy ? "正在保存…" : "本草案不提交至官方志愿填报系统。"}
          </p>
        </section>
        <aside className="panel simulation">
          <span className="eyebrow">CHECK BEFORE YOU DECIDE</span>
          <h2>再多一份确认</h2>
          <p>按选科与参考位次检查方案结构。没有校准模型时，不显示录取概率。</p>
          <button
            className="button gold-button no-print"
            disabled={busy || !data.plan.entries.length}
            onClick={async () => {
              setBusy(true);
              try {
                setSimulation(await api.simulate(data.plan));
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <ShieldCheck size={17} />
            {busy ? "正在检查…" : "检查当前方案"}
          </button>
          {simulation && (
            <div className="simulation-result">
              <h3>
                {simulation.eligible
                  ? "✓ 示例选科条件通过"
                  : "存在不满足的报考条件"}
              </h3>
              <p>{simulation.assessment}</p>
              <small>参考数据年份：{simulation.basisYear}</small>
              {simulation.warnings.map((w) => (
                <div className="notice amber" key={w}>
                  <AlertTriangle size={15} />
                  <p>{w}</p>
                </div>
              ))}
            </div>
          )}
          <div className="distribution">
            {(
              (isMock
                ? ["reach", "match", "safe"]
                : ["unknown", "reach", "match", "safe"]) as Tier[]
            ).map((t) => {
              const count = data.plan.entries.filter((e) => {
                const s = data.schools.find((s) => s.id === e.schoolId);
                return (
                  s &&
                  (isMock
                    ? classify(data.profile?.rank || 23500, s.rank)
                    : "unknown") === t
                );
              }).length;
              return (
                <div key={t}>
                  <span>
                    {tierSymbol[t]} {tierLabel[t]}
                  </span>
                  <div className={`distribution-bar ${t}`}>
                    <span
                      style={{
                        width: `${(count / Math.max(1, data.plan.entries.length)) * 100}%`,
                      }}
                    />
                  </div>
                  <b>{count}</b>
                </div>
              );
            })}
          </div>
          <p className="muted">占比表示志愿结构，不表示录取可能性。</p>
        </aside>
      </div>
    </div>
  );
}
export default function Planning({ path }: { path: string }) {
  return path === "/routes" ? (
    <Routes />
  ) : path === "/compare" ? (
    <Compare />
  ) : (
    <Workbench />
  );
}
