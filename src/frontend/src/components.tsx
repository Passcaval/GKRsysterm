import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  X,
  ArrowUpRight,
  Plus,
  Heart,
  Check,
  ArrowRight,
  ExternalLink,
} from "lucide-react";
import { useApp } from "./store";
import { api } from "./api";
import { classify, tierLabel, tierSymbol } from "./domain";
import type { School, Signal, Tier } from "./types";
export const signalLabels: Record<Signal, string> = {
  strong: "强信号",
  medium: "中信号",
  weak: "弱信号",
  disputed: "存疑",
};
export function SignalBadge({ signal }: { signal: Signal }) {
  return (
    <span className={`signal ${signal}`}>
      <span aria-hidden="true">▂▄▆</span> {signalLabels[signal]}
    </span>
  );
}
export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <span className={`tier ${tier}`}>
      {tierSymbol[tier]} {tierLabel[tier]}
    </span>
  );
}
export function SectionTitle({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="section-title">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h2>{title}</h2>
      </div>
      {children}
    </div>
  );
}
export function PageTitle({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="page-title">
      <span className="eyebrow">{eyebrow}</span>
      <div>
        <h1>{title}</h1>
        {children}
      </div>
      <p>{description}</p>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    const focus = document.activeElement as HTMLElement | null;
    el?.showModal();
    return () => {
      el?.close();
      focus?.focus();
    };
  }, []);
  return (
    <dialog
      className={`modal ${wide ? "wide" : ""}`}
      ref={dialog}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-header">
        <h2>{title}</h2>
        <button className="icon-button" onClick={onClose} aria-label="关闭弹窗">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Evidence({ ids }: { ids: string[] }) {
  const { data } = useApp();
  return (
    <div className="evidence-list">
      {ids.length === 0 ? (
        <p className="muted">暂无可引用证据。</p>
      ) : (
        ids.map((id) => {
          const s = data.sources.find((s) => s.id === id);
          return s ? (
            <article className={`evidence ${s.kind}`} key={id}>
              <span className="eyebrow">
                {s.kind === "official"
                  ? "官方数据"
                  : s.kind === "experience"
                    ? "学生体验"
                    : "模型 / 规则推断"}{" "}
                · {s.year}
              </span>
              <h4>{s.title}</h4>
              <p>{s.excerpt}</p>
              <small>
                检索时间 {new Date(s.retrievedAt).toLocaleDateString("zh-CN")}
              </small>
              {s.url && /^https?:\/\//.test(s.url) ? (
                <a href={s.url} target="_blank" rel="noreferrer">
                  查看原文 <ExternalLink size={12} />
                </a>
              ) : (
                <small className="warning-text">演示来源，无真实原文链接</small>
              )}
            </article>
          ) : (
            <p key={id} className="warning-text">
              来源 {id} 暂未加载，请刷新后重试。
            </p>
          );
        })
      )}
    </div>
  );
}
export function SchoolCard({
  school,
  compact = false,
  tier: providedTier,
}: {
  school: School;
  compact?: boolean;
  tier?: Tier;
}) {
  const { data, navigate, update, notify } = useApp();
  const [saving, setSaving] = useState(false);
  const favorite = data.favorites.includes(school.id);
  const inPlan = data.plan.entries.some((e) => e.schoolId === school.id);
  const tier =
    providedTier || classify(data.profile?.rank || 23500, school.rank);
  async function add() {
    if (saving) return;
    setSaving(true);
    try {
      if (!data.user) throw new Error("请先在“我的”登录");
      const plan = await api.plan({
        ...data.plan,
        entries: [
          ...data.plan.entries,
          {
            id: crypto.randomUUID(),
            schoolId: school.id,
            major: school.majors[0],
            adjustment: data.profile?.acceptAdjustment ?? true,
          },
        ],
      });
      update({ plan });
      notify("已加入志愿草案");
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <article className={`school-card ${compact ? "compact" : ""}`}>
      <div className="school-card-top">
        <button
          className="school-identity"
          onClick={() => navigate("/school/" + school.id)}
        >
          <span
            className="school-seal"
            style={{ color: school.color, borderColor: school.color }}
          >
            {school.short}
          </span>
          <span>
            <h3>{school.name}</h3>
            <small>
              {school.city} · {school.level}
            </small>
          </span>
        </button>
        <button
          className={`icon-button ${favorite ? "gold" : ""}`}
          disabled={saving}
          aria-label={`${favorite ? "取消收藏" : "收藏"}${school.name}`}
          onClick={async () => {
            try {
              update({ favorites: await api.favorite(school.id, !favorite) });
            } catch (e) {
              notify((e as Error).message);
            }
          }}
        >
          <Heart size={17} fill={favorite ? "currentColor" : "none"} />
        </button>
      </div>
      <div className="school-meta">
        <TierBadge tier={tier} />
        <span>{school.majors[0]}</span>
      </div>
      {!compact && <p className="muted">{school.description}</p>}
      <div className="school-bottom">
        <span>
          参考位次 <b>{school.rank.toLocaleString()}</b>
          <small>示例 · 2025</small>
        </span>
        <button
          className="round-add"
          aria-label={`将${school.name}加入志愿`}
          disabled={inPlan || saving}
          onClick={() => void add()}
        >
          {inPlan ? <Check size={17} /> : <Plus size={17} />}
        </button>
      </div>
    </article>
  );
}
export function Empty({
  text,
  action,
  onAction,
}: {
  text: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="empty">
      <span>✧</span>
      <p>{text}</p>
      {action && (
        <button className="button" onClick={onAction}>
          {action}
          <ArrowRight size={15} />
        </button>
      )}
    </div>
  );
}
export function LinkButton({
  children,
  onClick,
}: {
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="text-button" onClick={onClick}>
      {children}
      <ArrowUpRight size={15} />
    </button>
  );
}
