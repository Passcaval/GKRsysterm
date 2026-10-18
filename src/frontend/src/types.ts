export type Tier = "reach" | "match" | "safe" | "unknown";
export type Signal = "strong" | "medium" | "weak" | "disputed";
export interface User {
  id: string;
  name: string;
  role: "student" | "contributor" | "reviewer" | "admin";
  verified: boolean;
  userId?: string;
  email?: string;
  emailVerified?: boolean;
  permissions?: string[];
  studentVerificationScopes?: { schoolId: string; scope: string }[];
}
export interface Profile {
  province: string;
  year: number;
  score: number | null;
  rank: number | null;
  subjects: string[];
  cities: string[];
  interests: string[];
  budget: number | null;
  acceptAdjustment: boolean;
  consent: boolean;
  version?: number;
  profileVersionId?: string;
  examCategory?: string;
  rankCohort?: string | null;
  budgetCurrency?: "CNY";
  budgetPeriod?: "year";
  budgetScope?: "tuition" | "total";
  preferences?: {
    field: string;
    value: string;
    strength: "hard" | "soft";
    priority: number;
  }[];
}
export interface Source {
  id: string;
  kind: "official" | "experience" | "inference";
  title: string;
  url: string | null;
  year: number;
  retrievedAt: string;
  excerpt: string;
  version?: string;
  locator?: string | null;
  contentHash?: string | null;
  supportStatus?: "supported" | "refuted" | "unverified" | "withdrawn";
  freshness?: "current" | "expired" | "unknown";
  scope?: string | null;
}
export interface School {
  id: string;
  name: string;
  short: string;
  city: string;
  province: string;
  level: string;
  type: string;
  rank: number | null;
  tuition: number | null;
  majors: string[];
  requiredSubjects: string[];
  description: string;
  color: string;
  x: number;
  y: number;
  sourceIds: string[];
  history: { year: number; rank: number; score: number }[];
  historicalRisk?: Tier;
  dataVersion?: string | null;
}
export interface Trust {
  identity: number | null;
  specificity: number | null;
  corroboration: number | null;
  freshness: number | null;
  anomaly: number | null;
  supporting: number;
  opposing: number;
  explanation: string[];
  expiresAt: string;
  version: string;
}
export interface Post {
  ownerId?: string;
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
  version?: number;
  campusId?: string | null;
  majorId?: string | null;
  experiencedAt?: string | null;
  visibility?: "public" | "private";
  claims?: Claim[];
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
  admissionUnitId?: string;
  recommendationItemId?: string;
  majorId?: string;
  provinceCode?: string;
  examYear?: number;
}
export interface Plan {
  id: string;
  version: number;
  name: string;
  entries: PlanEntry[];
  maxEntries?: number | null;
}
export interface Simulation {
  eligible: boolean | null;
  eligibility?: { status: "pass" | "fail" | "unknown"; reason: string };
  warnings: string[];
  assessment: string;
  basisYear: number;
  probabilities: null;
}
export interface Verification {
  ownerId?: string;
  documentName?: string;
  documentAvailable?: boolean;
  version?: number;
  scope?: string;
  reason?: string | null;
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
export interface AdmissionUnit {
  id: string;
  schoolId: string;
  campusId: string | null;
  campusName: string | null;
  unitType: string;
  provinceCode: string;
  examYear: number;
  examCategory: string;
  batch: string;
  code: string | null;
  majors: { id: string; name: string }[];
  requiredSubjects: string[];
  dataVersion: string;
  sourceIds: string[];
}

export interface Claim {
  id: string;
  text: string;
  sourceVersion: string | null;
  supportStatus: "supported" | "refuted" | "unverified" | "withdrawn";
  freshness: "current" | "expired" | "unknown";
  scope: string | null;
  relations: {
    evidenceId: string;
    relation: "supports" | "refutes" | "background";
  }[];
}
export type CheckStatus = "pass" | "fail" | "unknown";
export type RunStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "validating"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";
export interface RunQuestion {
  field: string;
  text: string;
  required: boolean;
}
export interface RecommendationItem {
  recommendationItemId: string;
  admissionUnitId: string;
  schoolId: string;
  schoolName?: string;
  major: string;
  campusId: string | null;
  eligibility: { status: CheckStatus; missingRequirements: string[] };
  historicalRisk: { status: Tier; reason: string };
  preferenceMatch: {
    score: number | null;
    coverage: number;
    breakdown: { label: string; score: number | null }[];
  };
  reasons: string[];
  evidenceIds: string[];
  warnings: string[];
}
export interface RecommendationRun {
  runId: string;
  status: RunStatus;
  version: number;
  question: string;
  profileVersionId: string | null;
  originalProfileVersionId: string | null;
  dataVersion: string | null;
  ruleVersion: string | null;
  createdAt: string;
  questions: RunQuestion[];
  items: RecommendationItem[];
  validation: { status: "pending" | "passed" | "failed"; summary: string };
  lastEventId: number;
  summary: string;
  error: string | null;
}
export interface CreateRunInput {
  question: string;
  profileVersionId: string | null;
  riskPreference: number;
  intent: "campus_life" | "admission" | "risk";
}
export interface RunEvent {
  eventId: number;
  eventType: "status" | "question" | "result" | "error" | "done";
  runId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
export interface RegistrationApplication {
  applicationId: string;
  reservedUserId: string;
  status: "pending" | "approved" | "rejected";
  version: number;
  nickname: string;
  email: string;
  createdAt: string;
  reason: string | null;
  reviewedAt: string | null;
  evidenceText?: string;
  hasAudio?: boolean;
}
export interface RegistrationReceipt extends RegistrationApplication {
  statusToken: string;
}
export interface RegistrationInput {
  nickname: string;
  email: string;
  password: string;
  evidenceText: string;
  evidenceAudio: File | null;
}
export interface PersonalMemory {
  id: string;
  version: number;
  field: string;
  value: string;
  confirmed: boolean;
}
export interface HistoryEntry {
  runId: string;
  question: string;
  status: RunStatus;
  createdAt: string;
  profileVersionId: string | null;
}
export function hasPermission(user: User | null, permission: string): boolean {
  return !!user?.permissions?.includes(permission);
}
