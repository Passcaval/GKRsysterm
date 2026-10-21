import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";
import { beijingTime, errorText } from "../transport";
import type {
  CatalogConfigSummary,
  CatalogRun,
  CatalogSummary,
} from "../types";

const labels: Record<string, string> = {
  queued: "等待抓取",
  fetching: "正在抓取全量名录",
  analysisPending: "等待AI分析",
  analysis_pending: "等待AI分析",
  analyzing: "AI分析中",
  awaiting_review: "等待管理员决定",
  published: "已更新正式资料",
  rejected: "已拒绝更新",
  failed: "抓取失败",
};
const kindLabels: Record<string, string> = {
  new: "新增",
  changed: "变更",
  unchanged: "未变化",
  conflict: "身份冲突，不自动更新",
};
const fields: Record<string, string> = {
  identifier: "学校标识码",
  name: "学校名称",
  province: "省份",
  city: "所在地",
  department: "主管部门",
  educationLevel: "办学层次",
  category: "类别",
  remarks: "备注",
};
function fact(value: string | null | undefined) {
  return value === "ordinary"
    ? "普通高校"
    : value === "adult"
      ? "成人高校"
      : value || "未提供";
}

export default function CatalogAdmin() {
  const { notify, refresh } = useApp();
  const [config, setConfig] = useState<CatalogConfigSummary | null>(null);
  const [runs, setRuns] = useState<CatalogSummary[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [run, setRun] = useState<CatalogRun | null>(null);
  const [kind, setKind] = useState("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");
  const [ack, setAck] = useState(false);
  const [mode, setMode] = useState("all");
  const [chosen, setChosen] = useState<string[]>([]);
  const keys = useRef(new Map<string, string>());
  function key(label: string) {
    if (!keys.current.has(label)) keys.current.set(label, crypto.randomUUID());
    return keys.current.get(label)!;
  }
  async function list(offset = 0) {
    const [settings, page] = await Promise.all([
      api.catalogConfig(),
      api.catalogRuns(offset),
    ]);
    setConfig(settings);
    setRuns((old) => (offset ? [...old, ...page.items] : page.items));
    setNext(page.nextOffset);
  }
  async function open(id: string, reset = false) {
    const value = await api.catalogRun(id, 0, kind, query);
    setRun(value);
    if (reset) {
      setChosen([]);
      setAck(false);
      setReason("");
    }
  }
  useEffect(() => {
    let active = true;
    list().catch((e) => active && setError(errorText(e)));
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!run) return;
    let active = true;
    const timer = setTimeout(
      () =>
        api
          .catalogRun(run.id, 0, kind, query)
          .then((value) => active && setRun(value))
          .catch((e) => active && setError(errorText(e))),
      300,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [run?.id, kind, query]);
  useEffect(() => {
    if (!run || !["queued", "fetching", "analyzing"].includes(run.status))
      return;
    let active = true;
    const timer = setInterval(
      () =>
        api
          .catalogRun(run.id, 0, kind, query)
          .then((value) => active && setRun(value))
          .catch((e) => active && setError(errorText(e))),
      3000,
    );
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [run?.id, run?.status, kind, query]);
  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function decide(decision: "approve" | "reject") {
    if (!run) return;
    const input = {
      decision,
      expectedVersion: run.version,
      reason,
      identifiers: mode === "selected" ? chosen : null,
      acknowledgeAnalysis: ack,
    };
    await api.catalogReview(run.id, input, key(run.id + JSON.stringify(input)));
    await open(run.id);
    await list();
    await refresh();
    notify(
      decision === "approve"
        ? "管理员已确认，所选院校资料已更新"
        : "已拒绝本次更新，正式资料保持原样",
    );
  }
  return (
    <section className="panel" aria-labelledby="catalog-title">
      <h2 id="catalog-title">全国院校基础资料</h2>
      <p>
        完整抓取教育部普通高校及成人高校名单 → AI分析新旧差异与异常 →
        管理员决定是否更新。省级招生计划在下方单独管理。
      </p>
      {config && (
        <p>
          {config.scope}。部署自动抓取：{config.autoStart ? "开启" : "关闭"}
          ；AI：
          {config.modelConfigured ? config.modelName : "未配置，抓取后等待分析"}
          。
        </p>
      )}
      {error && (
        <p className="notice amber" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button
          className="button gold-button"
          disabled={busy || config?.enabled === false}
          onClick={() =>
            void action(async () => {
              const value = await api.catalogTrigger(
                key(
                  "fetch:" + (runs[0]?.id || "initial") + ":" + runs[0]?.status,
                ),
              );
              await list();
              await open(value.id, true);
            })
          }
        >
          重新抓取全国名录
        </button>
        <button
          className="text-button"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await list();
              if (run) await open(run.id);
            })
          }
        >
          刷新状态
        </button>
      </div>
      <div className="form-actions">
        {runs.map((value) => (
          <button
            className="text-button"
            key={value.id}
            disabled={busy}
            onClick={() => void action(() => open(value.id, true))}
          >
            {beijingTime(value.createdAt)} ·{" "}
            {labels[value.status] || value.status}
          </button>
        ))}
      </div>
      {next !== null && (
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void action(() => list(next))}
        >
          更多历史任务
        </button>
      )}
      {run && (
        <>
          {run.snapshot.asOf && (
            <p>
              官方名单截至日期：{run.snapshot.asOf}
              。请结合来源日期核对是否需要更新。
            </p>
          )}
          <h3>{labels[run.status] || run.status}</h3>
          {run.error && (
            <p className="warning-text" role="alert">
              {run.error}
            </p>
          )}
          {run.officialCounts && (
            <p>
              官方总数 {run.officialCounts.total} 所：普通高校{" "}
              {run.officialCounts.ordinary}，成人高校 {run.officialCounts.adult}
              。新增 {run.counts.new}，变更 {run.counts.changed}，未变化{" "}
              {run.counts.unchanged}，冲突 {run.counts.conflict}。
            </p>
          )}
          {run.snapshot.scopeNote && (
            <p className="muted">{run.snapshot.scopeNote}</p>
          )}
          {run.review.publishedCount !== undefined && (
            <p>
              本次已更新 {run.review.publishedCount} 所。审核说明：
              {run.review.reason}
            </p>
          )}
          {run.status === "analysis_pending" && (
            <button
              className="button"
              disabled={busy || !config?.modelConfigured}
              onClick={() =>
                void action(async () => {
                  await api.catalogAnalyze(
                    run.id,
                    run.version,
                    key("analyze:" + run.id + ":" + run.version),
                  );
                  await open(run.id);
                })
              }
            >
              对已抓取结果重新进行AI分析
            </button>
          )}
          {(run.snapshot.snapshots || []).map((snapshot, index) => (
            <p key={index}>
              <a href={snapshot.url} target="_blank" rel="noreferrer">
                官方原件：
                {snapshot.label === "ordinary"
                  ? "全国普通高校名单"
                  : snapshot.label === "adult"
                    ? "全国成人高校名单"
                    : snapshot.label}
              </a>{" "}
              ·{" "}
              <button
                className="text-button"
                onClick={() =>
                  void action(async () => {
                    const blob = await api.catalogRaw(run.id, index);
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    const extension =
                      /\.xlsx?(?=$|[?#])/i.exec(snapshot.url)?.[0] || ".bin";
                    a.download = `全国院校名录-${index}${extension}`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  })
                }
              >
                下载保存的快照
              </button>
            </p>
          ))}
          {run.analysis.batches && (
            <section>
              <h3>
                AI分析（{run.analysis.rowsAnalyzed} 所，{run.analysis.modelName}
                ）
              </h3>
              <p>AI仅提供审核意见，不改写官方字段；最终更新由管理员决定。</p>
              {run.analysis.batches.map((batch) => (
                <details key={batch.offset}>
                  <summary>
                    第 {batch.offset + 1}–{batch.offset + batch.count} 所
                  </summary>
                  <p>{batch.summary}</p>
                  {batch.warnings.map((warning, index) => (
                    <p className="warning-text" key={index}>
                      {warning}
                    </p>
                  ))}
                </details>
              ))}
            </section>
          )}
          <h3>院校资料对比</h3>
          <label>
            搜索院校名称或标识码
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
          <label>
            筛选
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="all">全部</option>
              {Object.entries(kindLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p>
            已显示 {run.changes.length} / {run.total} 所；已勾选 {chosen.length}{" "}
            所。
          </p>
          {run.changes.map((change) => (
            <details key={change.identifier} className="panel">
              <summary>
                {change.name} · {change.identifier} · {kindLabels[change.kind]}
              </summary>
              {["new", "changed"].includes(change.kind) && (
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.includes(change.identifier)}
                    onChange={(e) =>
                      setChosen((values) =>
                        e.target.checked
                          ? [...values, change.identifier]
                          : values.filter((id) => id !== change.identifier),
                      )
                    }
                  />
                  选择此院校更新
                </label>
              )}
              <table>
                <thead>
                  <tr>
                    <th>资料</th>
                    <th>更新前</th>
                    <th>官方本次资料</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(fields).map(([field, label]) => (
                    <tr key={field}>
                      <td>{label}</td>
                      <td>{fact(change.before[field])}</td>
                      <td>{fact(change.after[field])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          ))}
          {run.nextOffset !== null && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const page = await api.catalogRun(
                    run.id,
                    run.nextOffset!,
                    kind,
                    query,
                  );
                  setRun({
                    ...page,
                    changes: [...run.changes, ...page.changes],
                  });
                })
              }
            >
              更多院校
            </button>
          )}
          {["analysis_pending", "awaiting_review"].includes(run.status) && (
            <form
              className="panel"
              onSubmit={(e) => {
                e.preventDefault();
                void action(() => decide("approve"));
              }}
            >
              <h3>管理员更新决定</h3>
              <p>
                身份冲突的院校不自动合并；本次未选中的院校及未出现在新名单中的旧院校不会被删除。
              </p>
              <label>
                更新范围
                <select value={mode} onChange={(e) => setMode(e.target.value)}>
                  <option value="all">全部新增与变更院校（冲突除外）</option>
                  <option value="selected">仅勾选的院校</option>
                </select>
              </label>
              <label>
                审核说明
                <textarea
                  required
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                我已核对官方原件、完整性、新旧差异和AI告警
              </label>
              <div className="form-actions">
                <button
                  type="submit"
                  className="button gold-button"
                  disabled={
                    busy ||
                    run.status !== "awaiting_review" ||
                    !ack ||
                    !reason.trim() ||
                    (mode === "selected" && !chosen.length)
                  }
                >
                  确认更新院校资料
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy || !reason.trim()}
                  onClick={() => void action(() => decide("reject"))}
                >
                  拒绝本次更新
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </section>
  );
}
