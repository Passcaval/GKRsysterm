import type { Bootstrap, Profile, User } from "./types";
import contract from "../docs/openapi.json";
import { schemaErrors, operationFor } from "./schema";

export function apiMode(value: unknown, production = false): "mock" | "http" {
  if (value === undefined || value === "") return production ? "http" : "mock";
  if (value !== "mock" && value !== "http")
    throw new Error("VITE_API_MODE 只能为 mock 或 http，请修正构建配置");
  return value;
}
export const isMock =
  apiMode(import.meta.env?.VITE_API_MODE, import.meta.env?.PROD) === "mock";
export const BASE = (import.meta.env?.VITE_API_BASE_URL || "/api/v1").replace(
  /\/$/,
  "",
);
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public requestId?: string,
    public code = "REQUEST_FAILED",
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
let epoch = 0;
const listeners = new Set<() => void>();
const pending = new Set<AbortController>();
export function sessionEpoch() {
  return epoch;
}
export function onSessionReset(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function resetSession() {
  epoch++;
  for (const c of pending) c.abort();
  pending.clear();
  if (typeof sessionStorage !== "undefined")
    for (const k of ["nv-question", "nv-run-question", "nv-atlas-dock"])
      sessionStorage.removeItem(k);
  if (typeof localStorage !== "undefined")
    localStorage.removeItem("nv-compare");
  for (const listener of listeners) listener();
}
export function toWire(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toWire);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [
          k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase()),
          toWire(v),
        ]),
    );
  return value;
}
export function fromWire(value: unknown): any {
  if (Array.isArray(value)) return value.map(fromWire);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
        fromWire(v),
      ]),
    );
  return value;
}
export function profileToWire(p: Profile) {
  return {
    province_code: p.province || null,
    exam_year: p.year,
    exam_category: p.examCategory || "普通类",
    score: p.score,
    rank: p.rank,
    rank_cohort: p.rankCohort || null,
    subjects: p.subjects,
    preferred_regions: p.cities,
    preferred_majors: p.interests,
    preferred_schools: p.preferredSchools || [],
    budget: {
      amount: p.budget,
      currency: p.budgetCurrency || "CNY",
      period: p.budgetPeriod || "year",
      scope: p.budgetScope || "tuition",
    },
    accept_adjustment: p.acceptAdjustment,
    consent: p.consent,
    preferences: toWire(p.preferences || []),
  };
}
export function profileFromWire(raw: any): Profile {
  const p = fromWire(raw);
  if (
    !p ||
    typeof p.version !== "number" ||
    typeof p.profileVersionId !== "string" ||
    !Array.isArray(p.subjects)
  )
    throw new ApiError(
      502,
      "画像响应缺少版本或选科信息",
      undefined,
      "SCHEMA_INVALID",
    );
  return {
    ...p,
    province: p.provinceCode ?? "",
    year: p.examYear,
    score: p.score ?? null,
    rank: p.rank ?? null,
    cities: p.preferredRegions ?? [],
    interests: p.preferredMajors ?? [],
    preferredSchools: p.preferredSchools ?? [],
    budget: p.budget?.amount ?? null,
    budgetCurrency: p.budget?.currency ?? "CNY",
    budgetPeriod: p.budget?.period ?? "year",
    budgetScope: p.budget?.scope ?? "tuition",
    acceptAdjustment: p.acceptAdjustment ?? false,
    consent: p.consent ?? false,
  };
}
export function userFromWire(raw: any): User {
  const u = fromWire(raw);
  if (
    !u ||
    typeof u.id !== "string" ||
    typeof u.userId !== "string" ||
    typeof u.nickname !== "string" ||
    !Array.isArray(u.permissions)
  )
    throw new ApiError(
      502,
      "用户响应格式不符合契约",
      undefined,
      "SCHEMA_INVALID",
    );
  return { ...u, name: u.nickname, verified: u.studentVerified === true };
}
export function bootstrapFromWire(raw: any): Bootstrap {
  const d = fromWire(raw);
  if (
    !d ||
    ![d.schools, d.posts, d.sources, d.favorites, d.verifications].every(
      Array.isArray,
    ) ||
    !d.plan ||
    !Array.isArray(d.plan.entries)
  )
    throw new ApiError(
      502,
      "首屏响应格式不符合契约",
      undefined,
      "SCHEMA_INVALID",
    );
  for (const collection of [d.schools, d.posts, d.sources])
    if (collection.some((x: any) => !x || typeof x.id !== "string"))
      throw new ApiError(502, "资源响应缺少标识", undefined, "SCHEMA_INVALID");
  return {
    ...d,
    user: raw.user ? userFromWire(raw.user) : null,
    profile: raw.profile ? profileFromWire(raw.profile) : null,
  };
}
export interface RequestOptions {
  key?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  auth?: boolean;
  raw?: boolean;
}
export async function request<T>(
  path: string,
  method = "GET",
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const controller = new AbortController();
  const started = epoch;
  pending.add(controller);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 20000);
  try {
    const form = body instanceof FormData;
    const operation = operationFor(contract, path, method);
    const wireBody =
      body === undefined || form ? body : options.raw ? body : toWire(body);
    if (operation?.requestBody && !form) {
      const schema = operation.requestBody.content["application/json"]?.schema;
      const errors = schemaErrors(schema, wireBody, contract, "request");
      if (errors.length)
        throw new ApiError(
          422,
          "请求字段不符合契约",
          undefined,
          "CLIENT_SCHEMA_INVALID",
          { field_errors: { request: errors.slice(0, 6) } },
        );
    }
    const response = await fetch(BASE + path, {
      method,
      credentials: "include",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(!form && body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
        ...(method !== "GET" ? { "X-Requested-With": "NightVoyage" } : {}),
        ...(options.key ? { "Idempotency-Key": options.key } : {}),
        ...options.headers,
      },
      body:
        body === undefined ? undefined : form ? body : JSON.stringify(wireBody),
    });
    const value = await response.json().catch(() => null);
    if (started !== epoch)
      throw new ApiError(
        0,
        "会话已变化，已丢弃旧请求",
        undefined,
        "SESSION_CHANGED",
      );
    if (!response.ok) {
      const error = new ApiError(
        response.status,
        value?.error?.message || `请求失败（${response.status}）`,
        value?.request_id || value?.requestId,
        value?.error?.code || "REQUEST_FAILED",
        value?.error?.details &&
          typeof value.error.details === "object" &&
          !Array.isArray(value.error.details)
          ? value.error.details
          : {},
      );
      if (response.status === 401 && options.auth !== false) resetSession();
      throw error;
    }
    if (!value || !("data" in value))
      throw new ApiError(
        502,
        "接口须返回 JSON data 信封",
        value?.request_id,
        "SCHEMA_INVALID",
      );
    if (operation) {
      const responseSchema =
        operation.responses[String(response.status)]?.content?.[
          "application/json"
        ]?.schema;
      if (!responseSchema)
        throw new ApiError(
          502,
          `成功状态码${response.status}不符合约定`,
          value.request_id,
          "SCHEMA_INVALID",
        );
      const errors = schemaErrors(responseSchema, value, contract, "response");
      if (errors.length)
        throw new ApiError(
          502,
          "响应字段不符合契约",
          value.request_id,
          "SCHEMA_INVALID",
          { field_errors: { response: errors.slice(0, 6) } },
        );
    }
    return (options.raw ? value.data : fromWire(value.data)) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (options.signal?.aborted)
      throw new DOMException("已停止监听", "AbortError");
    throw new ApiError(
      0,
      controller.signal.aborted
        ? "请求超时或会话已切换"
        : "暂时无法连接服务，请稍后重试",
      undefined,
      controller.signal.aborted ? "REQUEST_ABORTED" : "NETWORK_ERROR",
    );
  } finally {
    clearTimeout(timer);
    pending.delete(controller);
    options.signal?.removeEventListener("abort", abort);
  }
}
export async function protectedBlob(path: string): Promise<Blob> {
  const started = epoch,
    controller = new AbortController();
  pending.add(controller);
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(BASE + path, {
      credentials: "include",
      signal: controller.signal,
    });
    if (started !== epoch) throw new ApiError(0, "会话已变化，已丢弃原件请求");
    if (response.status === 401) resetSession();
    if (!response.ok)
      throw new ApiError(response.status, "无法读取受保护的原始材料");
    const blob = await response.blob();
    if (started !== epoch) throw new ApiError(0, "会话已变化，已丢弃原件请求");
    return blob;
  } finally {
    clearTimeout(timer);
    pending.delete(controller);
  }
}
export function errorText(error: unknown): string {
  if (!(error instanceof ApiError))
    return error instanceof Error ? error.message : String(error);
  const fields = error.details.field_errors;
  const fieldText =
    fields && typeof fields === "object"
      ? Object.entries(fields)
          .map(([k, v]) => `${k}：${Array.isArray(v) ? v.join("、") : v}`)
          .join("；")
      : "";
  const missing = Array.isArray(error.details.missing_fields)
    ? `待补充：${error.details.missing_fields.join("、")}`
    : "";
  return [
    error.message,
    fieldText,
    missing,
    error.requestId ? `请求编号 ${error.requestId}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
export function beijingTime(value: string, withTime = true) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(withTime ? ({ hour: "2-digit", minute: "2-digit" } as const) : {}),
  }).format(date);
}
