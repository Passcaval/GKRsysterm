import { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw, Square, Radio } from "lucide-react";
import { api, isMock } from "../api";
import { useApp } from "../store";
import { PageTitle, Empty, Modal, Evidence, TierBadge } from "../components";
import type {
  CreateRunInput,
  RecommendationRun,
  RecommendationItem,
  School,
} from "../types";
import { terminalRuns, runLabels, visibleRunItems } from "../workflow-domain";
import { ApiError, errorText, beijingTime } from "../transport";

function Item({
  item,
  run,
  onEvidence,
}: {
  item: RecommendationItem;
  run: RecommendationRun;
  onEvidence: (ids: string[]) => void;
}) {
  const { data, update, notify, navigate } = useApp();
  const [school, setSchool] = useState<School | undefined>(
      data.schools.find((s) => s.id === item.schoolId),
    ),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  const [kind, setKind] = useState<"preference" | "correction">("preference"),
    [reason, setReason] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(false);
  const key = useRef({ body: "", key: "" });
  useEffect(() => {
    let active = true;
    if (!school) {
      setLoading(true);
      api
        .school(item.schoolId)
        .then((s) => {
          if (active) setSchool(s);
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [item.schoolId]);
  async function add() {
    setBusy(true);
    try {
      if (!data.user) throw new Error("请先登录");
      const entry = {
        id: crypto.randomUUID(),
        schoolId: item.schoolId,
        major: item.major,
        adjustment: data.profile?.acceptAdjustment ?? false,
        admissionUnitId: item.admissionUnitId,
        recommendationItemId: item.recommendationItemId,
        provinceCode: data.profile?.province,
        examYear: data.profile?.year,
      };
      update({
        plan: await api.plan({
          ...data.plan,
          entries: [...data.plan.entries, entry],
        }),
      });
      notify("已按招生单位加入志愿草案");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function feedback(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const body = JSON.stringify({ kind, reason });
    if (body !== key.current.body)
      key.current = { body, key: crypto.randomUUID() };
    try {
      await api.recommendationFeedback(
        run.runId,
        item.recommendationItemId,
        kind,
        reason,
        key.current.key,
      );
      setSent(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={`panel run-item ${item.historicalRisk.status}`}>
      <div className="section-title">
        <div>
          <h3>{school?.name || item.schoolName || `院校 ${item.schoolId}`}</h3>
          <p>{item.major}</p>
        </div>
        <TierBadge tier={item.historicalRisk.status} />
      </div>
      {loading && <p role="status">正在按ID加载院校详情…</p>}
      {error && (
        <div className="notice amber" role="alert">
          <p>{error}</p>
        </div>
      )}
      <p className="muted">
        招生单位 {item.admissionUnitId} · 校区 {item.campusId || "待确认"}
      </p>
      <p>
        条件：
        {item.eligibility.status === "pass"
          ? "已满足已知要求"
          : item.eligibility.status === "fail"
            ? "不满足"
            : "待确认"}{" "}
        {item.eligibility.missingRequirements.join("、")}
      </p>
      <p>历史风险：{item.historicalRisk.reason}</p>
      <p>
        偏好匹配：
        {item.preferenceMatch.score === null
          ? "未评估"
          : `${item.preferenceMatch.score}/100`}{" "}
        <small>
          覆盖度 {Math.round(item.preferenceMatch.coverage * 100)}% · 非录取概率
        </small>
      </p>
      <p>{item.reasons.join("；")}</p>
      {item.warnings.map((w) => (
        <p className="warning-text" key={w}>
          {w}
        </p>
      ))}
      <div className="form-actions">
        <button
          className="text-button"
          onClick={() => onEvidence(item.evidenceIds)}
        >
          读取推荐证据 <ArrowRight size={13} />
        </button>
        <button
          className="text-button"
          onClick={() => navigate("/school/" + item.schoolId)}
        >
          院校详情
        </button>
        <button
          className="button"
          disabled={
            busy ||
            data.plan.entries.some(
              (e) =>
                e.admissionUnitId === item.admissionUnitId &&
                e.major === item.major,
            )
          }
          onClick={() => void add()}
        >
          加入此招生单位
        </button>
      </div>
      <details>
        <summary>反馈这条推荐</summary>
        {sent ? (
          <p role="status">
            反馈已记录并关联任务、推荐项和当时画像版本。
            {kind === "correction"
              ? "事实纠错等待核验，不会立即改写官方资料。"
              : "偏好变化需确认后再更新画像。"}
          </p>
        ) : (
          <form onSubmit={feedback}>
            <label>
              反馈类型
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="preference">个人偏好／预算不合适</option>
                <option value="correction">事实或引用有误</option>
              </select>
            </label>
            <label>
              具体原因
              <textarea
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <button className="button" disabled={busy}>
              提交本条反馈
            </button>
          </form>
        )}
      </details>
    </article>
  );
}
export default function RunRoutes() {
  const { data, refresh, navigate } = useApp();
  const owner = data.user?.id || "anonymous";
  const [question, setQuestion] = useState(
      () =>
        sessionStorage.getItem("nv-run-question") ||
        "根据我的档案，帮我探索适合的报考选择",
    ),
    [intent, setIntent] = useState<CreateRunInput["intent"]>("risk"),
    [risk, setRisk] = useState(50);
  const [id, setId] = useState(
      () => sessionStorage.getItem("nv-last-run:" + owner) || "",
    ),
    [run, setRun] = useState<RecommendationRun | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [wake, setWake] = useState(0),
    [live, setLive] = useState(false),
    [answers, setAnswers] = useState<Record<string, string>>({}),
    [evidence, setEvidence] = useState<string[] | null>(null);
  const controller = useRef<AbortController | null>(null);
  const createKey = useRef({ body: "", key: "" }),
    answerKey = useRef({ body: "", key: "" });
  useEffect(() => {
    if (!id || !data.user) return;
    let active = true;
    const c = new AbortController();
    controller.current = c;
    const cursorKey = "nv-run-cursor:" + owner + ":" + id;
    let cursor = Number(sessionStorage.getItem(cursorKey) || 0);
    async function listen() {
      setLive(true);
      setError("");
      try {
        let snapshot = await api.getRun(id);
        if (!active) return;
        setRun(snapshot);
        if (terminalRuns.includes(snapshot.status)) return;
        for await (const e of api.runEvents(id, cursor, c.signal)) {
          if (!active || c.signal.aborted) return;
          if (e.eventId <= cursor) continue;
          cursor = e.eventId;
          sessionStorage.setItem(cursorKey, String(cursor));
          snapshot = await api.getRun(id);
          if (!active) return;
          setRun(snapshot);
          if (terminalRuns.includes(snapshot.status)) break;
        }
        if (active && !c.signal.aborted) {
          const latest = await api.getRun(id);
          setRun(latest);
          if (!terminalRuns.includes(latest.status))
            setError("监听已断开，任务仍保留；可恢复监听或查询状态。");
        }
      } catch (e) {
        if (!active || c.signal.aborted) return;
        try {
          const latest = await api.getRun(id);
          if (!active) return;
          setRun(latest);
          if (e instanceof ApiError && e.status === 410) {
            sessionStorage.setItem(cursorKey, String(latest.lastEventId));
            setError("历史事件已过期，已恢复任务快照；可重新监听后续事件。");
          } else if (!terminalRuns.includes(latest.status))
            setError(errorText(e));
        } catch (failure) {
          if (active) setError(errorText(failure));
        }
      } finally {
        if (active) setLive(false);
      }
    }
    void listen();
    return () => {
      active = false;
      c.abort();
    };
  }, [id, wake, owner]);
  async function create() {
    setBusy(true);
    setError("");
    const input: CreateRunInput = {
      question,
      profileVersionId: data.profile?.profileVersionId ?? null,
      riskPreference: risk,
      intent,
    };
    const body = JSON.stringify(input);
    if (body !== createKey.current.body)
      createKey.current = { body, key: crypto.randomUUID() };
    try {
      const value = await api.createRun(input, createKey.current.key);
      sessionStorage.setItem("nv-last-run:" + owner, value.runId);
      setRun(value);
      setId(value.runId);
      setWake((v) => v + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function answer(e: React.FormEvent) {
    e.preventDefault();
    if (!run) return;
    setBusy(true);
    setError("");
    const body = JSON.stringify({ id, answers, version: run.version });
    if (body !== answerKey.current.body)
      answerKey.current = { body, key: crypto.randomUUID() };
    try {
      const value = await api.answerRun(
        id,
        answers,
        run.version,
        answerKey.current.key,
      );
      setRun(value);
      await refresh();
      setWake((v) => v + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    if (!run) return;
    setBusy(true);
    setError("");
    try {
      const value = await api.cancelRun(id, run.version, crypto.randomUUID());
      controller.current?.abort();
      setRun(value);
      setLive(false);
    } catch (e) {
      setError(errorText(e));
      setWake((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  const ongoing = run && !terminalRuns.includes(run.status);
  const items = visibleRunItems(run);
  if (!data.user)
    return (
      <Empty
        text="请先登录，再创建或恢复本人推荐任务。校园生活可直接在院校星图和回声页查询。"
        action="前往登录"
        onAction={() => navigate("/me")}
      />
    );
  return (
    <>
      <PageTitle
        eyebrow="A ROUTE YOU CAN TRACE"
        title="每一条航线，都有依据"
        description="先确认问题和画像，再创建推荐任务。仅展示通过结果校验的建议，未知条件会单列。"
      />
      <form
        className="panel run-create"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <label>
          这次想了解什么？
          <textarea
            required
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            查询意图
            <select
              value={intent}
              onChange={(e) => setIntent(e.target.value as typeof intent)}
            >
              <option value="campus_life">校园生活（不要求成绩）</option>
              <option value="admission">个性化报考条件</option>
              <option value="risk">报考与历史风险分析</option>
            </select>
          </label>
          <label>
            选择偏好 {risk}
            <input
              type="range"
              min={0}
              max={100}
              value={risk}
              onChange={(e) => setRisk(Number(e.target.value))}
            />
          </label>
        </div>
        <p className="muted">
          画像版本：{data.profile?.profileVersionId || "暂无，将按本次问题补问"}
          。调整滑块不会自动创建后台任务。
        </p>
        <button className="button gold-button" disabled={busy || !!ongoing}>
          {busy
            ? "处理中…"
            : ongoing
              ? "请先完成或取消当前任务"
              : "确认并生成航线"}
        </button>
      </form>
      {error && (
        <div className="notice amber" role="alert">
          <p>{error}</p>
        </div>
      )}
      {run && (
        <section className="panel run-progress" role="status">
          <div className="section-title">
            <h2>{runLabels[run.status]}</h2>
            <span className="source-tag">任务 v{run.version}</span>
          </div>
          <p>任务编号：{run.runId}</p>
          <p className="muted">
            {beijingTime(run.createdAt)} · 绑定画像{" "}
            {run.profileVersionId || "无"} · 原始画像{" "}
            {run.originalProfileVersionId || "无"}
          </p>
          <p className="muted">
            数据 {run.dataVersion || "待确认"} / 规则{" "}
            {run.ruleVersion || "待确认"}
          </p>
          <p>{run.validation.summary}</p>
          <p>{run.summary || "执行过程尚不是正式推荐。"}</p>
          <div className="form-actions">
            {live ? (
              <button
                className="button"
                onClick={() => {
                  controller.current?.abort();
                  setLive(false);
                }}
              >
                <Square size={14} /> 仅停止监听
              </button>
            ) : (
              <button className="button" onClick={() => setWake((v) => v + 1)}>
                <Radio size={14} /> 恢复监听／查询状态
              </button>
            )}
            {ongoing && (
              <button
                className="button danger"
                disabled={busy}
                onClick={() => void cancel()}
              >
                取消后台任务
              </button>
            )}
          </div>
          <small className="muted">
            离开页面或停止监听不会取消任务。只有“取消后台任务”会向后端提交取消请求。
          </small>
          {run.error && <p className="warning-text">{run.error}</p>}
        </section>
      )}
      {run?.status === "waiting_input" && (
        <form className="panel" onSubmit={answer}>
          <h2>补充本次需要的条件</h2>
          <p className="muted">
            提交后会形成新的画像版本，最初版本仍保留在任务中。
          </p>
          {run.questions.map((q) => (
            <label key={q.field}>
              {q.text}
              {q.field === "consent" ? (
                <select
                  required
                  value={answers[q.field] || ""}
                  onChange={(e) =>
                    setAnswers((p) => ({ ...p, [q.field]: e.target.value }))
                  }
                >
                  <option value="">请选择</option>
                  <option value="true">同意本次使用画像</option>
                  <option value="false">不同意</option>
                </select>
              ) : (
                <input
                  required={q.required}
                  type={
                    ["rank", "exam_year"].includes(q.field) ? "number" : "text"
                  }
                  value={answers[q.field] || ""}
                  onChange={(e) =>
                    setAnswers((p) => ({ ...p, [q.field]: e.target.value }))
                  }
                />
              )}
            </label>
          ))}
          <button className="button gold-button" disabled={busy}>
            确认答案并继续任务
          </button>
        </form>
      )}
      {run?.validation.status === "passed" &&
        ["succeeded", "partial"].includes(run.status) && (
          <>
            <h2>已通过校验的结果</h2>
            {["reach", "match", "safe", "unknown"].map((tier) => (
              <section key={tier} className="run-lane">
                <h3>
                  {
                    {
                      reach: "冲 · 历史挑战",
                      match: "稳 · 继续核验",
                      safe: "保 · 仍需核对",
                      unknown: "待确认 · 不视为已满足",
                    }[tier]
                  }
                </h3>
                <div className="school-grid">
                  {items
                    .filter((i) => i.historicalRisk.status === tier)
                    .map((i) => (
                      <Item
                        key={i.recommendationItemId}
                        item={i}
                        run={run}
                        onEvidence={setEvidence}
                      />
                    ))}
                </div>
              </section>
            ))}
            {!items.length && (
              <Empty
                text={
                  run.summary ||
                  "没有通过已知硬条件检查的候选，请调整条件或核对数据。"
                }
              />
            )}
          </>
        )}
      {evidence && (
        <Modal title="推荐证据与适用范围" onClose={() => setEvidence(null)}>
          <Evidence ids={evidence} />
        </Modal>
      )}
      {isMock && (
        <p className="warning-text">
          演示任务在本地使用合成资料，不代表后端、模型或真实招生规则已经验收。
        </p>
      )}
    </>
  );
}
