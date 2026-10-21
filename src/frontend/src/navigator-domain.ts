import type { Profile } from "./types.ts";

export const examSubjects = [
  "物理",
  "化学",
  "生物",
  "历史",
  "地理",
  "政治",
  "技术",
];
export const examProvinces = [
  "浙江",
  "北京",
  "天津",
  "河北",
  "山西",
  "内蒙古",
  "辽宁",
  "吉林",
  "黑龙江",
  "上海",
  "江苏",
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
];
export function blankProfile(): Profile {
  return {
    province: "",
    year: 2026,
    rank: null,
    score: null,
    subjects: [],
    cities: [],
    interests: [],
    preferredSchools: [],
    budget: null,
    acceptAdjustment: false,
    consent: false,
    version: 0,
  };
}
export function splitPreferences(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，、]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}
export function cleanNavigatorProfile(profile: Profile): Profile {
  return {
    ...profile,
    cities: splitPreferences(profile.cities.join(",")),
    interests: splitPreferences(profile.interests.join(",")),
    preferredSchools: splitPreferences(
      (profile.preferredSchools || []).join(","),
    ),
  };
}
