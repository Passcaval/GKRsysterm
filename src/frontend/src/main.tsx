import { StrictMode, lazy, Suspense, useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  Compass,
  Telescope,
  Mail,
  Route,
  Columns3,
  ListOrdered,
  UserRound,
  Sparkles,
  ArrowUpRight,
  Anchor,
  ShieldCheck,
  ChevronRight,
  Menu,
} from "lucide-react";
import { Provider, useApp } from "./store";
import { isMock } from "./api";
import { canReview } from "./auth";
import { Home } from "./pages/Explore";
import { Explore } from "./pages/Atlas";
import "./styles.css";
import "./voyage.css";
import "./campus.css";
const Content = lazy(() => import("./pages/Content"));
const Planning = lazy(() => import("./pages/Planning"));
const Account = lazy(() => import("./pages/Account"));
const Chat = lazy(() => import("./pages/Chat"));
const Login = lazy(() => import("./pages/Login"));
const nav = [
  { path: "/", label: "启航", en: "Overview", icon: Compass },
  { path: "/explore", label: "院校星图", en: "Explore", icon: Telescope },
  { path: "/echoes", label: "回声广场", en: "Real voices", icon: Mail },
  { path: "/routes", label: "我的航线", en: "Recommendations", icon: Route },
  { path: "/compare", label: "对比舱", en: "Compare", icon: Columns3 },
  {
    path: "/workbench",
    label: "志愿工作台",
    en: "Workspace",
    icon: ListOrdered,
  },
];
function App() {
  const { data, navigate: routeNavigate } = useApp();
  const [path, setPath] = useState(location.hash.slice(1) || "/");
  const [chat, setChat] = useState(false);
  const [menu, setMenu] = useState(false);
  const pinnedMenu = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }
  function closeMenu() {
    cancelClose();
    pinnedMenu.current = false;
    setMenu(false);
  }
  function navigate(path: string) {
    closeMenu();
    routeNavigate(path);
  }
  function hoverMenu() {
    cancelClose();
    setMenu(true);
  }
  function leaveMenu() {
    cancelClose();
    if (!pinnedMenu.current)
      closeTimer.current = setTimeout(() => setMenu(false), 220);
  }
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menu) {
        closeMenu();
        menuButton.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      cancelClose();
    };
  }, [menu]);
  useEffect(() => {
    const handle = () => {
      setPath(location.hash.slice(1) || "/");
      closeMenu();
    };
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "/" &&
        !(e.target instanceof HTMLInputElement) &&
        !(e.target instanceof HTMLTextAreaElement) &&
        !(e.target instanceof HTMLSelectElement)
      ) {
        e.preventDefault();
        setChat(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const title =
    nav.find((n) => n.path === path)?.label ||
    {
      "/profile": "考生档案",
      "/lighthouse": "灯塔计划",
      "/admin": "审核工作台",
      "/me": "我的夜航",
      "/login": "登录夜航",
    }[path] ||
    (path.startsWith("/echoes/")
      ? "回声广场"
      : path.startsWith("/school/")
        ? "院校档案"
        : "一封校园来信");
  return (
    <div
      className={`app drawer-layout ${path === "/explore" ? "atlas-page" : ""}`}
    >
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById("main")?.focus();
          document.getElementById("main")?.scrollIntoView();
        }}
      >
        跳转到主要内容
      </a>
      <button
        ref={menuButton}
        className={`global-menu ${menu ? "is-open" : ""}`}
        aria-label={menu ? "关闭主导航" : "打开主导航"}
        aria-expanded={menu}
        aria-controls="main-navigation"
        onMouseEnter={hoverMenu}
        onMouseLeave={leaveMenu}
        onClick={() => {
          if (pinnedMenu.current) closeMenu();
          else {
            cancelClose();
            pinnedMenu.current = true;
            setMenu(true);
          }
        }}
      >
        <Menu size={22} strokeWidth={1.5} />
      </button>
      <button
        className={`nav-scrim ${menu ? "open" : ""}`}
        aria-label="关闭导航"
        inert={!menu}
        aria-hidden={!menu}
        tabIndex={menu ? 0 : -1}
        onClick={closeMenu}
      />
      <aside
        id="main-navigation"
        className={`sidebar ${menu ? "open" : ""}`}
        inert={!menu}
        aria-hidden={!menu}
        aria-label="主导航"
        onMouseEnter={hoverMenu}
        onMouseLeave={leaveMenu}
        onKeyDown={(e) => {
          if (e.key === "Tab") {
            const elements =
              e.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              );
            const first = elements[0],
              last = elements[elements.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              menuButton.current?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              menuButton.current?.focus();
            }
          }
        }}
      >
        <button className="brand" onClick={() => navigate("/")}>
          <span className="brand-mark">
            <Compass size={32} strokeWidth={1} />
          </span>
          <span>
            夜 航<small>NIGHT VOYAGE</small>
          </span>
        </button>
        <div className="sidebar-caption">每一个选择，都有星光可循</div>
        <div className="nav-label">探索你的下一站</div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.path}
              className={
                path === n.path ||
                (n.path !== "/" && path.startsWith(n.path + "/"))
                  ? "active"
                  : ""
              }
              onClick={() => navigate(n.path)}
            >
              <n.icon size={19} strokeWidth={1.5} />
              <span>{n.label}</span>
              {(path === n.path ||
                (n.path !== "/" && path.startsWith(n.path + "/"))) && (
                <span className="active-dot" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button onClick={() => navigate("/lighthouse")}>
            <Anchor size={18} />
            <span>灯塔计划</span>
            <ArrowUpRight size={14} />
          </button>
          {canReview(data.user) && (
            <button onClick={() => navigate("/admin")}>
              <ShieldCheck size={18} />
              <span>内容审核</span>
            </button>
          )}
          <div className="sidebar-note">
            <span>✧</span>
            <p>
              你不必独自决定
              <br />
              <small>让真实的经验，为你点灯。</small>
            </p>
          </div>
          <button
            className="user"
            onClick={() => navigate(data.user ? "/me" : "/login")}
          >
            <span className="avatar">
              <UserRound size={19} />
            </span>
            <span>
              {data.user?.name || "登录"}
              <small>{data.user ? "我的夜航档案" : "保存你的探索进度"}</small>
            </span>
            <ChevronRight size={14} />
          </button>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <span>我的夜航</span>
            <ChevronRight size={12} />
            <b>{title}</b>
          </div>
          <div className="top-actions">
            <span className="demo-indicator">
              <span />
              {isMock ? "演示模式 · 非填报依据" : "在线数据"}
            </span>
          </div>
        </header>
        <div
          className="journey-progress"
          aria-label={`档案${data.profile ? "已建立" : "待完善"}，已加入${data.plan.entries.length}个志愿`}
        >
          <span
            style={{
              width: `${data.profile ? Math.min(100, 35 + data.plan.entries.length * 5) : 5}%`,
            }}
          />
        </div>
        <main id="main" tabIndex={-1}>
          <Suspense fallback={<div className="empty">正在展开页面…</div>}>
            {path === "/login" ? (
              <Login />
            ) : path === "/" ? (
              <Home openChat={() => setChat(true)} />
            ) : path === "/explore" ? (
              <Explore />
            ) : path.startsWith("/school/") ||
              path === "/echoes" ||
              path.startsWith("/echoes/") ||
              path.startsWith("/post/") ? (
              <Content path={path} />
            ) : ["/routes", "/compare", "/workbench"].includes(path) ? (
              <Planning path={path} />
            ) : (
              <Account path={path} />
            )}
          </Suspense>
          <footer>
            <span>
              ✧ NIGHT VOYAGE <b>让每一个选择，有据可循。</b>
            </span>
            <span>推荐仅供参考，最终以省级考试院与院校官方发布为准。</span>
          </footer>
        </main>
        <button className="navigator-launch" onClick={() => setChat(true)}>
          <Sparkles size={18} />
          <span>问问领航员</span>
          <kbd>/</kbd>
        </button>
        {chat && (
          <Suspense fallback={null}>
            <Chat onClose={() => setChat(false)} />
          </Suspense>
        )}
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider>
      <App />
    </Provider>
  </StrictMode>,
);
