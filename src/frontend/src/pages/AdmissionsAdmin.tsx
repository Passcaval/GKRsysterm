import { useEffect, useRef, useState, type FormEvent } from "react";
import CatalogAdmin from "./CatalogAdmin";
import { api, isMock } from "../api";
import { Empty } from "../components";
import { useApp } from "../store";
import { beijingTime, errorText } from "../transport";
import {
  hasPermission,
  type AdmissionSourceSummary,
  type CrawlReviewInput,
  type CrawlRun,
  type CrawlRunSummary,
} from "../types";

const STATUS_TEXT: Record<string, string> = {
  queued: "排队中",
  running: "抓取中",
  awaiting_review: "待审核",
  approved: "已批准，等待发布",
  publishing: "发布中",
  succeeded: "已发布",
  partial: "部分发布",
  rejected: "已驳回",
  failed: "失败",
  cancelled: "已取消",
};

function statusText(value: string) {
  return STATUS_TEXT[value] || value;
}

function pageStatusText(value: string) {
  return (
    {
      pending: "待抓取",
      fetched: "已抓取",
      extracted: "已抽取",
      skipped: "已跳过",
      failed: "失败",
    }[value] || value
  );
}

function errorLines(values: unknown[]) {
  return values.map((value) => {
    if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      return [item.code, item.message].filter(Boolean).join("：");
    }
    return String(value);
  });
}

export default function AdmissionsAdmin() {
  const { data, notify } = useApp();
  const allowed = hasPermission(data.user, "admissions:import");
  const [sources, setSources] = useState<AdmissionSourceSummary | null>(null);
  const [runs, setRuns] = useState<CrawlRunSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<CrawlRun | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [decision, setDecision] = useState<"approve" | "reject">("approve");
  const [reason, setReason] = useState("");
  const [supersedes, setSupersedes] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [rowsOverride, setRowsOverride] = useState("");
  const reviewKey = useRef({ body: "", key: "" });

  useEffect(() => {
    if (!allowed || isMock) return;
    let active = true;
    Promise.all([api.admissionSources(), api.crawlRuns()])
      .then(([config, page]) => {
        if (!active) return;
        setSources(config);
        setRuns(page.items);
        setCursor(page.nextCursor);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [allowed]);

  async function loadRun(id: string) {
    setBusy(true);
    setError("");
    try {
      setSelected(await api.crawlRun(id));
      setDecision("approve");
      setReason("");
      setSupersedes("");
      setAcknowledge(false);
      setRowsOverride("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshRuns() {
    try {
      const page = await api.crawlRuns();
      setRuns(page.items);
      setCursor(page.nextCursor);
      if (selected) {
        const latest = page.items.find(
          (item) => item.crawlRunId === selected.crawlRunId,
        );
        if (latest) await loadRun(latest.crawlRunId);
      }
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function trigger() {
    setBusy(true);
    setError("");
    try {
      const run = await api.triggerCrawl(crypto.randomUUID());
      notify("抓取任务已创建");
      await refreshRuns();
      await loadRun(run.crawlRunId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function loadMoreRows() {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      const more = await api.crawlRun(
        selected.crawlRunId,
        selected.rows.length,
        200,
      );
      setSelected({
        ...more,
        rows: [...selected.rows, ...more.rows],
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function download(pageId: string) {
    if (!selected) return;
    setError("");
    try {
      const blob = await api.crawlPageRaw(selected.crawlRunId, pageId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `crawl-${pageId}.bin`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function submitReview(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    let override: Record<string, Record<string, unknown>[]> | undefined;
    if (rowsOverride.trim()) {
      try {
        override = JSON.parse(rowsOverride);
      } catch {
        setError("rows_override 不是合法 JSON");
        return;
      }
    }
    const input: CrawlReviewInput = {
      decision,
      reason,
      expectedVersion: selected.version,
      supersedesImportId: supersedes.trim() || null,
      acknowledgePublishedAtFallback: acknowledge,
      rowsOverride: override,
    };
    const body = JSON.stringify(input);
    if (body !== reviewKey.current.body)
      reviewKey.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const updated = await api.reviewCrawl(
        selected.crawlRunId,
        input,
        reviewKey.current.key,
      );
      setSelected(updated);
      notify(decision === "approve" ? "已批准并进入发布队列" : "已驳回");
      await refreshRuns();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!allowed)
    return <Empty text="需要招生数据管理权限（admissions:import）。" />;
  if (isMock)
    return (
      <section className="panel">
        <h1>招生数据抓取</h1>
        <p className="warning-text">
          当前是演示模式，抓取与审核只在真实 HTTP 后端可用。请在
          VITE_API_MODE=http 下使用本页。
        </p>
      </section>
    );

  return (
    <section className="panel" aria-labelledby="data-management-title">
      <h1 id="data-management-title">院校资料管理</h1>
      <CatalogAdmin />
      <div className="section-title">
        <div>
          <h2 id="crawl-title">浙江招生计划抓取</h2>
          <p className="muted">
            后端抓取官方页面，模型筛选链接并抽取字段；结果必须由管理员审核后才会发布。
          </p>
        </div>
        <button
          className="button gold-button"
          disabled={busy}
          onClick={() => void trigger()}
        >
          触发一次抓取
        </button>
      </div>

      {error && (
        <div className="notice amber" role="alert">
          <p>{error}</p>
        </div>
      )}

      {sources && (
        <div className="panel">
          <h2>配置摘要</h2>
          {sources.configError && (
            <p className="warning-text" role="alert">
              配置错误：{sources.configError}
            </p>
          )}
          <p className="muted">配置文件：{sources.configPath}</p>
          <p>
            模型：
            {sources.modelConfigured
              ? sources.modelName || "已配置"
              : "未配置（无法抓取）"}
          </p>
          {sources.config ? (
            <>
              <p>
                范围：{sources.config.scope.provinceCode} /{" "}
                {sources.config.scope.examYear} /{" "}
                {sources.config.scope.examCategory}
              </p>
              <p>
                允许域名：
                {[
                  ...sources.config.discovery.allowedHosts,
                  ...sources.config.discovery.allowedSuffixes,
                ].join("、") || "未配置"}
              </p>
              <p>
                来源：
                {sources.config.sources.filter((s) => s.enabled).length
                  ? sources.config.sources
                      .filter((s) => s.enabled)
                      .map((s) => s.name || s.url)
                      .join("、")
                  : "sources 为空，使用 discovery.entrypoints 自动发现"}
              </p>
              <p className="muted">
                配置指纹 {sources.config.configFingerprint.slice(0, 16)}…
              </p>
            </>
          ) : (
            <p className="warning-text">配置文件未加载，无法创建抓取任务。</p>
          )}
        </div>
      )}

      <div className="panel">
        <div className="section-title">
          <h2>抓取任务</h2>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void refreshRuns()}
          >
            刷新
          </button>
        </div>
        {!runs.length && <p className="muted">还没有抓取任务。</p>}
        <div className="form-actions">
          {runs.map((run) => (
            <button
              key={run.crawlRunId}
              className="text-button"
              disabled={busy}
              onClick={() => void loadRun(run.crawlRunId)}
            >
              {statusText(run.status)} · {run.rowCount} 行 ·{" "}
              {beijingTime(run.createdAt)} · {run.crawlRunId.slice(0, 8)}
            </button>
          ))}
        </div>
        {cursor && (
          <button
            className="text-button"
            disabled={busy}
            onClick={async () => {
              try {
                const page = await api.crawlRuns(cursor);
                setRuns((rows) => [...rows, ...page.items]);
                setCursor(page.nextCursor);
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            加载更多任务
          </button>
        )}
      </div>

      {selected && (
        <div className="panel">
          <h2>
            {statusText(selected.status)} · {selected.rowCount} 行（有效{" "}
            {selected.validRowCount}）
          </h2>
          <p className="muted">
            版本 {selected.version} · 模型 {selected.modelName || "未配置"} ·
            配置 {(selected.configFingerprint || "").slice(0, 16)}…
          </p>
          <p>
            进度：{String(selected.progress.pagesDone ?? 0)} 页 · 模型调用{" "}
            {String(selected.progress.modelCalls ?? 0)} 次
          </p>
          <p>
            导入批次：
            {selected.imports.length
              ? selected.imports
                  .map((item) => `${item.importId.slice(0, 8)}(${item.status})`)
                  .join("、")
              : "暂无"}
          </p>
          {selected.review.reviewedAt && (
            <p className="muted">
              审核：{selected.review.reason || "无理由"} ·{" "}
              {beijingTime(selected.review.reviewedAt)}
            </p>
          )}
          {errorLines(selected.errors).map((line, index) => (
            <p className="warning-text" key={`e-${index}`}>
              {line}
            </p>
          ))}
          {!!selected.warnings.length && (
            <details className="warning-details">
              <summary>模型告警（{selected.warnings.length}）</summary>
              {errorLines(selected.warnings).map((line, index) => (
                <p className="warning-text" key={`w-${index}`}>
                  {line}
                </p>
              ))}
            </details>
          )}

          <h3>页面</h3>
          {selected.pages.map((page) => (
            <article key={page.pageId} className="unit-row">
              <h4>
                {page.title || page.url} · {pageStatusText(page.status)}
              </h4>
              <p className="muted">{page.url}</p>
              <p>
                HTTP {page.httpStatus ?? "—"} · {page.contentType || "未知类型"}{" "}
                · {page.textChars} 字符 · {page.rowCount} 行
              </p>
              {page.publishedAt && (
                <p>官方发布时间：{beijingTime(page.publishedAt)}</p>
              )}
              {page.error && <p className="warning-text">{page.error}</p>}
              {page.hasSnapshot && (
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => void download(page.pageId)}
                >
                  下载原始快照
                </button>
              )}
            </article>
          ))}

          <h3>
            抽取行（已显示 {selected.rows.length} / {selected.rowTotal}）
          </h3>
          {selected.rows.map((row) => (
            <article
              key={row.rowId}
              className={`unit-row ${row.validation.status}`}
            >
              <h4>
                {String(
                  row.data.schoolName || row.data.schoolCode || "未知院校",
                )}{" "}
                · {String(row.data.major || "未知专业")}
              </h4>
              <p>
                招生单位 {String(row.data.unitCode || "—")} · 代码{" "}
                {String(row.data.code || "—")} · 学费{" "}
                {row.data.tuition == null ? "未知" : String(row.data.tuition)}
              </p>
              <p className="muted">
                {row.validation.status === "valid"
                  ? "有效"
                  : `无效：${row.validation.errors.map((e) => e.message).join("；")}`}
                {row.validation.warnings.length
                  ? ` · ${row.validation.warnings.join("；")}`
                  : ""}
              </p>
              {row.evidence && <p>证据：{row.evidence}</p>}
              <p className="muted">定位：{row.locator || "—"}</p>
            </article>
          ))}
          {selected.rows.length < selected.rowTotal && (
            <button
              className="text-button"
              disabled={busy}
              onClick={() => void loadMoreRows()}
            >
              加载更多行
            </button>
          )}

          {selected.status === "awaiting_review" && (
            <form className="panel" onSubmit={submitReview}>
              <h3>审核</h3>
              <label>
                结论
                <select
                  value={decision}
                  disabled={busy}
                  onChange={(e) =>
                    setDecision(e.target.value as "approve" | "reject")
                  }
                >
                  <option value="approve">批准并发布</option>
                  <option value="reject">驳回</option>
                </select>
              </label>
              <label>
                理由{decision === "reject" ? "（必填）" : "（可选）"}
                <textarea
                  value={reason}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={2000}
                />
              </label>
              <label>
                替代旧导入批次 ID（可选）
                <input
                  value={supersedes}
                  disabled={busy}
                  onChange={(e) => setSupersedes(e.target.value)}
                  placeholder="已有同院校+单位数据时填写"
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={acknowledge}
                  disabled={busy}
                  onChange={(e) => setAcknowledge(e.target.checked)}
                />
                页面没有官方发布时间，同意使用抓取时间并在来源中标记
              </label>
              <label>
                rows_override（可选，JSON：page_id → AdmissionRow 数组，字段用
                snake_case）
                <textarea
                  value={rowsOverride}
                  disabled={busy}
                  onChange={(e) => setRowsOverride(e.target.value)}
                  placeholder='{"<page_id>": [{"school_code":"...", ...}]}'
                />
              </label>
              <button
                className="button gold-button"
                disabled={busy}
                type="submit"
              >
                {busy ? "提交中…" : "提交审核"}
              </button>
            </form>
          )}
        </div>
      )}
    </section>
  );
}
