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
import type { ChatMessage } from "../types";
export default function Chat({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [trace, setTrace] = useState<
    { tool: string; text: string; done: boolean }[]
  >([]);
  const [error, setError] = useState("");
  const [conversation, setConversation] = useState<string>();
  const [evidence, setEvidence] = useState<string[] | null>(null);
  const controller = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
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
    setMessages((m) => [
      ...m,
      { role: "user", text, sourceIds: [] },
      { role: "assistant", text: "", sourceIds: [] },
    ]);
    const c = new AbortController();
    controller.current = c;
    try {
      for await (const e of api.chat(text, conversation, c.signal)) {
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
        if (e.type === "done") setConversation(e.conversationId);
      }
    } catch (e) {
      if (!c.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
              "button:not(:disabled),input,a[href],textarea",
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
            <small>数据有出处，建议有依据。</small>
          </div>
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
            <p>告诉我你的分数、喜欢的专业，或一所让你心动的学校。</p>
            <div className="chips">
              {[
                "适合我的计算机院校有哪些？",
                "如何判断一篇校园体验是否可信？",
              ].map((q) => (
                <button key={q} onClick={() => setInput(q)}>
                  {q}
                  <ArrowUpRight size={12} />
                </button>
              ))}
            </div>
          </div>
          {messages.map((m, i) => (
            <article key={i} className={`chat-message ${m.role}`}>
              <span className="message-role">
                {m.role === "assistant" ? "✧ 领航员 · 模型生成" : "你"}
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
            · 最终以官方招生政策为准
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
