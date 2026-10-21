import type {
  CrawlRun,
  Profile,
  RecommendationRun,
  RegistrationInput,
  RunStatus,
} from "./types.ts";
export const terminalRuns: RunStatus[] = [
  "succeeded",
  "partial",
  "failed",
  "cancelled",
];
export const runLabels: Record<RunStatus, string> = {
  queued: "排队中",
  running: "执行中",
  waiting_input: "等待补充",
  validating: "校验中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "执行失败",
  cancelled: "已取消",
};
export function validateNickname(input: string) {
  const value = input.normalize("NFC");
  return (
    [...value].length >= 1 &&
    [...value].length <= 5 &&
    /^[\p{Unified_Ideograph}A-Za-z]+$/u.test(value)
  );
}
export function validEmail(value: string) {
  if (value.length > 254 || /\s|[\x00-\x1f\x7f]/.test(value)) return false;
  const local = value.split("@")[0];
  return (
    local.length <= 64 &&
    !local.startsWith(".") &&
    !local.endsWith(".") &&
    !local.includes("..") &&
    /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
      value,
    )
  );
}
export function validateRegistration(input: RegistrationInput) {
  const errors: string[] = [];
  if (!validateNickname(input.nickname))
    errors.push("昵称需为1–5个汉字或ASCII英文字母，不含空格、数字、标点");
  if (!validEmail(input.email)) errors.push("邮箱格式不符合要求");
  if ([...input.password].length < 8 || [...input.password].length > 128)
    errors.push("密码请使用8–128个字符，不会裁剪空格");
  if (!input.evidenceText.trim() && !input.evidenceAudio)
    errors.push("请至少提供文字或语音证据中的一种");
  if ([...input.evidenceText].length > 3000) errors.push("文字证据最多3000字");
  if (
    input.evidenceAudio &&
    (input.evidenceAudio.size > 10 * 1024 * 1024 ||
      ![
        "audio/webm",
        "audio/ogg",
        "audio/mpeg",
        "audio/mp4",
        "audio/wav",
        "audio/x-wav",
      ].includes(input.evidenceAudio.type.split(";")[0]))
  )
    errors.push("语音需为WebM/OGG/MP3/M4A/WAV且不超过10MiB");
  return errors;
}
export function missingForIntent(profile: Profile | null, intent: string) {
  if (intent === "campus_life") return [];
  const missing: string[] = [];
  if (!profile?.province) missing.push("province_code");
  if (!profile?.year) missing.push("exam_year");
  if ((profile?.subjects?.length || 0) !== 3) missing.push("subjects");
  if (profile?.rank === null || profile?.rank === undefined)
    missing.push("rank");
  if (!profile?.consent) missing.push("consent");
  return missing;
}
export function validateRun(raw: unknown): RecommendationRun {
  const r = raw as RecommendationRun;
  if (
    !r ||
    typeof r.runId !== "string" ||
    !Object.keys(runLabels).includes(r.status) ||
    !Number.isInteger(r.version) ||
    !Array.isArray(r.items) ||
    !Array.isArray(r.questions) ||
    !r.validation ||
    !["pending", "passed", "failed"].includes(r.validation.status) ||
    !Number.isInteger(r.lastEventId)
  )
    throw new Error("推荐任务响应格式不符合契约");
  const ids = new Set<string>();
  for (const item of r.items) {
    if (
      !item ||
      typeof item.recommendationItemId !== "string" ||
      typeof item.admissionUnitId !== "string" ||
      typeof item.schoolId !== "string" ||
      ids.has(item.recommendationItemId) ||
      !["pass", "fail", "unknown"].includes(item.eligibility?.status) ||
      !["reach", "match", "safe", "unknown"].includes(
        item.historicalRisk?.status,
      ) ||
      !item.preferenceMatch ||
      !(
        item.preferenceMatch.score === null ||
        typeof item.preferenceMatch.score === "number"
      ) ||
      !Array.isArray(item.evidenceIds)
    )
      throw new Error("推荐项响应格式不符合契约");
    ids.add(item.recommendationItemId);
  }
  return r;
}
export function visibleRunItems(run: RecommendationRun | null) {
  return run?.validation.status === "passed" &&
    ["succeeded", "partial"].includes(run.status)
    ? run.items.filter((i) => i.eligibility.status !== "fail")
    : [];
}

export function validateCrawlRun(raw: unknown): CrawlRun {
  const run = raw as CrawlRun;
  if (
    !run ||
    typeof run.crawlRunId !== "string" ||
    typeof run.status !== "string" ||
    !Array.isArray(run.pages) ||
    !Array.isArray(run.rows) ||
    !Array.isArray(run.imports)
  )
    throw new Error("抓取任务响应格式不符合契约");
  return run;
}
