import { errorText } from "../transport";
import { useState } from "react";
import { ArrowRight, Compass } from "lucide-react";
import { api, isMock } from "../api";
import { loginDestination } from "../auth";
import { useApp } from "../store";

export default function Login() {
  const { update, notify, navigate } = useApp();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <section className="login-page" aria-labelledby="login-title">
      <div className="panel login-panel">
        <Compass size={38} strokeWidth={1.2} aria-hidden="true" />
        <p className="eyebrow">NIGHT VOYAGE</p>
        <h1 id="login-title">登录夜航</h1>
        <p className="muted">用你的账号，继续探索。</p>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              const user = await api.login(identifier, password);
              // Clear the previous account's personal view before loading this session.
              update({
                user,
                profile: null,
                favorites: [],
                verifications: [],
                posts: [],
                plan: { id: "", name: "我的志愿草案", version: 1, entries: [] },
              });
              localStorage.removeItem("nv-compare");
              sessionStorage.removeItem("nv-question");
              const snapshot = await api.bootstrap();
              if (!snapshot.user || snapshot.user.id !== user.id)
                throw new Error("登录状态未能同步，请重新登录");
              update(snapshot);
              setPassword("");
              notify("已登录");
              navigate(loginDestination(snapshot.user));
            } catch (e) {
              setError(errorText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label htmlFor="login-identifier">邮箱或用户 ID</label>
          <input
            id="login-identifier"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            maxLength={254}
            value={identifier}
            disabled={busy}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="输入邮箱或系统分配的用户 ID"
          />
          <label htmlFor="login-password">密码</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p className="warning-text" role="alert">
              {error}
            </p>
          )}
          <button className="button gold-button" type="submit" disabled={busy}>
            {busy ? "正在登录…" : "登录"}
            <ArrowRight size={16} />
          </button>
        </form>
        <div className="form-actions">
          <button className="text-button" onClick={() => navigate("/register")}>
            申请注册
          </button>
          <button
            className="text-button"
            onClick={() => navigate("/application")}
          >
            查询申请状态
          </button>
        </div>
        {isMock && (
          <p className="form-hint">
            当前为本地演示，请使用项目说明中的演示账号。
          </p>
        )}
        <button
          className="text-button"
          disabled={busy}
          onClick={() => navigate("/explore")}
        >
          先逛一逛
        </button>
      </div>
    </section>
  );
}
