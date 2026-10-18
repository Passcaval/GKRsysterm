import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from "react";
import type { Bootstrap } from "./types";
import { api } from "./api";
import { onSessionReset, sessionEpoch, errorText } from "./transport";
interface State {
  data: Bootstrap;
  refresh: () => Promise<void>;
  update: (value: Partial<Bootstrap>) => void;
  notify: (text: string) => void;
  navigate: (path: string) => void;
}
const Context = createContext<State | null>(null);
export function useApp() {
  const c = useContext(Context);
  if (!c) throw new Error("缺少应用上下文");
  return c;
}
export function Provider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current,
      epoch = sessionEpoch();
    setError("");
    try {
      const value = await api.bootstrap();
      if (current === generation.current && epoch === sessionEpoch())
        setData(value);
    } catch (e) {
      if (current === generation.current) setError(errorText(e));
    }
  }, []);
  useEffect(
    () =>
      onSessionReset(() => {
        generation.current++;
        setData((d) =>
          d
            ? {
                ...d,
                user: null,
                profile: null,
                favorites: [],
                verifications: [],
                sources: [],
                posts: d.posts
                  .filter((p) => p.status === "published" && !p.isMine)
                  .map((p) => ({ ...p, isMine: false })),
                plan: {
                  id: "anonymous",
                  name: "我的志愿草案",
                  version: 0,
                  entries: [],
                },
              }
            : d,
        );
        location.hash = "/login";
      }),
    [],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(""), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  if (!data)
    return (
      <div className="boot">
        <div className="brand-mark">✧</div>
        <h1>夜航 Night Voyage</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={() => void refresh()}>重新连接</button>
          </>
        ) : (
          <p>正在展开你的探索地图…</p>
        )}
      </div>
    );
  return (
    <Context.Provider
      value={{
        data,
        refresh,
        update: (v) => setData((d) => (d ? { ...d, ...v } : d)),
        notify: setToast,
        navigate: (p) => {
          location.hash = p;
          window.scrollTo(0, 0);
        },
      }}
    >
      {error && (
        <div className="session-error" role="alert">
          <span>{error}</span>
          <button onClick={() => void refresh()}>重试加载</button>
        </div>
      )}
      <div key={data.user?.id || "anonymous"}>{children}</div>
      {toast && (
        <div className="toast" role="status">
          {toast}
          <button aria-label="关闭通知" onClick={() => setToast("")}>
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
