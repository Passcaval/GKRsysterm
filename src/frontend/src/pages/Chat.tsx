import { useEffect, useRef, useState } from "react";
import {
  Sparkles,
  X,
  Send,
  Square,
  CheckCircle2,
  LoaderCircle,
  ArrowUpRight,
} from "lucide-react";
import { api, isMock } from "../api";
import { Evidence, Modal } from "../components";
import type { ChatMessage, Profile, RecommendationRun } from "../types";
import { useApp } from "../store";
import { errorText, profileToWire } from "../transport";
import {
  missingForIntent,
  runLabels,
  terminalRuns,
  visibleRunItems,
} from "../workflow-domain";
const PROFILE_MISSING_LABELS: Record<string, string> = {
  province_code: "生源省份",
  exam_year: "报考年份",
  subjects: "三门选考科目",
  rank: "省内位次",
};
export default function Chat({ onClose }: { onClose: () => void }) {
  const { data, update, notify, navigate } = useApp();
  const owner = data.user?.id;
  const [runId, setRunId] = useState(() =>
    owner ? sessionStorage.getItem("nv-last-run:" + owner) || "" : "",
  );
  const [run, setRun] = useState<RecommendationRun | null>(null);
  const [runBusy, setRunBusy] = useState(false);
  const [runError, setRunError] = useState("");
  const [wake, setWake] = useState(0);
  const generation = useRef(0);
  const createKey = useRef({ body: "", key: "" });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<
    { tool: string; text: string; done: boolean }[]
  >([]);
  const [error, setError] = useState("");
  const [conversation, setConversation] = useState<string>();
  const [evidence, setEvidence] = useState<string[] | null>(null);
  const [conversationProfile, setConversationProfile] =
    useState<Profile | null>(null);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      generation.current++;
    },
    [owner],
  );
  useEffect(() => {
    if (!runId || !owner) return;
    let active = true;
    const c = new AbortController();
    async function listen() {
      try {
        let snapshot = await api.getRun(runId);
        if (!active) return;
        setRun(snapshot);
        if (
          terminalRuns.includes(snapshot.status) ||
          snapshot.status === "waiting_input"
        )
          return;
        for await (const event of api.runEvents(
          runId,
          snapshot.lastEventId,
          c.signal,
        )) {
          if (!active) return;
          snapshot = await api.getRun(runId);
          if (!active) return;
          setRun(snapshot);
          if (terminalRuns.includes(snapshot.status)) break;
        }
      } catch (e) {
        if (active && !c.signal.aborted) setRunError(errorText(e));
      }
    }
    void listen();
    return () => {
      active = false;
      c.abort();
    };
  }, [runId, owner, wake]);
  async function recommend(profile: Profile, save = true) {
    if (!owner || runBusy) return;
    const current = ++generation.current;
    setRunBusy(true);
    setRunError("");
    try {
      let saved = profile;
      if (
        save &&
        JSON.stringify(profileToWire(profile)) !==
          JSON.stringify(data.profile ? profileToWire(data.profile) : null)
      ) {
        saved = await api.profile(profile);
        if (generation.current !== current) return;
        update({ profile: saved });
      }
      if (missingForIntent(saved, "admission").length)
        throw new Error("请先确认省份、位次、三门选科及使用授权。");
      const input = {
        question:
          "根据已确认的位次、选科和现有偏好，推荐可比较的院校专业方向，并说明理由及待核对信息。",
        intent: "admission" as const,
        riskPreference: 50,
        profileVersionId: saved.profileVersionId || null,
      };
      const body = JSON.stringify(input);
      if (createKey.current.body !== body)
        createKey.current = { body, key: crypto.randomUUID() };
      const next = await api.createRun(input, createKey.current.key);
      if (generation.current !== current) return;
      sessionStorage.setItem("nv-last-run:" + owner, next.runId);
      setRun(next);
      setRunId(next.runId);
      setWake((v) => v + 1);
      createKey.current = { body: "", key: "" };
    } catch (e) {
      if (generation.current === current) setRunError(errorText(e));
    } finally {
      if (generation.current === current) setRunBusy(false);
    }
  }
  useEffect(() => {
    field.current?.focus();
    const q = sessionStorage.getItem("nv-question");
    if (q) {
      setInput(q);
      sessionStorage.removeItem("nv-question");
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => {
      controller.current?.abort();
      window.removeEventListener("keydown", key);
    };
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [messages]);
  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    setError("");
    setTrace([]);
    const priorHistory = data.user
      ? undefined
      : messages
          .filter((m) => m.text)
          .slice(-8)
          .map((m) => ({ role: m.role, content: m.text }));
    setMessages((m) => [
      ...m,
      { role: "user", text, sourceIds: [] },
      { role: "assistant", text: "", sourceIds: [] },
    ]);
    const c = new AbortController();
    controller.current = c;
    try {
      for await (const e of api.chat(
        text,
        conversation,
        c.signal,
        priorHistory,
      )) {
        if (e.type === "tool_start")
          setTrace((t) => [
            ...t,
            { tool: e.tool || "", text: e.text || "", done: false },
          ]);
        if (e.type === "tool_end")
          setTrace((t) =>
            t.map((x) =>
              x.tool === e.tool
                ? { ...x, text: e.text || x.text, done: true }
                : x,
            ),
          );
        if (e.type === "delta")
          setMessages((m) =>
            m.map((x, i) =>
              i === m.length - 1 ? { ...x, text: x.text + (e.text || "") } : x,
            ),
          );
        if (e.type === "evidence")
          setMessages((m) =>
            m.map((x, i) =>
              i === m.length - 1 ? { ...x, sourceIds: e.sourceIds || [] } : x,
            ),
          );
        if (e.type === "profile_update" && e.applied) {
          if (e.profile) update({ profile: e.profile });
          if (e.conversationProfile)
            setConversationProfile(e.conversationProfile);
          if (e.changes?.length) notify("已根据对话记下你的报考信息");
        }
        if (e.type === "done") setConversation(e.conversationId);
      }
    } catch (e) {
      setMessages((m) => {
        const last = m.at(-1);
        return last?.role === "assistant" && !last.text ? m.slice(0, -1) : m;
      });
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function resetChat() {
    controller.current?.abort();
    generation.current++;
    setMessages([]);
    setConversation(undefined);
    setInput("");
    setTrace([]);
    setError("");
    setEvidence(null);
    setConversationProfile(null);
    setRun(null);
    setRunId("");
    setRunBusy(false);
    setRunError("");
    if (owner) sessionStorage.removeItem("nv-last-run:" + owner);
  }
  const activeProfile = conversationProfile;
  const profileMissing = activeProfile
    ? missingForIntent(activeProfile, "admission").filter(
        (field) => field !== "consent",
      )
    : ["province_code", "subjects", "rank"];
  const profileReady = profileMissing.length === 0;
  return (
    <>
      <div className="chat-scrim" onClick={onClose} />
      <section
        className="chat-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="AI 领航员"
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            const focusables = e.currentTarget.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,a[href],textarea:not(:disabled)",
            );
            const first = focusables[0],
              last = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div className="chat-header">
          <span className="chat-spark">
            <Sparkles size={24} />
          </span>
          <div>
            <h2>你的夜航领航员</h2>
            <small>支持联网查询招生资料，点击来源核对。</small>
          </div>
          <button
            type="button"
            className="text-button chat-reset"
            onClick={resetChat}
          >
            清空对话
          </button>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="关闭领航员"
          >
            <X size={21} />
          </button>
        </div>
        <div className="chat-messages">
          <div className="chat-welcome">
            <span className="eyebrow">LET’S FIND YOUR DIRECTION</span>
            <h2>
              想去哪里，
              <br />
              我们一起看看。
            </h2>
            <p>先按省份、位次和选科看看方向，再一起找到适合你的院校和专业。</p>
            <div className="chips">
              {[
                "我还没有院校和专业偏好，可以先推荐几个方向吗？",
                "如何判断一篇校园体验是否可信？",
              ].map((q) => (
                <button key={q} onClick={() => setInput(q)}>
                  {q}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          </div>
          {data.user ? (
            <div className="navigator-chat-guide">
              <p className="muted">
                不用填表。直接告诉我你的生源省份、位次、选考和想法，我会边聊边记下。
              </p>
              {profileReady ? (
                <button
                  className="button gold-button"
                  disabled={runBusy}
                  onClick={() =>
                    void recommend({ ...activeProfile!, consent: true })
                  }
                >
                  {runBusy ? "正在生成…" : "用对话里的信息生成推荐"}
                </button>
              ) : (
                <p className="muted">
                  还需要：
                  {profileMissing
                    .map((field) => PROFILE_MISSING_LABELS[field] || field)
                    .join("、")}
                  。直接告诉我就行。
                </p>
              )}
            </div>
          ) : (
            <p className="notice amber">
              不用登录也可以先问。登录后可以保存正式推荐任务、参与社区发帖；管理功能需要管理员账号。
              <button
                className="text-button"
                onClick={() => {
                  onClose();
                  navigate("/login");
                }}
              >
                登录
              </button>
            </p>
          )}
          {runError && (
            <div role="alert" className="notice amber">
              <p>{runError}</p>
              {runId && (
                <button
                  className="text-button"
                  onClick={() => {
                    setRunError("");
                    setWake((v) => v + 1);
                  }}
                >
                  重新连接推荐任务
                </button>
              )}
            </div>
          )}
          {run && (
            <section className="navigator-results" aria-live="polite">
              <h3>
                领航员为你找到的方向 <small>{runLabels[run.status]}</small>
              </h3>
              {run.profileVersionId !== data.profile?.profileVersionId ? (
                <p>对话里的信息有更新，可以重新生成推荐。</p>
              ) : (
                <>
                  {!terminalRuns.includes(run.status) && (
                    <p>
                      {run.status === "waiting_input"
                        ? run.questions.map((q) => q.text).join("；")
                        : "正在对照已发布招生资料检查条件，结果会直接显示在这里。"}
                    </p>
                  )}
                  {run.validation.status === "passed" && (
                    <>
                      <p className="muted">
                        依据本次对话整理的信息。
                        {isMock
                          ? "当前为合成演示数据。"
                          : "来源为已发布招生资料。"}
                        缺少偏好时先比较方向，待确认条件会保留提示。
                      </p>
                      {visibleRunItems(run)
                        .slice(0, 6)
                        .map((item) => (
                          <article
                            className="navigator-result"
                            key={item.recommendationItemId}
                          >
                            <h4>
                              {item.schoolName ||
                                data.schools.find((s) => s.id === item.schoolId)
                                  ?.name ||
                                "院校待核对"}{" "}
                              · {item.major}
                            </h4>
                            <p>{item.reasons.join("；")}</p>
                            <p className="muted">
                              {item.preferenceMatch.score === null
                                ? "尚未设置偏好，先作为探索方向"
                                : `偏好匹配 ${item.preferenceMatch.score}/100`}{" "}
                              ·{" "}
                              {item.eligibility.status === "unknown"
                                ? "条件待确认"
                                : "满足已知条件"}
                            </p>
                            <p className="warning-text">
                              {item.eligibility.missingRequirements.join("；")}
                            </p>
                            <p className="muted">
                              {item.historicalRisk.reason}
                            </p>
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => setEvidence(item.evidenceIds)}
                            >
                              查看来源依据 <ArrowUpRight size={13} />
                            </button>
                          </article>
                        ))}
                      {!visibleRunItems(run).length && (
                        <p>
                          {run.summary ||
                            "暂时没有可展示的招生单位，请确认官方数据已审核发布。"}
                        </p>
                      )}
                      {!!run.branches?.length && (
                        <div className="navigator-directions">
                          {run.branches.map((branch) => (
                            <p key={branch.branchId}>
                              <strong>{branch.title}</strong>
                              <br />
                              {branch.pros[0]}；{branch.cons[0]}
                            </p>
                          ))}
                        </div>
                      )}
                      <p className="muted">
                        接下来可以补充想去的省份、院校或专业，也可以先告诉我你更在意什么。
                      </p>
                    </>
                  )}
                  {run.status === "failed" && (
                    <p className="warning-text">
                      {run.error ||
                        "任务未完成，请核对当前支持范围和服务状态。"}
                    </p>
                  )}
                </>
              )}
              <button
                className="text-button"
                onClick={() => {
                  onClose();
                  navigate("/routes");
                }}
              >
                查看完整推荐与任务记录 <ArrowUpRight size={13} />
              </button>
            </section>
          )}
          {messages.map((m, i) => (
            <article key={i} className={`chat-message ${m.role}`}>
              <span className="message-role">
                {m.role === "assistant" ? "✧ 领航员" : "你"}
              </span>
              <p>{m.text || "正在检索可用信息…"}</p>
              {m.sourceIds.length > 0 && (
                <button
                  className="sources-bar"
                  onClick={() => setEvidence(m.sourceIds)}
                >
                  查看 {m.sourceIds.length} 条依据 · 官方 / 体验 / 推断
                  <ArrowUpRight size={13} />
                </button>
              )}
            </article>
          ))}
          {trace.length > 0 && (
            <div className="tool-trace">
              <small>检索进度与工具状态</small>
              {trace.map((t, i) => (
                <div key={i}>
                  {t.done ? (
                    <CheckCircle2 size={13} />
                  ) : (
                    <LoaderCircle size={13} className="spin" />
                  )}
                  <span>{t.text}</span>
                </div>
              ))}
            </div>
          )}
          {error && (
            <div className="notice amber" role="alert">
              <p>
                {error}{" "}
                <button
                  className="text-button"
                  onClick={() => {
                    const last = messages
                      .filter((m) => m.role === "user")
                      .at(-1);
                    setInput(last?.text || "");
                  }}
                >
                  重新编辑问题
                </button>
              </p>
            </div>
          )}
          <div ref={end} />
        </div>
        <form
          className="chat-input-area"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <div className="chat-input">
            <input
              ref={field}
              maxLength={4000}
              aria-label="输入你的问题"
              placeholder="把你的想法告诉我…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
            {busy ? (
              <button
                type="button"
                aria-label="停止回答"
                onClick={() => {
                  controller.current?.abort();
                }}
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                type="submit"
                aria-label="发送对话"
                disabled={!input.trim()}
              >
                <Send size={17} />
              </button>
            )}
          </div>
          <small>
            {isMock
              ? "本地演示回复 · 未连接真实模型"
              : "模型生成内容，请结合原始来源核对"}{" "}
            · 普通问答不作为已校验的正式报考建议
          </small>
        </form>
      </section>
      {evidence && (
        <Modal title="回答引用的依据" onClose={() => setEvidence(null)}>
          <Evidence ids={evidence} />
        </Modal>
      )}
    </>
  );
}
