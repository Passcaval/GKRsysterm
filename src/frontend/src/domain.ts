import type { Profile, School, Tier, PlanEntry } from "./types.ts";
export const tierLabel: Record<Tier, string> = {
  reach: "冲",
  match: "稳",
  safe: "保",
  unknown: "待确认",
};
export const tierSymbol: Record<Tier, string> = {
  reach: "▲",
  match: "●",
  safe: "■",
  unknown: "◇",
};
export function rankPosition(
  rank: number | null,
  ranks: (number | null)[],
): number {
  if (rank === null) return 50;
  const valid = ranks.filter(
    (x): x is number => x !== null && Number.isFinite(x) && x > 0,
  );
  if (!valid.length) return 50;
  const min = Math.log(Math.min(...valid)),
    max = Math.log(Math.max(...valid));
  if (max === min) return 50;
  return Math.max(
    10,
    Math.min(88, 10 + (78 * (max - Math.log(Math.max(1, rank)))) / (max - min)),
  );
}
export function classify(
  rank: number | null,
  schoolRank: number | null,
  risk = 50,
): Tier {
  if (!rank || !schoolRank) return "unknown";
  const ratio = rank / schoolRank;
  return ratio > 1.08 - (risk - 50) / 500
    ? "reach"
    : ratio < 0.78 - (risk - 50) / 600
      ? "safe"
      : "match";
}
export function validateProfile(p: Profile): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(p.year) || p.year < 2024 || p.year > 2035)
    errors.push("请填写 2024–2035 年的报考年份");
  if (
    p.score !== null &&
    (!Number.isInteger(p.score) || p.score < 0 || p.score > 900)
  )
    errors.push("分数必须为 0–900 的整数，请按所在省份的计分规则填写");
  if (
    p.rank !== null &&
    (!Number.isInteger(p.rank) || p.rank < 1 || p.rank > 5000000)
  )
    errors.push("请输入有效的省内位次");
  if (new Set(p.subjects).size !== p.subjects.length || p.subjects.length > 3)
    errors.push("选科不能重复，当前支持最多三门选考科目");
  if (p.budget !== null && (p.budget < 0 || !Number.isFinite(p.budget)))
    errors.push("学费预算不能为负数");
  if (!p.consent) errors.push("请同意使用档案信息生成建议");
  return errors;
}
export function eligible(p: Profile, s: School) {
  return s.requiredSubjects.every((x) => p.subjects.includes(x));
}
export function moveEntry(entries: PlanEntry[], from: number, to: number) {
  const next = [...entries];
  if (from < 0 || to < 0 || from >= next.length || to >= next.length)
    return next;
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}
