import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from "react";
import type { Bootstrap } from "./types";
import { api } from "./api";
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
  const refresh = useCallback(async () => {
    setError("");
    try {
      setData(await api.bootstrap());
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
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
      {children}
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
