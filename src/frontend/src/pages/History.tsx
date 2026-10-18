import { useEffect, useState } from "react";
import { api } from "../api";
import { useApp } from "../store";
import { PageTitle, Empty } from "../components";
import type { HistoryEntry, PersonalMemory } from "../types";
import { errorText, beijingTime } from "../transport";
import { runLabels } from "../workflow-domain";
export default function History() {
  const { data, navigate, refresh } = useApp();
  const [history, setHistory] = useState<HistoryEntry[]>([]),
    [memories, setMemories] = useState<PersonalMemory[]>([]),
    [sharing, setSharing] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [clear, setClear] = useState(false);
  async function load() {
    setError("");
    try {
      const [h, m, c] = await Promise.all([
        api.history(),
        api.memories(),
        api.sharing(),
      ]);
      setHistory(h);
      setMemories(m);
      setSharing(c.enabled);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    if (data.user) void load();
  }, [data.user?.id]);
  if (!data.user)
    return (
      <Empty
        text="请先登录以查看本人的历史与授权。"
        action="前往登录"
        onAction={() => navigate("/me")}
      />
    );
  return (
    <>
      <PageTitle
        eyebrow="YOUR HISTORY, YOUR CHOICE"
        title="航行历史与偏好"
        description="历史任务可以恢复。个人画像用途授权与跨用户案例共享授权相互独立，默认不共享。"
      />
      {error && (
        <div className="notice amber" role="alert">
          <p>{error}</p>
        </div>
      )}
      <section className="panel">
        <h2>历史推荐任务</h2>
        {history.map((h) => (
          <button
            className="history-row"
            key={h.runId}
            onClick={() => {
              sessionStorage.setItem("nv-last-run:" + data.user!.id, h.runId);
              navigate("/routes");
            }}
          >
            <span>{h.question}</span>
            <small>
              {runLabels[h.status]} · {beijingTime(h.createdAt)} · 画像{" "}
              {h.profileVersionId || "无"}
            </small>
          </button>
        ))}
        {!history.length && <Empty text="尚无推荐任务" />}
      </section>
      <section className="panel">
        <h2>个人偏好记忆</h2>
        <p className="muted">
          重要偏好变更需要你确认，不会覆盖当前明确填写的条件。
        </p>
        {memories.map((m) => (
          <form
            className="memory-row"
            key={m.id}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.updateMemory(m);
                await load();
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              {m.field}
              <input
                value={m.value}
                onChange={(e) =>
                  setMemories((items) =>
                    items.map((x) =>
                      x.id === m.id ? { ...x, value: e.target.value } : x,
                    ),
                  )
                }
              />
            </label>
            <span>
              {m.confirmed ? "已确认" : "待确认"} · v{m.version}
            </span>
            <button className="button" disabled={busy}>
              确认修改
            </button>
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={async () => {
                try {
                  await api.deleteMemory(m.id);
                  await load();
                } catch (e) {
                  setError(errorText(e));
                }
              }}
            >
              删除此记忆
            </button>
          </form>
        ))}
        {!memories.length && <p className="muted">暂无提取的偏好记忆。</p>}
      </section>
      <section className="panel">
        <h2>跨用户案例共享授权</h2>
        <p>
          仅允许分享经后端去标识处理的案例摘要。原始对话和注册／学校证明材料不应进入共享资料。
        </p>
        <label className="switch-label">
          <input
            type="checkbox"
            checked={sharing}
            disabled={busy}
            onChange={async (e) => {
              const enabled = e.target.checked;
              setBusy(true);
              try {
                await api.setSharing(enabled);
                setSharing(enabled);
              } catch (e) {
                setError(errorText(e));
              } finally {
                setBusy(false);
              }
            }}
          />{" "}
          {sharing ? "已授权共享，可随时撤回" : "未授权共享"}
        </label>
        <p className="muted">
          撤回后应立即停止新的检索，后端异步清理相关向量与缓存。
        </p>
      </section>
      <section className="panel">
        <h2>清除本人数据</h2>
        <p className="muted">
          清除画像、收藏、草案、本人任务和共享授权；正式环境的审计保留边界由后端隐私规则确定。
        </p>
        {clear ? (
          <>
            <p className="warning-text">
              请确认清除。这会移除本地演示数据或请求后端清除本人数据。
            </p>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.deleteProfile();
                  await refresh();
                  await load();
                  setClear(false);
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              确认清除
            </button>
            <button className="text-button" onClick={() => setClear(false)}>
              取消
            </button>
          </>
        ) : (
          <button className="text-button danger" onClick={() => setClear(true)}>
            清除个人数据
          </button>
        )}
      </section>
    </>
  );
}
