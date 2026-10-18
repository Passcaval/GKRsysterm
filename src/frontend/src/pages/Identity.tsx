import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowLeft,
  RefreshCw,
  Mic,
  Square,
  ShieldCheck,
} from "lucide-react";
import { api, isMock } from "../api";
import { useApp } from "../store";
import { PageTitle, Empty, SchoolCard } from "../components";
import { beijingTime, errorText } from "../transport";
import {
  hasPermission,
  type User,
  type RegistrationReceipt,
  type RegistrationApplication,
  type RegistrationInput,
} from "../types";
import { validateRegistration } from "../workflow-domain";

let receipt: RegistrationReceipt | null = null; // Query capability is deliberately memory-only.
function Notice({ text }: { text: string }) {
  return text ? (
    <div className="notice amber" role="alert">
      <p>{text}</p>
    </div>
  ) : null;
}
export function Me() {
  const { data, refresh, navigate } = useApp();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <PageTitle
        eyebrow="YOUR PERSONAL LOGBOOK"
        title={data.user ? `${data.user.name}，航行继续。` : "欢迎来到夜航"}
        description="统一使用邮箱或系统用户ID登录，账号权限由服务端决定。注册申请需先经管理员审核。"
      />
      <Notice text={error} />
      <div className="account-grid">
        <section className="panel identity-panel">
          <h2>{data.user ? "我的账号" : "继续你的航行"}</h2>
          {data.user ? (
            <>
              <p>昵称：{data.user.name}</p>
              <p>系统用户ID：{data.user.userId || "待确认"}</p>
              <p>
                邮箱：{data.user.email || "未返回"} ·{" "}
                {data.user.emailVerified
                  ? "已验证"
                  : "未验证（不影响已批准账号登录）"}
              </p>
              <p>
                学校身份：
                {data.user.verified ? "已有学校认证" : "尚未进行学校身份认证"}
              </p>
              {data.user.studentVerificationScopes?.map((s) => (
                <p className="muted" key={s.schoolId}>
                  {s.schoolId} · {s.scope}
                </p>
              ))}
              <button
                className="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.logout();
                    await refresh();
                    navigate("/login");
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                退出登录
              </button>
            </>
          ) : (
            <p className="muted">
              请从统一登录页输入邮箱或系统分配的用户ID，昵称不能用于登录。
            </p>
          )}
          <button
            className="button gold-button"
            onClick={() => navigate("/login")}
          >
            {data.user ? "切换账号" : "前往统一登录"}
          </button>
          <div className="form-actions">
            <button
              className="text-button"
              onClick={() => navigate("/register")}
            >
              申请注册 <ArrowRight size={14} />
            </button>
            <button
              className="text-button"
              onClick={() => navigate("/application")}
            >
              查询申请状态
            </button>
          </div>
        </section>
        <section className="panel">
          <h2>我的档案与探索</h2>
          <p className="muted">
            画像可以逐步补齐，风险分析会单独询问缺失条件。
          </p>
          <button className="button" onClick={() => navigate("/profile")}>
            查看考生档案
          </button>
          <button className="button" onClick={() => navigate("/history")}>
            历史任务、偏好与案例授权
          </button>
          <button className="button" onClick={() => navigate("/lighthouse")}>
            投稿与学校身份认证
          </button>
          {hasPermission(data.user, "registration:review") && (
            <button
              className="button"
              onClick={() => navigate("/admin/registrations")}
            >
              注册申请审核
            </button>
          )}
          {hasPermission(data.user, "content:review") && (
            <button className="button" onClick={() => navigate("/admin")}>
              校园内容审核
            </button>
          )}
          {hasPermission(data.user, "verification:review") && (
            <button
              className="button"
              onClick={() => navigate("/admin/verifications")}
            >
              学校身份认证审核
            </button>
          )}
        </section>
      </div>
      <h2>收藏的院校</h2>
      <div className="school-grid">
        {data.schools
          .filter((s) => data.favorites.includes(s.id))
          .map((s) => (
            <SchoolCard key={s.id} school={s} />
          ))}
      </div>
      <h2>我的投稿</h2>
      {data.posts
        .filter((p) => p.isMine)
        .map((p) => (
          <div className="panel" key={p.id}>
            <button
              className="text-button"
              onClick={() => navigate("/post/" + p.id)}
            >
              {p.title}
            </button>
            <span className="muted">
              {p.status === "published"
                ? "已公开"
                : p.status === "pending"
                  ? "等待审核"
                  : "已驳回"}
            </span>
          </div>
        ))}
    </>
  );
}
export function Registration() {
  const { data, navigate, refresh } = useApp();
  const [input, setInput] = useState<RegistrationInput>({
    nickname: "",
    email: "",
    password: "",
    evidenceText: "",
    evidenceAudio: null,
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState<RegistrationReceipt | null>(null),
    [audioUrl, setAudioUrl] = useState(""),
    [recording, setRecording] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    recordTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submitKey = useRef({ body: "", key: "" });
  useEffect(() => {
    if (!input.evidenceAudio) {
      setAudioUrl("");
      return;
    }
    const url = URL.createObjectURL(input.evidenceAudio);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [input.evidenceAudio]);
  useEffect(
    () => () => {
      if (recordTimer.current) clearTimeout(recordTimer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );
  async function record() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error("此浏览器不支持录音，请上传音频文件");
      stream.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const chunks: Blob[] = [];
      const rec = new MediaRecorder(stream.current);
      recorder.current = rec;
      rec.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || "audio/webm";
        const file = new File(chunks, "registration-voice.webm", { type });
        setInput((p) => ({ ...p, evidenceAudio: file }));
        setRecording(false);
        stream.current?.getTracks().forEach((t) => t.stop());
        if (recordTimer.current) clearTimeout(recordTimer.current);
      };
      rec.start();
      setRecording(true);
      recordTimer.current = setTimeout(() => rec.stop(), 120000);
    } catch (e) {
      setError(errorText(e));
      stream.current?.getTracks().forEach((t) => t.stop());
    }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    const errors = isMock ? validateRegistration(input) : [];
    if (errors.length) {
      setError(errors.join("；"));
      return;
    }
    const body = JSON.stringify({
      ...input,
      evidenceAudio: input.evidenceAudio
        ? {
            name: input.evidenceAudio.name,
            size: input.evidenceAudio.size,
            lastModified: input.evidenceAudio.lastModified,
          }
        : null,
    });
    if (body !== submitKey.current.body)
      submitKey.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const value = await api.register(input, submitKey.current.key);
      receipt = value;
      setDone(value);
      setInput((p) => ({
        ...p,
        password: "",
        evidenceText: "",
        evidenceAudio: null,
      }));
      submitKey.current = { body: "", key: "" };
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="REQUEST TO COME ABOARD"
        title="申请加入夜航"
        description="只填写昵称、邮箱、密码，并提供文字或语音审核证据。用户ID由系统预留，批准后沿用。"
      />
      <Notice text={error} />
      {done ? (
        <section className="panel application-receipt" role="status">
          <h2>申请已提交，等待管理员审核</h2>
          <p>申请编号：{done.applicationId}</p>
          <p>
            系统预留用户ID：<strong>{done.reservedUserId}</strong>
          </p>
          <p>提交成功不表示已注册，当前尚不能登录。</p>
          <label>
            申请状态查询凭据（请自行保存）
            <textarea readOnly value={done.statusToken} />
          </label>
          <p className="muted">
            查询凭据只用于这份申请，不是登录令牌，不会放入地址或本地存储。
          </p>
          <button
            className="button gold-button"
            onClick={() => navigate("/application")}
          >
            查询审核状态
          </button>
        </section>
      ) : data.user ? (
        <Empty
          text="当前已登录。请退出账号后提交新的注册申请。"
          action="退出并开始申请"
          onAction={() => void api.logout().then(refresh)}
        />
      ) : (
        <form className="panel registration-form" onSubmit={submit}>
          <div className="form-grid">
            <label>
              昵称
              <input
                required
                value={input.nickname}
                onChange={(e) =>
                  setInput((p) => ({ ...p, nickname: e.target.value }))
                }
                placeholder="1–5个汉字或英文字母"
                autoComplete="nickname"
              />
            </label>
            <label>
              邮箱
              <input
                required
                type="text"
                inputMode="email"
                value={input.email}
                onChange={(e) =>
                  setInput((p) => ({ ...p, email: e.target.value }))
                }
                autoComplete="email"
              />
            </label>
            <label>
              密码
              <input
                required
                type="password"
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                value={input.password}
                onChange={(e) =>
                  setInput((p) => ({ ...p, password: e.target.value }))
                }
              />
            </label>
          </div>
          <h2>审核证据</h2>
          <p className="muted">
            文字与语音至少一种，最多3000字或120秒/10MiB音频。只用于管理员审核，不公开为校园帖子。邮箱仅检查格式，不发送验证码。
          </p>
          <label>
            文字说明
            <textarea
              rows={5}
              value={input.evidenceText}
              onChange={(e) =>
                setInput((p) => ({ ...p, evidenceText: e.target.value }))
              }
              placeholder="向管理员说明你的申请依据…"
            />
          </label>
          <label>
            上传语音
            <input
              type="file"
              accept="audio/webm,audio/ogg,audio/mpeg,audio/mp4,audio/wav"
              onChange={(e) =>
                setInput((p) => ({
                  ...p,
                  evidenceAudio: e.target.files?.[0] || null,
                }))
              }
            />
          </label>
          <button
            type="button"
            className="button"
            onClick={() => void record()}
          >
            {recording ? <Square size={14} /> : <Mic size={14} />}{" "}
            {recording ? "停止录音" : "录制语音"}
          </button>
          {audioUrl && (
            <>
              <audio
                controls
                src={audioUrl}
                onLoadedMetadata={(e) => {
                  if (
                    Number.isFinite(e.currentTarget.duration) &&
                    e.currentTarget.duration > 120
                  ) {
                    setError("语音不能超过120秒");
                    setInput((p) => ({ ...p, evidenceAudio: null }));
                  }
                }}
              />
              <button
                type="button"
                className="text-button"
                onClick={() => setInput((p) => ({ ...p, evidenceAudio: null }))}
              >
                移除语音
              </button>
            </>
          )}
          {isMock && (
            <p className="warning-text">
              演示模式请仅使用虚构资料。申请、密码验证资料和原始音频只在当前页面运行内存中保留，刷新会清空。
            </p>
          )}
          <button className="button gold-button" disabled={busy || recording}>
            {busy ? "提交中…" : "提交申请，等待审核"}
          </button>
          <button
            type="button"
            className="text-button"
            onClick={() => navigate("/me")}
          >
            返回登录
          </button>
        </form>
      )}
    </>
  );
}
export function ApplicationStatus() {
  const [id, setId] = useState(receipt?.applicationId || ""),
    [token, setToken] = useState(receipt?.statusToken || ""),
    [application, setApplication] = useState<RegistrationApplication | null>(
      null,
    ),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const { navigate } = useApp();
  async function load(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setApplication(null);
    try {
      setApplication(await api.application(id, token));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle
        eyebrow="APPLICATION STATUS"
        title="查询注册申请"
        description="申请凭据仅能查询该份申请，审核通过后才能用邮箱或用户ID登录。"
      />
      <Notice text={error} />
      <form className="panel" onSubmit={load}>
        <label>
          申请编号
          <input required value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label>
          查询凭据
          <input
            required
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </label>
        <button className="button gold-button" disabled={busy}>
          {busy ? "查询中…" : "查询审核状态"}
        </button>
      </form>
      {application && (
        <section className="panel" role="status">
          <h2>
            {
              {
                pending: "等待管理员审核",
                approved: "审核已通过，可以登录",
                rejected: "申请被驳回",
              }[application.status]
            }
          </h2>
          <p>系统用户ID：{application.reservedUserId}</p>
          <p>提交时间：{beijingTime(application.createdAt)}</p>
          {application.reason && <p>驳回原因：{application.reason}</p>}
          {application.status === "approved" ? (
            <button
              className="button gold-button"
              onClick={() => navigate("/me")}
            >
              前往登录
            </button>
          ) : application.status === "rejected" ? (
            <button className="button" onClick={() => navigate("/register")}>
              重新提交新申请
            </button>
          ) : (
            <p className="muted">待审标识不会因关闭页面或等待时间自动释放。</p>
          )}
        </section>
      )}
    </>
  );
}
export function RegistrationAdmin() {
  const { data } = useApp();
  const [rows, setRows] = useState<RegistrationApplication[]>([]),
    [selected, setSelected] = useState<RegistrationApplication | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [reason, setReason] = useState(""),
    [error, setError] = useState(""),
    [audio, setAudio] = useState(""),
    [busy, setBusy] = useState(false);
  const capability = hasPermission(data.user, "registration:review");
  const decisionKey = useRef({ body: "", key: "" });
  async function load(append = false) {
    setError("");
    try {
      const page = await api.registrationQueue(append ? cursor : null);
      setRows((r) => (append ? [...r, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setError(errorText(e));
    }
  }
  useEffect(() => {
    if (capability) void load();
  }, [capability]);
  useEffect(
    () => () => {
      if (audio) URL.revokeObjectURL(audio);
    },
    [audio],
  );
  async function select(id: string) {
    setBusy(true);
    setError("");
    setAudio("");
    setReason("");
    setSelected(null);
    try {
      const a = await api.applicationDetail(id);
      setSelected(a);
      if (a.hasAudio)
        setAudio(URL.createObjectURL(await api.applicationAudio(id)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function decide(decision: "approve" | "reject") {
    if (!selected) return;
    setBusy(true);
    setError("");
    const body = JSON.stringify({
      id: selected.applicationId,
      decision,
      reason,
      version: selected.version,
    });
    if (body !== decisionKey.current.body)
      decisionKey.current = { body, key: crypto.randomUUID() };
    try {
      const updated = await api.decideRegistration(
        selected.applicationId,
        decision,
        reason,
        selected.version,
        decisionKey.current.key,
      );
      setSelected(updated);
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (!capability)
    return <Empty text="需要注册审批权限；内容审核员无此权限。" />;
  return (
    <>
      <PageTitle
        eyebrow="REGISTRATION REVIEW"
        title="注册申请审核"
        description="核对原始文字和语音。批准仅创建普通账号，不自动授予学校认证或内容审核权限。"
      />
      <Notice text={error} />
      <button className="button" disabled={busy} onClick={() => void load()}>
        <RefreshCw size={14} /> 刷新申请队列
      </button>
      <div className="registration-review">
        <aside className="panel">
          {rows.map((a) => (
            <button
              className="review-application"
              key={a.applicationId}
              onClick={() => void select(a.applicationId)}
            >
              <strong>
                {a.nickname} · {a.reservedUserId}
              </strong>
              <span>{a.email}</span>
              <small>{beijingTime(a.createdAt)}</small>
              <small>{a.applicationId}</small>
            </button>
          ))}
          {!rows.length && <Empty text="暂无待审注册申请" />}
          {cursor && (
            <button className="button" onClick={() => void load(true)}>
              加载更多申请
            </button>
          )}
        </aside>
        <section className="panel">
          {selected ? (
            <>
              <h2>{selected.nickname}</h2>
              <p>
                {selected.email} · {selected.reservedUserId} · 版本{" "}
                {selected.version}
              </p>
              <p className="muted">{selected.applicationId}</p>
              <h3>原始文字证据</h3>
              <p className="original-evidence">
                {selected.evidenceText || "未提供文字证据"}
              </p>
              <h3>原始语音</h3>
              {audio ? (
                <audio src={audio} controls />
              ) : (
                <p>
                  {selected.hasAudio
                    ? "语音加载失败时请刷新详情，不能据此自动批准"
                    : "未提供语音证据"}
                </p>
              )}
              {selected.status === "pending" ? (
                <>
                  <label>
                    驳回原因（驳回时必填）
                    <textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <div className="form-actions">
                    <button
                      className="button gold-button"
                      disabled={busy}
                      onClick={() => void decide("approve")}
                    >
                      批准并创建普通账号
                    </button>
                    <button
                      className="button danger"
                      disabled={busy || !reason.trim()}
                      onClick={() => void decide("reject")}
                    >
                      驳回并释放待审占用
                    </button>
                  </div>
                </>
              ) : (
                <p role="status">
                  此申请已处理：
                  {selected.status === "approved" ? "批准" : "驳回"}
                  ，预留用户ID保持不变。
                </p>
              )}
            </>
          ) : (
            <Empty text="选择一份申请，核对原始证据" />
          )}
        </section>
      </div>
    </>
  );
}
