import { useEffect, useState } from "react";
import { api } from "../api";
import { errorText } from "../transport";
import type { AdmissionKnowledgeSummary } from "../types";

const labels: Record<string, string> = {
  queued: "等待同步",
  running: "同步中",
  succeeded: "同步完成",
  failed: "同步失败",
};

export default function KnowledgeAdmin() {
  const [status, setStatus] = useState<AdmissionKnowledgeSummary | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const running =
    status?.latestJob?.status === "queued" ||
    status?.latestJob?.status === "running";
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = () =>
      api
        .admissionKnowledge()
        .then((value) => {
          if (active) {
            setStatus(value);
            if (["queued", "running"].includes(value.latestJob?.status || ""))
              timer = setTimeout(load, 10000);
          }
        })
        .catch((e) => {
          if (active) setError(errorText(e));
        });
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [busy]);
  return (
    <section className="panel" aria-label="联网招生知识库">
      <span className="eyebrow">ADMISSIONS KNOWLEDGE</span>
      <h2>联网招生知识库</h2>
      <p className="muted">
        DeepSeek
        搜索官方招生网页，保存带时间和出处的正文。领航员按问题更新资料；网页信息不会直接写入正式招生单位或投档模拟。
      </p>
      {status && (
        <p>
          {status.configured
            ? status.sourceCount +
              " 份资料快照 · 缓存 " +
              status.ttlHours +
              " 小时"
            : "尚未启用或配置 DeepSeek 联网服务"}
        </p>
      )}
      {status?.latestJob && (
        <p role="status">
          最近同步：{labels[status.latestJob.status] || status.latestJob.status}
          {status.latestJob.error ? "（" + status.latestJob.error + "）" : ""}
        </p>
      )}
      {error && (
        <p className="warning-text" role="alert">
          {error}
        </p>
      )}
      <button
        className="button"
        disabled={!status?.configured || busy || running}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await api.syncAdmissionKnowledge(crypto.randomUUID());
          } catch (e) {
            setError(errorText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy || running ? "正在更新资料…" : "更新联网招生资料"}
      </button>
    </section>
  );
}
