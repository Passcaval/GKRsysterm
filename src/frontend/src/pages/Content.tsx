import { useState, useEffect } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  BookOpen,
  MapPin,
  Heart,
  ShieldCheck,
  AlertTriangle,
  ThumbsUp,
  Flag,
  ExternalLink,
} from "lucide-react";
import { useApp } from "../store";
import { api } from "../api";
import {
  SignalBadge,
  Modal,
  Evidence,
  SchoolCard,
  Empty,
  SectionTitle,
} from "../components";
import type { Post, School } from "../types";
import { campusPosts } from "../campus";
import { CampusSky } from "../CampusSky";
function Echoes({ school }: { school: School }) {
  const { data, navigate } = useApp();
  const [topic, setTopic] = useState("全部回声");
  const [strong, setStrong] = useState(false);
  const [query, setQuery] = useState("");
  const allPosts = campusPosts(data.posts, school.id);
  const posts = campusPosts(data.posts, school.id, topic, strong, query);
  useEffect(() => {
    localStorage.setItem("nv-echo-school", school.id);
  }, [school.id]);
  return (
    <div className="campus-board">
      <CampusSky school={school} count={allPosts.length} />
      <div className="campus-board-layout">
        <section
          className="campus-letters"
          aria-label={`${school.name}的校园来信`}
        >
          <div className="campus-board-heading">
            <div>
              <span className="eyebrow">LETTERS FROM THIS CAMPUS</span>
              <h2>本校的日常与回声</h2>
            </div>
            <span className="muted">只展示本校已公开内容</span>
          </div>
          <div className="echo-toolbar">
            <div className="chips">
              {[
                "全部回声",
                "专业与学风",
                "校园生活",
                "转专业",
                "住宿与食堂",
                "吐槽避雷",
              ].map((t) => (
                <button
                  className={topic === t ? "active" : ""}
                  key={t}
                  onClick={() => setTopic(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <label className="switch-label">
              <input
                type="checkbox"
                checked={strong}
                onChange={(e) => setStrong(e.target.checked)}
              />
              只看强信号
            </label>
          </div>
          <div className="toolbar">
            <input
              className="wide-input"
              aria-label="搜索回声"
              placeholder={`搜索${school.name}的校园来信…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="muted">
              {posts.length} / {allPosts.length} 封来信
            </span>
          </div>
          <div className="letter-grid echo-wall">
            {posts.map((p, i) => (
              <button
                className={`letter letter-${i % 3}`}
                key={p.id}
                onClick={() => navigate("/post/" + p.id)}
              >
                <div className="letter-top">
                  <span>
                    {data.schools.find((s) => s.id === p.schoolId)?.name}
                  </span>
                  <span className="postmark">
                    来自校园
                    <br />
                    {p.year} · VOICE
                  </span>
                </div>
                <span className="letter-topic">{p.topic}</span>
                <h3>{p.title}</h3>
                <p>{p.excerpt}</p>
                <div className="letter-author">
                  {p.author}
                  <small>
                    {" "}
                    {p.helpful} 人觉得有帮助 · 被引用 {p.citations} 次
                  </small>
                </div>
                <div className="letter-bottom">
                  <SignalBadge signal={p.signal} />
                  <ArrowUpRight size={17} />
                </div>
              </button>
            ))}
          </div>
          {!posts.length && (
            <Empty
              text={
                allPosts.length
                  ? "没有符合条件的本校来信，试着调整筛选。"
                  : `${school.name}还没有公开来信，欢迎留下第一份校园经历。`
              }
              action={allPosts.length ? "重置筛选" : "写下本校回声"}
              onAction={() => {
                if (allPosts.length) {
                  setTopic("全部回声");
                  setStrong(false);
                  setQuery("");
                } else navigate("/lighthouse");
              }}
            />
          )}
          <div className="notice">
            <ShieldCheck size={18} />
            <p>
              信号强度是帮助判断的线索，不是真实性的保证。涉及招生政策，请核对官方最新发布。
            </p>
          </div>
        </section>
        <aside className="campus-information" aria-label="本校信息栏">
          <div className="panel campus-info-card">
            <span className="eyebrow">YOUR CURRENT CAMPUS</span>
            <span
              className="school-seal"
              style={{ color: school.color, borderColor: school.color }}
            >
              {school.short}
            </span>
            <h2>{school.name}</h2>
            <p className="muted">{school.description}</p>
            <dl>
              <div>
                <dt>所在城市</dt>
                <dd>
                  {school.province} · {school.city}
                </dd>
              </div>
              <div>
                <dt>院校类型</dt>
                <dd>{school.type}</dd>
              </div>
              <div>
                <dt>院校层次</dt>
                <dd>{school.level}</dd>
              </div>
              <div>
                <dt>校园来信</dt>
                <dd>{allPosts.length} 封</dd>
              </div>
            </dl>
            <h3>在这里探索</h3>
            <div className="campus-major-chips">
              {school.majors.map((m) => (
                <span key={m}>{m}</span>
              ))}
            </div>
            <button
              className="button"
              onClick={() => navigate("/school/" + school.id)}
            >
              查看院校档案 <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="panel campus-invitation">
            <span className="eyebrow">LEAVE A LIGHT BEHIND</span>
            <h3>你也在这里生活吗？</h3>
            <p>写下具体的校园经历，给下一位抵达的人留一束光。</p>
            <button
              className="button gold-button"
              onClick={() => navigate("/lighthouse")}
            >
              写下本校回声 <ArrowUpRight size={14} />
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
function TrustPanel({ post }: { post: Post }) {
  const { notify } = useApp();
  const [appeal, setAppeal] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const names = [
    "身份认证",
    "内容具体度",
    "交叉印证",
    "信息时效",
    "异常安全度",
  ];
  const values = [
    post.trust.identity,
    post.trust.specificity,
    post.trust.corroboration,
    post.trust.freshness,
    post.trust.anomaly,
  ];
  return (
    <aside className="trust-panel panel">
      <span className="eyebrow">SIGNAL REPORT · {post.trust.version}</span>
      <div className="trust-heading">
        <ShieldCheck size={25} />
        <h2>这封来信，可信吗？</h2>
      </div>
      <SignalBadge signal={post.signal} />
      <p className="muted">
        {post.author} · {post.year} 年发布
      </p>
      {names.map((name, i) => (
        <div className="trust-metric" key={name}>
          <div>
            <span>{name}</span>
            <b>
              {values[i]}
              <small>/100</small>
            </b>
          </div>
          <div className="meter">
            <span style={{ width: values[i] + "%" }} />
          </div>
          <p>{post.trust.explanation[i]}</p>
        </div>
      ))}
      <div className="corroboration">
        <span>{post.trust.supporting} 篇支持</span>
        <span>{post.trust.opposing} 篇不同体验</span>
      </div>
      {new Date(post.trust.expiresAt) < new Date() && (
        <div className="notice amber">
          <AlertTriangle size={17} />
          <p>核验时效已过，相关政策可能发生变化。</p>
        </div>
      )}
      <button className="text-button" onClick={() => setAppeal(true)}>
        <Flag size={14} />
        我认为评分有出入
      </button>
      {appeal && (
        <Modal title="申请重新核验" onClose={() => setAppeal(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api.feedback(post.id, "appeal", reason);
                notify("复核意见已提交");
                setAppeal(false);
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              请说明你发现的出入
              <textarea
                required
                minLength={10}
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="提供具体事实、年份或可核验的来源（至少10字）"
              />
            </label>
            <button className="button gold-button" disabled={busy}>
              {busy ? "正在提交…" : "提交复核意见"}
            </button>
          </form>
        </Modal>
      )}
    </aside>
  );
}
function PostDetail({ post }: { post: Post }) {
  const { data, navigate, notify } = useApp();
  const [evidence, setEvidence] = useState(false);
  const [folded, setFolded] = useState(post.signal === "disputed");
  return (
    <>
      <button
        className="text-button back"
        onClick={() => navigate("/echoes/" + encodeURIComponent(post.schoolId))}
      >
        <ArrowLeft size={15} />
        回到回声广场
      </button>
      <div className="post-layout">
        <article className="paper post-paper">
          <div className="letter-top">
            <span>
              {data.schools.find((s) => s.id === post.schoolId)?.name} ·{" "}
              {post.topic}
            </span>
            <span className="postmark">
              校园来信
              <br />
              {post.year} · VOICE
            </span>
          </div>
          <h1>{post.title}</h1>
          <div className="post-byline">
            {post.author} <SignalBadge signal={post.signal} />
          </div>
          {post.status !== "published" && (
            <p className="warning-text">此内容尚未公开，仅供审核与作者预览。</p>
          )}
          {folded ? (
            <div className="notice amber">
              <p>
                此内容存在疑点，默认折叠。请结合鉴定依据谨慎阅读。
                <button
                  className="text-button"
                  onClick={() => setFolded(false)}
                >
                  展开原文
                </button>
              </p>
            </div>
          ) : (
            <div className="post-body">
              {post.body.split("\n\n").map((t, i) => (
                <p key={i}>{t}</p>
              ))}
            </div>
          )}
          <div className="paper-note">
            一段经历只能照亮一部分校园。多听几种声音，再做自己的判断。
          </div>
          <div className="post-actions">
            <button
              onClick={async () => {
                try {
                  await api.feedback(post.id, "helpful");
                  notify("反馈已记录，谢谢你的参与");
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              <ThumbsUp size={15} />
              有帮助 · {post.helpful}
            </button>
            <button
              onClick={async () => {
                try {
                  await api.feedback(post.id, "disagree");
                  notify("已记录不同体验");
                } catch (e) {
                  notify((e as Error).message);
                }
              }}
            >
              我有不同体验
            </button>
            <button onClick={() => setEvidence(true)}>
              查看引用来源
              <ExternalLink size={13} />
            </button>
          </div>
        </article>
        <TrustPanel post={post} />
      </div>
      {evidence && (
        <Modal title="这封来信的证据" onClose={() => setEvidence(false)}>
          <Evidence ids={post.sourceIds} />
        </Modal>
      )}
    </>
  );
}
function SchoolDetail({ school: s }: { school: School }) {
  const { data, navigate, notify } = useApp();
  const [tab, setTab] = useState("官方数据");
  const [sources, setSources] = useState(false);
  const echoes = data.posts.filter(
    (p) => p.schoolId === s.id && p.status === "published",
  );
  function compare() {
    let ids: string[] = [];
    try {
      ids = JSON.parse(localStorage.getItem("nv-compare") || "[]");
    } catch {}
    if (!ids.includes(s.id)) {
      if (ids.length === 4) {
        notify("对比舱最多放入 4 所院校");
        return;
      }
      ids.push(s.id);
      localStorage.setItem("nv-compare", JSON.stringify(ids));
    }
    navigate("/compare");
  }
  return (
    <>
      <button className="text-button back" onClick={() => navigate("/explore")}>
        <ArrowLeft size={15} />
        回到院校星图
      </button>
      <section className="school-cover">
        <span
          className="school-seal big"
          style={{ color: s.color, borderColor: s.color }}
        >
          {s.short}
        </span>
        <div>
          <span className="eyebrow">UNIVERSITY PROFILE</span>
          <h1>{s.name}</h1>
          <p>
            <MapPin size={14} />
            {s.province} · {s.city}
            <span>{s.level}</span>
            <span>{s.type}</span>
          </p>
        </div>
        <div className="school-cover-quote">{s.description}</div>
      </section>
      <div className="school-detail-grid">
        <div>
          <div className="tabs">
            {["官方数据", "招生专业", "校园回声"].map((t) => (
              <button
                className={tab === t ? "active" : ""}
                key={t}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          {tab === "官方数据" ? (
            <>
              <section className="panel">
                <SectionTitle title="历年录取参考">
                  <span className="source-tag official">官方数据层 · 示例</span>
                </SectionTitle>
                <p className="muted">
                  当前展示：浙江 · 普通本科 ·
                  物理与化学要求示例。未对应真实专业组，不能直接比较或填报。
                </p>
                <div className="trend-chart">
                  <svg
                    viewBox="0 0 600 150"
                    role="img"
                    aria-label="2023至2025年示例录取位次趋势"
                  >
                    <defs>
                      <linearGradient id="trend" x1="0" y1="0" x2="0" y2="1">
                        <stop stopColor="#d6bd86" stopOpacity=".25" />
                        <stop offset="1" stopColor="#d6bd86" stopOpacity="0" />
                      </linearGradient>
                    </defs>
                    <path
                      d="M45 50 L300 83 L550 112 L550 145 L45 145 Z"
                      fill="url(#trend)"
                    />
                    <path
                      d="M45 50 L300 83 L550 112"
                      stroke="#d6bd86"
                      fill="none"
                      strokeWidth="2"
                    />
                    {s.history.map((h, i) => (
                      <g key={h.year}>
                        <circle
                          cx={[45, 300, 550][i]}
                          cy={[50, 83, 112][i]}
                          r="4"
                          fill="#d6bd86"
                        />
                        <text
                          x={[45, 300, 550][i]}
                          y={[35, 68, 97][i]}
                          fill="#e8e7e0"
                          textAnchor="middle"
                          fontSize="13"
                        >
                          {h.rank.toLocaleString()}
                        </text>
                      </g>
                    ))}
                  </svg>
                </div>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>招生年份</th>
                        <th>示例最低分</th>
                        <th>示例位次</th>
                        <th>来源</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.history.map((h) => (
                        <tr key={h.year}>
                          <td>{h.year}</td>
                          <td>{h.score}</td>
                          <td>{h.rank.toLocaleString()}</td>
                          <td>
                            <button
                              className="text-button"
                              onClick={() => setSources(true)}
                            >
                              查看出处
                              <ArrowUpRight size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
              <div className="notice amber">
                <AlertTriangle size={18} />
                <p>
                  示例差异提示：学校政策的适用条件与学生亲历的执行体验可能不同，请同时阅读两侧信息，以官方当年政策为准。
                </p>
              </div>
            </>
          ) : tab === "招生专业" ? (
            <div className="panel">
              <h2>专业与报考条件</h2>
              {s.majors.map((m) => (
                <div className="major-row" key={m}>
                  <BookOpen size={20} />
                  <div>
                    <h3>{m}</h3>
                    <p>
                      示例选科要求：{s.requiredSubjects.join(" + ")} · 学费{" "}
                      {s.tuition} 元/年
                    </p>
                  </div>
                  <button
                    className="text-button"
                    onClick={() => setSources(true)}
                  >
                    核对条件
                    <ArrowUpRight size={14} />
                  </button>
                </div>
              ))}
              <p className="muted">
                专业组代码、计划人数、校区与限制条件应由正式招生数据返回。
              </p>
            </div>
          ) : (
            <div className="letter-grid single">
              <button
                className="button gold-button"
                onClick={() => navigate("/echoes/" + encodeURIComponent(s.id))}
              >
                前往这所院校的回声广场 <ArrowUpRight size={15} />
              </button>
              {echoes.map((p) => (
                <button
                  className="letter"
                  key={p.id}
                  onClick={() => navigate("/post/" + p.id)}
                >
                  <SignalBadge signal={p.signal} />
                  <h3>{p.title}</h3>
                  <p>{p.excerpt}</p>
                </button>
              ))}
              {!echoes.length && <Empty text="暂无已发布的校园回声。" />}
            </div>
          )}
        </div>
        <aside>
          <SchoolCard school={s} />
          <div className="panel mini-panel">
            <span className="eyebrow">LISTEN TO THEIR VOICES</span>
            <h3>在这里生活，是怎样的体验？</h3>
            {echoes.slice(0, 2).map((p) => (
              <button
                className="echo-mini"
                key={p.id}
                onClick={() => navigate("/post/" + p.id)}
              >
                <SignalBadge signal={p.signal} />
                <p>{p.title}</p>
                <small>
                  {p.year} · {p.author}
                </small>
              </button>
            ))}
            {!echoes.length && (
              <p className="muted">还没有来自这所学校的信。</p>
            )}
          </div>
        </aside>
      </div>
      <div className="detail-actions">
        <button className="button" onClick={compare}>
          加入对比舱
          <ArrowUpRight size={15} />
        </button>
        <button
          className="button gold-button"
          onClick={() => navigate("/workbench")}
        >
          打开志愿工作台
          <ArrowUpRight size={15} />
        </button>
      </div>
      {sources && (
        <Modal title="官方数据来源与适用范围" onClose={() => setSources(false)}>
          <Evidence ids={s.sourceIds} />
        </Modal>
      )}
    </>
  );
}
export default function Content({ path }: { path: string }) {
  const { data, navigate } = useApp();
  if (path === "/echoes" || path.startsWith("/echoes/")) {
    const requested = path.split("/")[2];
    const remembered = localStorage.getItem("nv-echo-school");
    const school = requested
      ? data.schools.find((s) => encodeURIComponent(s.id) === requested)
      : data.schools.find((s) => s.id === remembered) ||
        data.schools.find((s) => campusPosts(data.posts, s.id).length) ||
        data.schools[0];
    return school ? (
      <Echoes key={school.id} school={school} />
    ) : (
      <Empty
        text="该院校不存在或已下线。"
        action="返回院校星图"
        onAction={() => navigate("/explore")}
      />
    );
  }
  if (path.startsWith("/school/")) {
    const s = data.schools.find((s) => s.id === path.split("/")[2]);
    return s ? (
      <SchoolDetail school={s} />
    ) : (
      <Empty text="院校不存在或已下线。" />
    );
  }
  const p = data.posts.find((p) => p.id === path.split("/")[2]);
  const canSee =
    p &&
    (p.status === "published" || data.user?.role === "reviewer" || p.isMine);
  return canSee ? (
    <PostDetail post={p} />
  ) : (
    <Empty text="来信不存在，或尚未公开。" />
  );
}
