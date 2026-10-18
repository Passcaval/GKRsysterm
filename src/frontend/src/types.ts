export type Tier = "reach" | "match" | "safe";
export type Signal = "strong" | "medium" | "weak" | "disputed";
export interface User {
  id: string;
  name: string;
  role: "student" | "contributor" | "reviewer";
  verified: boolean;
}
export interface Profile {
  province: string;
  year: number;
  score: number;
  rank: number;
  subjects: string[];
  cities: string[];
  interests: string[];
  budget: number;
  acceptAdjustment: boolean;
  consent: boolean;
}
export interface Source {
  id: string;
  kind: "official" | "experience" | "inference";
  title: string;
  url: string | null;
  year: number;
  retrievedAt: string;
  excerpt: string;
}
export interface School {
  id: string;
  name: string;
  short: string;
  city: string;
  province: string;
  level: string;
  type: string;
  rank: number;
  tuition: number;
  majors: string[];
  requiredSubjects: string[];
  description: string;
  color: string;
  x: number;
  y: number;
  sourceIds: string[];
  history: { year: number; rank: number; score: number }[];
}
export interface Trust {
  identity: number;
  specificity: number;
  corroboration: number;
  freshness: number;
  anomaly: number;
  supporting: number;
  opposing: number;
  explanation: string[];
  expiresAt: string;
  version: string;
}
export interface Post {
  isMine: boolean;
  id: string;
  schoolId: string;
  title: string;
  excerpt: string;
  body: string;
  topic: string;
  author: string;
  year: number;
  signal: Signal;
  helpful: number;
  citations: number;
  status: "published" | "pending" | "rejected";
  trust: Trust;
  sourceIds: string[];
}
export interface Recommendation {
  schoolId: string;
  major: string;
  tier: Tier;
  matchScore: number;
  reasons: string[];
  warnings: string[];
  sourceIds: string[];
  postIds: string[];
}
export interface PlanEntry {
  id: string;
  schoolId: string;
  major: string;
  adjustment: boolean;
}
export interface Plan {
  id: string;
  version: number;
  name: string;
  entries: PlanEntry[];
}
export interface Simulation {
  eligible: boolean;
  warnings: string[];
  assessment: string;
  basisYear: number;
  probabilities: null;
}
export interface Verification {
  id: string;
  status: "pending" | "approved" | "rejected";
  schoolId: string;
  submittedAt: string;
}
export interface ChatEvent {
  type: "tool_start" | "tool_end" | "delta" | "evidence" | "done" | "error";
  text?: string;
  tool?: string;
  sourceIds?: string[];
  conversationId?: string;
}
export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  sourceIds: string[];
}
export interface Bootstrap {
  user: User | null;
  profile: Profile | null;
  schools: School[];
  posts: Post[];
  sources: Source[];
  plan: Plan;
  favorites: string[];
  verifications: Verification[];
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
