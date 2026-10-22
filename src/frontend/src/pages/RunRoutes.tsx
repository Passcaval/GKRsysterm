import { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw, Square, Radio } from "lucide-react";
import { api, isMock } from "../api";
import { useApp } from "../store";
import { PageTitle, Empty, Modal, Evidence, TierBadge } from "../components";
import type {
  CreateRunInput,
  RecommendationRun,
  RecommendationItem,
  RecommendationBranch,
  School,
} from "../types";
import { terminalRuns, runLabels, visibleRunItems } from "../workflow-domain";
import { ApiError, errorText, beijingTime } from "../transport";

function BranchCard({
  branch,
  items,
  onEvidence,
}: {
  branch: RecommendationBranch;
  items: RecommendationItem[];
  onEvidence: (ids: string[]) => void;
}) {
  const { data } = useApp();
  const selected = branch.itemIds
    .map((id) => items.find((item) => item.recommendationItemId === id))
    .filter((item): item is RecommendationItem => Boolean(item));
  return (
    <article className="panel branch-card">
      <h3>{branch.title}</h3>
      <p>{branch.summary}</p>
      <div className="form-grid">
        <div>
          <strong>可能的好处</strong>
          <ul>
            {branch.pros.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        </div>
        <div>
          <strong>需要接受的代价 / 风险</strong>
          <ul>
            {branch.cons.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        </div>
      </div>
      {selected.length > 0 && (
        <div className="branch-items">
          {selected.map((item) => {
            const school = data.schools.find((entry) => entry.id === item.schoolId);
            return (
              <button
                type="button"
                className="text-button branch-item"
                key={item.recommendationItemId}
                onClick={() => onEvidence(item.evidenceIds)}
              >
                {school?.name || item.schoolName || "院校"}
                <br />
                {item.major}
                {item.eligibility.status === "unknown" ? " · 待确认" : ""}
              </button>
            );
          })}
        </div>
      )}
    </article>
  );
}

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
        majorId: item.majorId ?? item.admissionUnitId,
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
            反馈已记录并关联任务、推荐项和当时的信息版本。
            {kind === "correction"
              ? "事实纠错等待核验，不会立即改写官方资料。"
              : "偏好变化可以继续在领航员对话里补充。"}
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
        description="推荐由领航员对话生成。这里查看可追溯的任务、条件核对和结果依据。"
      />
      <section className="panel">
        <h2>从一句话开始</h2>
        <p className="muted">
          不用填表。回到领航员说出你的情况，它会自动整理信息并生成可追溯推荐。
        </p>
        <button
          className="button gold-button"
          onClick={() => window.dispatchEvent(new Event("nv-open-chat"))}
        >
          回到领航员
        </button>
      </section>
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
            {beijingTime(run.createdAt)} · 绑定信息{" "}
            {run.profileVersionId || "无"} · 原始信息{" "}
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
        <section className="panel">
          <h2>还需要一点信息</h2>
          <p className="muted">
            {run.questions.map((q) => q.text).join("；")}
          </p>
          <p className="muted">
            不用在这里填表。回到领航员继续说，它会自动记下需要的信息。
          </p>
          <button
            className="button gold-button"
            onClick={() => window.dispatchEvent(new Event("nv-open-chat"))}
          >
            回到领航员继续聊
          </button>
        </section>
      )}
      {run?.validation.status === "passed" &&
        ["succeeded", "partial"].includes(run.status) && (
          <>
            {run.missingInfo && run.missingInfo.length > 0 && (
              <section className="panel">
                <h2>补充这些信息，结果会更精确</h2>
                <p className="muted">
                  当前结果仍可参考，但下列条件未知，相关硬条件和偏好判断会保持“待确认”。
                </p>
                <ul>
                  {run.missingInfo.map((item) => (
                    <li key={item.field}>{item.text}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  className="text-button"
                  onClick={() =>
                    window.dispatchEvent(new Event("nv-open-chat"))
                  }
                >
                  回到领航员补充
                </button>
              </section>
            )}
            {run.branches && run.branches.length > 0 && (
              <section>
                <h2>多种可能的选择</h2>
                <p className="muted">
                  因为部分偏好尚未填写，下面不是唯一答案。每种方向都列出可能的好处和需要核对的代价；补充信息后会进一步收敛。
                </p>
                {run.branches.map((branch) => (
                  <BranchCard
                    key={branch.branchId}
                    branch={branch}
                    items={items}
                    onEvidence={setEvidence}
                  />
                ))}
              </section>
            )}
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
