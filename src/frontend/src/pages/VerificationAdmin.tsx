import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";
import { hasPermission, type Verification } from "../types";
import { PageTitle, Empty } from "../components";
import { beijingTime, errorText } from "../transport";
export default function VerificationAdmin() {
  const { data } = useApp();
  const [rows, setRows] = useState<Verification[]>([]),
    [selected, setSelected] = useState<Verification | null>(null),
    [original, setOriginal] = useState(""),
    [reason, setReason] = useState(""),
    [scope, setScope] = useState(""),
    [ack, setAck] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const selection = useRef(0);
  useEffect(
    () => () => {
      selection.current++;
    },
    [],
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const allowed = hasPermission(data.user, "verification:review");
  async function load(append = false) {
    try {
      const page = await api.verificationQueue(append ? cursor : null);
      setRows((rows) => (append ? [...rows, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    if (allowed) void load();
  }, [allowed]);
  useEffect(
    () => () => {
      if (original) URL.revokeObjectURL(original);
    },
    [original],
  );
  async function select(v: Verification) {
    const current = ++selection.current;
    setSelected(v);
    setReason("");
    setScope("");
    setAck(false);
    setOriginal("");
    setError("");
    try {
      const blob = await api.verificationDocument(v.id);
      if (current === selection.current) setOriginal(URL.createObjectURL(blob));
    } catch (e) {
      if (current === selection.current) setError(errorText(e));
    }
  }
  async function decide(decision: "approve" | "reject") {
    if (!selected) return;
    setBusy(true);
    try {
      await api.decideVerification(
        selected.id,
        decision,
        reason,
        scope,
        selected.version || 1,
      );
      setSelected(null);
      setOriginal("");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!allowed)
    return (
      <Empty text="需要学校认证审核权限，注册通过不代表已进行学校认证。" />
    );
  return (
    <>
      <PageTitle
        eyebrow="STUDENT VERIFICATION"
        title="学校身份认证审核"
        description="与注册审核、内容审核相互独立，确认学校及证明范围后才授予学校认证。"
      />
      {error && (
        <p className="notice amber" role="alert">
          {error}
        </p>
      )}
      <button className="button" onClick={() => void load()}>
        刷新认证队列
      </button>
      <div className="registration-review">
        <aside className="panel">
          {rows.map((v) => (
            <button
              className="review-application"
              key={v.id}
              onClick={() => void select(v)}
            >
              <strong>
                {data.schools.find((s) => s.id === v.schoolId)?.name ||
                  v.schoolId}
              </strong>
              <span>{v.documentName || "学校证明"}</span>
              <small>{beijingTime(v.submittedAt)}</small>
            </button>
          ))}
          {!rows.length && <Empty text="暂无待审学校认证" />}
          {cursor && (
            <button className="button" onClick={() => void load(true)}>
              加载更多认证
            </button>
          )}
        </aside>
        <section className="panel">
          {selected ? (
            <>
              <h2>学校 {selected.schoolId}</h2>
              <p>
                申请 {selected.id} · v{selected.version || 1}
              </p>
              {original ? (
                <a href={original} target="_blank" rel="noreferrer">
                  打开受保护的原始证明材料
                </a>
              ) : (
                <p>未能加载原件，不能批准。</p>
              )}
              <label className="switch-label">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />{" "}
                我已查看原始证明材料
              </label>
              <label>
                认证范围
                <input
                  value={scope}
                  onChange={(e) => setScope(e.target.value)}
                  placeholder="如：本校在读学生，某届某专业大类"
                />
              </label>
              <label>
                审核理由
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <div className="form-actions">
                <button
                  className="button gold-button"
                  disabled={busy || !original || !ack || !scope.trim()}
                  onClick={() => void decide("approve")}
                >
                  批准此学校范围认证
                </button>
                <button
                  className="button danger"
                  disabled={busy || !reason.trim()}
                  onClick={() => void decide("reject")}
                >
                  驳回并说明原因
                </button>
              </div>
            </>
          ) : (
            <Empty text="请选择一份学校认证申请" />
          )}
        </section>
      </div>
    </>
  );
}
