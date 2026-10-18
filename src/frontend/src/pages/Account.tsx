import {
  Me,
  Registration,
  ApplicationStatus,
  RegistrationAdmin,
} from "./Identity";
import History from "./History";
import VerificationAdmin from "./VerificationAdmin";
import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  FileCheck2,
  Upload,
  ShieldCheck,
  AlertTriangle,
  LogOut,
  Heart,
  Trash2,
  Anchor,
  UserRound,
  CheckCircle2,
  X,
  MessageSquare,
} from "lucide-react";
import { useApp } from "../store";
import { api, isMock } from "../api";
import { sampleProfile } from "../data";
import { errorText } from "../transport";
import { hasPermission } from "../types";
import { validateProfile } from "../domain";
import {
  PageTitle,
  SectionTitle,
  Modal,
  SchoolCard,
  Empty,
  SignalBadge,
  Evidence,
} from "../components";
import type { Profile, Post, User } from "../types";
function ProfilePage() {
  const { data, update, notify, navigate } = useApp();
  const [value, setValue] = useState<Profile>(
    data.profile || {
      province: "",
      year: 2026,
      score: null,
      rank: null,
      subjects: [],
      cities: [],
      interests: [],
      budget: null,
      acceptAdjustment: false,
      consent: false,
      version: 0,
    },
  );
  const [mode, setMode] = useState("steps");
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [natural, setNatural] = useState(""),
    [proposal, setProposal] = useState<Partial<Profile> | null>(null),
    [versions, setVersions] = useState<Profile[]>([]);
  function patch<K extends keyof Profile>(key: K, v: Profile[K]) {
    setValue((p) => ({ ...p, [key]: v }));
  }
  const fields = [
    <div className="form-grid" key="basic">
      <label>
        生源省份
        <select
          value={value.province}
          onChange={(e) => patch("province", e.target.value)}
        >
          <option value="">暂未填写</option>
          {[
            "浙江",
            "江苏",
            "上海",
            "北京",
            "天津",
            "河北",
            "山西",
            "内蒙古",
            "辽宁",
            "吉林",
            "黑龙江",
            "安徽",
            "福建",
            "江西",
            "山东",
            "河南",
            "湖北",
            "湖南",
            "广东",
            "广西",
            "海南",
            "重庆",
            "四川",
            "贵州",
            "云南",
            "西藏",
            "陕西",
            "甘肃",
            "青海",
            "宁夏",
            "新疆",
          ].map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label>
        报考年份
        <input
          required
          type="number"
          min="2024"
          max="2035"
          value={value.year}
          onChange={(e) => patch("year", Number(e.target.value))}
        />
      </label>
      <label>
        高考分数
        <input
          type="number"
          min="0"
          max="900"
          value={value.score ?? ""}
          onChange={(e) =>
            patch(
              "score",
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
        />
      </label>
      <label>
        省内位次
        <input
          type="number"
          min="1"
          max="5000000"
          value={value.rank ?? ""}
          onChange={(e) =>
            patch("rank", e.target.value === "" ? null : Number(e.target.value))
          }
        />
      </label>
      <p className="form-hint">
        分数和位次可以暂不填写。校园生活查询不需要成绩，风险分析会单独补问位次及口径。
      </p>
      <label>
        位次口径
        <input
          value={value.rankCohort || ""}
          onChange={(e) => patch("rankCohort", e.target.value || null)}
          placeholder="如：浙江普通类全省位次"
        />
      </label>
      <label>
        招生类别
        <input
          value={value.examCategory || "普通类"}
          onChange={(e) => patch("examCategory", e.target.value)}
        />
      </label>
    </div>,
    <div key="subjects">
      <h3>你的三门选考科目</h3>
      <p className="muted">选择 3 门，专业报考条件以招生章程为准。</p>
      <div className="subject-grid">
        {["物理", "化学", "生物", "历史", "政治", "地理"].map((s) => (
          <label
            className={value.subjects.includes(s) ? "selected" : ""}
            key={s}
          >
            <input
              type="checkbox"
              checked={value.subjects.includes(s)}
              onChange={(e) => {
                if (e.target.checked && value.subjects.length >= 3) {
                  notify("最多选择三门选考科目");
                  return;
                }
                patch(
                  "subjects",
                  e.target.checked
                    ? [...value.subjects, s]
                    : value.subjects.filter((x) => x !== s),
                );
              }}
            />
            {s}
          </label>
        ))}
      </div>
    </div>,
    <div className="form-grid" key="preferences">
      <label>
        期待的城市（用逗号分隔）
        <input
          value={value.cities.join(",")}
          onChange={(e) =>
            patch(
              "cities",
              e.target.value.split(/[,，]/).map((x) => x.trim()),
            )
          }
          placeholder="杭州,南京,上海"
        />
      </label>
      <label>
        感兴趣的专业（用逗号分隔）
        <input
          value={value.interests.join(",")}
          onChange={(e) =>
            patch(
              "interests",
              e.target.value.split(/[,，]/).map((x) => x.trim()),
            )
          }
        />
      </label>
      <label>
        每年学费预算 / 元
        <input
          type="number"
          min="0"
          max="500000"
          value={value.budget ?? ""}
          onChange={(e) =>
            patch(
              "budget",
              e.target.value === "" ? null : Number(e.target.value),
            )
          }
        />
      </label>
      <label className="switch-label">
        <input
          type="checkbox"
          checked={value.acceptAdjustment}
          onChange={(e) => patch("acceptAdjustment", e.target.checked)}
        />
        可以接受专业调剂
      </label>
      <label>
        预算范围
        <select
          value={value.budgetScope || "tuition"}
          onChange={(e) =>
            patch("budgetScope", e.target.value as "tuition" | "total")
          }
        >
          <option value="tuition">CNY / 每年学费</option>
          <option value="total">CNY / 每年总支出</option>
        </select>
      </label>
      <label>
        地域偏好约束
        <select
          value={
            value.preferences?.find((p) => p.field === "preferred_regions")
              ?.strength || "soft"
          }
          onChange={(e) =>
            patch("preferences", [
              {
                field: "preferred_regions",
                value: value.cities.join("、"),
                strength: e.target.value as "hard" | "soft",
                priority: 1,
              },
            ])
          }
        >
          <option value="soft">尽量满足</option>
          <option value="hard">必须满足</option>
        </select>
      </label>
    </div>,
  ];
  async function submit() {
    const cleaned = {
      ...value,
      cities: value.cities.filter(Boolean),
      interests: value.interests.filter(Boolean),
    };
    const e = validateProfile(cleaned);
    setErrors(e);
    if (e.length) {
      setMode("form");
      return;
    }
    setBusy(true);
    try {
      update({ profile: await api.profile(cleaned) });
      notify("你的坐标已更新，新的航线正在等待");
      navigate("/routes");
    } catch (e) {
      setErrors([errorText(e)]);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="EVERY VOYAGE STARTS WITH YOU"
        title="先找到你的坐标"
        description="只收集推荐需要的信息，不需要姓名、身份证号或精确住址。你可以随时清除档案。"
      />
      <section className="panel profile-proposal">
        <h2>先提取，再由你确认</h2>
        <label>
          自然语言描述
          <textarea
            value={natural}
            onChange={(e) => setNatural(e.target.value)}
            placeholder="如：我在浙江，628分，位次23500…"
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={!natural.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await api.parseProfile(natural);
              setProposal(result.proposedChanges);
            } catch (e) {
              setErrors([errorText(e)]);
            } finally {
              setBusy(false);
            }
          }}
        >
          提取修改建议
        </button>
        {proposal && (
          <div>
            <pre>{JSON.stringify(proposal, null, 2)}</pre>
            <button
              className="button"
              onClick={() => {
                setValue((p) => ({
                  ...p,
                  ...Object.fromEntries(
                    Object.entries(proposal).filter(([, v]) => v !== undefined),
                  ),
                }));
                setProposal(null);
              }}
            >
              确认填入表单（尚未保存）
            </button>
          </div>
        )}
        <p className="muted">
          当前画像版本 {value.version || 0} ·{" "}
          {value.profileVersionId || "新画像"}
        </p>
        <button
          className="text-button"
          onClick={async () => {
            try {
              setVersions(await api.profileVersions());
            } catch (e) {
              setErrors([errorText(e)]);
            }
          }}
        >
          查看历史／并发更新版本
        </button>
        {versions.length > 0 && (
          <div>
            {versions.map((p) => (
              <p key={p.profileVersionId}>
                v{p.version} · {p.profileVersionId} ·{" "}
                {p.province || "省份待补充"} · 位次 {p.rank ?? "未填写"}
              </p>
            ))}
            <button
              className="button"
              onClick={() => {
                setValue(versions[versions.length - 1]);
                setErrors([]);
              }}
            >
              载入最新版本并替换当前表单
            </button>
          </div>
        )}
      </section>
      <div className="profile-layout">
        <section className="panel">
          <div className="section-title">
            <h2>
              {mode === "form"
                ? "考生档案"
                : [
                    "你从哪里出发？",
                    "你的学科坐标是什么？",
                    "你期待怎样的未来？",
                  ][step]}
            </h2>
            <button
              className="text-button"
              onClick={() => setMode(mode === "form" ? "steps" : "form")}
            >
              {mode === "form" ? "逐步填写" : "切换完整表单"}
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (mode === "steps" && step < 2) setStep(step + 1);
              else void submit();
            }}
          >
            {mode === "form" ? fields : fields[step]}
            {(mode === "form" || step === 2) && (
              <label className="consent">
                <input
                  type="checkbox"
                  required
                  checked={value.consent}
                  onChange={(e) => patch("consent", e.target.checked)}
                />
                <span>
                  同意使用上述信息生成个性化建议。
                  {isMock
                    ? "本地演示档案保存在此浏览器。"
                    : "信息将同步到当前登录账号。"}
                </span>
              </label>
            )}
            {errors.length > 0 && (
              <div className="notice amber" role="alert">
                <ul>
                  {errors.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="form-actions">
              {mode === "steps" && step > 0 && (
                <button
                  type="button"
                  className="button"
                  onClick={() => setStep(step - 1)}
                >
                  上一步
                </button>
              )}
              <button className="button gold-button" disabled={busy}>
                {busy
                  ? "正在保存…"
                  : mode === "steps" && step < 2
                    ? "下一步"
                    : "保存档案，看看航线"}
                <ArrowRight size={15} />
              </button>
            </div>
          </form>
        </section>
        <aside className="constellation-panel">
          <span className="eyebrow">YOUR OWN CONSTELLATION</span>
          <svg viewBox="0 0 300 300" role="img" aria-label="你的档案星座示意图">
            <path
              d="M70 200 L110 70 L230 110 L200 230 L70 200 L230 110"
              fill="none"
              stroke="#6b6555"
              strokeDasharray="4 5"
            />
            {[
              [70, 200],
              [110, 70],
              [230, 110],
              [200, 230],
            ].map(([x, y], i) => (
              <g key={i}>
                <circle
                  cx={x}
                  cy={y}
                  r={i <= step + 1 ? 8 : 4}
                  fill={i <= step + 1 ? "#d6bd86" : "#465266"}
                />
                <circle cx={x} cy={y} r="17" fill="none" stroke="#d6bd8620" />
              </g>
            ))}
          </svg>
          <h2>
            你是独一无二的，
            <br />
            选择也应该如此。
          </h2>
          <p>
            分数只是一个坐标。
            <br />
            你的热爱和期待，同样重要。
          </p>
          <div className="profile-chips">
            <span>{value.province}</span>
            <span>{value.subjects.join(" / ") || "选科待补充"}</span>
          </div>
        </aside>
      </div>
    </>
  );
}
function Lighthouse() {
  const { data, notify, refresh } = useApp();
  const [tab, setTab] = useState("write");
  const [schoolId, setSchool] = useState(
    () =>
      data.schools.find((s) => s.id === localStorage.getItem("nv-echo-school"))
        ?.id ||
      data.schools[0]?.id ||
      "",
  );
  const [topic, setTopic] = useState("校园生活");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [consent, setConsent] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const submissionKey = useRef(crypto.randomUUID());
  const [campusId, setCampusId] = useState(""),
    [majorId, setMajorId] = useState(""),
    [experiencedAt, setExperiencedAt] = useState(""),
    [visibility, setVisibility] = useState<"public" | "private">("public");
  useEffect(() => {
    submissionKey.current = crypto.randomUUID();
  }, [
    schoolId,
    topic,
    title,
    body,
    campusId,
    majorId,
    experiencedAt,
    visibility,
  ]);
  return (
    <>
      <PageTitle
        eyebrow="BE A LIGHT FOR SOMEONE ELSE"
        title="你的经历，会成为一束光"
        description="走过这段路的你，能为还在选择的他们，留下一份具体、真诚、可核验的校园经验。"
      />
      <div className="tabs">
        <button
          className={tab === "write" ? "active" : ""}
          onClick={() => setTab("write")}
        >
          写一封校园来信
        </button>
        <button
          className={tab === "verify" ? "active" : ""}
          onClick={() => setTab("verify")}
        >
          在读 / 毕业认证
        </button>
      </div>
      <div className="lighthouse-grid">
        <section className="panel">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!data.user) {
                notify("请先在“我的”登录");
                return;
              }
              setBusy(true);
              try {
                if (tab === "write") {
                  await api.submitPost(
                    {
                      schoolId,
                      topic,
                      title,
                      body,
                      campusId: campusId || null,
                      majorId: majorId || null,
                      experiencedAt: experiencedAt || null,
                      visibility,
                      originality: "original",
                    },
                    submissionKey.current,
                  );
                  setTitle("");
                  setBody("");
                  setConsent(false);
                  notify("来信已进入审核队列，审核前不会公开");
                } else {
                  if (!file) throw new Error("请选择认证材料");
                  await api.verify(schoolId, file);
                  setFile(null);
                  if (fileRef.current) fileRef.current.value = "";
                  notify(
                    isMock
                      ? "演示认证申请已记录；文件未上传或持久化"
                      : "认证材料已提交，请等待审核",
                  );
                }
                await refresh();
              } catch (e) {
                notify((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              你所在的院校
              <select
                value={schoolId}
                onChange={(e) => setSchool(e.target.value)}
              >
                {data.schools.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            {tab === "write" ? (
              <>
                <div className="form-grid">
                  <label>
                    校区ID（可暂缺）
                    <input
                      value={campusId}
                      onChange={(e) => setCampusId(e.target.value)}
                    />
                  </label>
                  <label>
                    专业ID（可暂缺）
                    <input
                      value={majorId}
                      onChange={(e) => setMajorId(e.target.value)}
                    />
                  </label>
                  <label>
                    亲历时间
                    <input
                      type="date"
                      value={experiencedAt}
                      onChange={(e) => setExperiencedAt(e.target.value)}
                    />
                  </label>
                  <label>
                    可见范围
                    <select
                      value={visibility}
                      onChange={(e) =>
                        setVisibility(e.target.value as "public" | "private")
                      }
                    >
                      <option value="public">审核后公开</option>
                      <option value="private">仅本人可见</option>
                    </select>
                  </label>
                </div>
                <label>
                  你想分享的主题
                  <select
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                  >
                    {[
                      "校园生活",
                      "专业与学风",
                      "转专业",
                      "住宿与食堂",
                      "就业与升学",
                      "吐槽避雷",
                    ].map((t) => (
                      <option key={t}>{t}</option>
                    ))}
                  </select>
                </label>
                <label>
                  给这封信起个标题
                  <input
                    required
                    minLength={5}
                    maxLength={80}
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="一句话，告诉大家这封信讲什么"
                  />
                </label>
                <label>
                  写下你亲历的细节
                  <textarea
                    required
                    minLength={80}
                    maxLength={10000}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    rows={9}
                    placeholder="什么时候？哪个校区或专业？你亲身经历了什么？哪些信息有公开依据？哪些只是个人感受？请至少写80字。"
                  />
                </label>
                <span className="muted">
                  {body.length} / 10000 字 ·
                  时间、地点与适用范围能让内容更易核验
                </span>
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    required
                  />
                  <span>
                    我确认这是个人真实经历，已移除个人隐私、广告、引流与针对个人的指控，同意匿名展示并接受内容审核。
                  </span>
                </label>
              </>
            ) : (
              <>
                <div className="upload-area">
                  <Upload size={30} />
                  <h3>上传在读或毕业凭证</h3>
                  <p>
                    请先遮挡姓名、学号与证件号码，仅保留学校、在读 /
                    毕业状态等必要信息。
                  </p>
                  <input
                    ref={fileRef}
                    required
                    aria-label="认证凭证"
                    type="file"
                    accept="image/png,image/jpeg,application/pdf"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (
                        f &&
                        (![
                          "image/png",
                          "image/jpeg",
                          "application/pdf",
                        ].includes(f.type) ||
                          f.size > 5 * 1024 * 1024)
                      ) {
                        notify("仅支持 JPG、PNG、PDF，大小不超过 5 MB");
                        e.target.value = "";
                        setFile(null);
                        return;
                      }
                      setFile(f || null);
                    }}
                  />
                </div>
                <p className="muted">
                  {isMock
                    ? "演示模式只记录申请状态，不读取或保存文件内容。"
                    : "文件只用于身份审核，不公开展示；加密保存，审核后按隐私政策清除。"}
                </p>
              </>
            )}
            <button className="button gold-button" disabled={busy}>
              {busy
                ? "正在提交…"
                : tab === "write"
                  ? "提交来信，等待审核"
                  : "提交认证申请"}
              <ArrowRight size={15} />
            </button>
          </form>
        </section>
        <aside className="panel lighthouse-note">
          <Anchor size={40} strokeWidth={1} />
          <h2>
            具体的真话，
            <br />
            比完美的故事更有用。
          </h2>
          <p>
            说清时间和适用范围。
            <br />
            把亲历与听说分开。
            <br />
            允许不同的人有不同体验。
          </p>
          <div className="notice">
            <ShieldCheck size={17} />
            <p>
              认证身份不意味着每句话都准确。我们会结合细节、交叉证据与时效性评估信号强度。
            </p>
          </div>
          <h3>我的认证进度</h3>
          {data.verifications.map((v) => (
            <div className="verification-status" key={v.id}>
              <span>{data.schools.find((s) => s.id === v.schoolId)?.name}</span>
              <span>
                {
                  {
                    pending: "等待审核",
                    approved: "认证通过",
                    rejected: "需要补充",
                  }[v.status]
                }
              </span>
            </div>
          ))}
          {!data.verifications.length && (
            <p className="muted">还没有提交认证申请。</p>
          )}
        </aside>
      </div>
    </>
  );
}
function Admin() {
  const { data, navigate, notify, refresh } = useApp();
  const [queue, setQueue] = useState<Post[]>([]);
  const [selected, setSelected] = useState("");
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  async function load(append = false) {
    setLoading(true);
    try {
      const page = await api.moderation(append ? cursor : null);
      const q = page.items;
      setCursor(page.nextCursor);
      setQueue((rows) => (append ? [...rows, ...q] : q));
      setSelected((id) => (q.some((p) => p.id === id) ? id : q[0]?.id || ""));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (hasPermission(data.user, "content:review")) void load();
  }, [data.user?.role]);
  const p = queue.find((p) => p.id === selected);
  async function review(decision: "approve" | "reject") {
    if (!p || busy) return;
    if (reason.trim().length < 5) {
      notify("请至少填写5字审核依据");
      return;
    }
    setBusy(true);
    try {
      await api.review(p.id, decision, reason, p.version || 1);
      setReason("");
      await refresh();
      await load();
      notify("审核决定已记录");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!hasPermission(data.user, "content:review"))
    return (
      <>
        <PageTitle
          eyebrow="CONTENT MODERATION"
          title="内容审核工作台"
          description="此功能仅向内容审核员开放，用于核验来信与引用证据。"
        />
        <Empty
          text={
            isMock
              ? "请在“我的”切换为内容审核员，体验审核流程。"
              : "当前账号没有内容审核权限。"
          }
          action="前往我的账号"
          onAction={() => navigate("/me")}
        />
      </>
    );
  return (
    <>
      <PageTitle
        eyebrow="INDEPENDENT TRUST & EVIDENCE MODULE"
        title="让每一束信号，经得起核验"
        description="独立审核可信度与证据，保留内容适用范围和人工判断依据。"
      />
      {error && (
        <p className="warning-text" role="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">正在加载队列…</p>}
      <div className="review-layout">
        <aside className="panel review-queue">
          <h3>
            待审队列 <span>{queue.length}</span>
          </h3>
          {queue.map((item) => (
            <button
              className={p?.id === item.id ? "active" : ""}
              key={item.id}
              onClick={() => {
                setSelected(item.id);
                setReason("");
              }}
            >
              <SignalBadge signal={item.signal} />
              <h4>{item.title}</h4>
              <small>{item.author}</small>
            </button>
          ))}
          {!queue.length && <Empty text="待审队列已处理完成。" />}
          {cursor && (
            <button className="button" onClick={() => void load(true)}>
              加载更多待审来信
            </button>
          )}
        </aside>
        {p ? (
          <>
            <article className="paper review-content">
              <span className="eyebrow">CONTENT & EVIDENCE</span>
              <h2>{p.title}</h2>
              <p className="post-body">{p.body}</p>
              <Evidence ids={p.sourceIds} />
            </article>
            <aside className="panel review-decision">
              <ShieldCheck size={27} />
              <h3>核验与审核依据</h3>
              {p.trust.explanation.map((t, i) => (
                <p className="muted" key={i}>
                  {i + 1}. {t}
                </p>
              ))}
              <div className="notice amber">
                <AlertTriangle size={16} />
                <p>示例评分不可替代人工审核。高风险内容请先核查来源。</p>
              </div>
              <label>
                人工审核理由
                <textarea
                  minLength={5}
                  required
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="记录事实依据及适用范围（至少5字）"
                />
              </label>
              <button
                disabled={busy}
                className="button gold-button"
                onClick={() => void review("approve")}
              >
                <Check size={16} />
                通过并发布
              </button>
              <button
                disabled={busy}
                className="button danger"
                onClick={() => void review("reject")}
              >
                <X size={16} />
                拒绝发布
              </button>
            </aside>
          </>
        ) : null}
      </div>
    </>
  );
}
export default function Account({ path }: { path: string }) {
  return path === "/admin/verifications" ? (
    <VerificationAdmin />
  ) : path === "/history" ? (
    <History />
  ) : path === "/register" ? (
    <Registration />
  ) : path === "/application" ? (
    <ApplicationStatus />
  ) : path === "/admin/registrations" ? (
    <RegistrationAdmin />
  ) : path === "/profile" ? (
    <ProfilePage />
  ) : path === "/lighthouse" ? (
    <Lighthouse />
  ) : path === "/admin" ? (
    <Admin />
  ) : path === "/me" ? (
    <Me />
  ) : (
    <Empty text="这个页面还没有出现在星图上。" />
  );
}
