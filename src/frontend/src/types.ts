export type Tier = "reach" | "match" | "safe" | "unknown";
export interface CatalogChange {
  identifier: string;
  name: string;
  kind: "new" | "changed" | "unchanged" | "conflict";
  before: Record<string, string | null>;
  after: Record<string, string>;
}
export interface CatalogSummary {
  id: string;
  status: string;
  version: number;
  createdAt: string;
  counts: Record<CatalogChange["kind"], number>;
  officialCounts: { ordinary: number; adult: number; total: number } | null;
  error: string | null;
  review: { reason?: string; publishedCount?: number };
}
export interface CatalogRun extends CatalogSummary {
  changes: CatalogChange[];
  total: number;
  nextOffset: number | null;
  snapshot: {
    asOf?: string | null;
    publicationUrl?: string;
    scopeNote?: string;
    snapshots?: { url: string; label: string; contentHash: string }[];
  };
  analysis: {
    rowsAnalyzed?: number;
    modelName?: string;
    batches?: {
      offset: number;
      count: number;
      summary: string;
      warnings: string[];
    }[];
  };
}
export interface CatalogConfigSummary {
  enabled: boolean;
  autoStart: boolean;
  modelConfigured: boolean;
  modelName: string | null;
  publicationUrl: string;
  scope: string;
}
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
  preferredSchools?: string[];
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
export interface AdmissionKnowledgeSummary {
  enabled: boolean;
  configured: boolean;
  sourceCount: number;
  ttlHours: number;
  latestJob: {
    id: string;
    status: string;
    error: string | null;
    createdAt: string;
  } | null;
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
  matchScore: number | null;
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
export interface ProfileUpdateChange {
  field: string;
  label: string;
  old: unknown;
  new: unknown;
}
export interface ProfileSignalResult {
  signal: {
    signalId: string;
    status: string;
    changes: ProfileUpdateChange[];
    sourceIds: string[];
    question: string;
    queryText?: string;
  };
  profile: Profile | null;
}
export interface ChatEvent {
  type:
    | "tool_start"
    | "tool_end"
    | "delta"
    | "evidence"
    | "profile_update"
    | "done"
    | "error";
  text?: string;
  tool?: string;
  sourceIds?: string[];
  conversationId?: string;
  signalId?: string;
  applied?: boolean;
  profile?: Profile;
  conversationProfile?: Profile;
  changes?: ProfileUpdateChange[];
  expectedVersion?: number;
  question?: string;
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
  majorId?: string;
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
export interface RecommendationBranch {
  branchId: string;
  title: string;
  summary: string;
  pros: string[];
  cons: string[];
  missingFields: string[];
  itemIds: string[];
}
export interface MissingInfo {
  field: string;
  text: string;
  required: boolean;
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
  branches?: RecommendationBranch[];
  missingInfo?: MissingInfo[];
  validation: { status: "pending" | "passed" | "failed"; summary: string };
  lastEventId: number;
  summary: string;
  error: string | null;
}
export interface ProfileSuggestions {
  cities: string[];
  majors: string[];
  schools: { id: string; name: string; city: string }[];
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
export interface CrawlSourceSummary {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  maxDepth: number;
  expect: "auto" | "html" | "pdf";
}

export interface AdmissionSourceSummary {
  configPath: string;
  configError: string | null;
  modelConfigured: boolean;
  modelName: string | null;
  config: {
    version: number;
    scope: {
      provinceCode: string;
      examYear: number;
      examCategory: string;
    };
    sources: CrawlSourceSummary[];
    discovery: {
      enabled: boolean;
      autoStart: boolean;
      entrypoints: string[];
      allowedHosts: string[];
      allowedSuffixes: string[];
      maxDepth: number;
      maxPages: number;
      maxLinksPerPage: number;
      keywords: string[];
    };
    crawl: Record<string, unknown>;
    model: Record<string, unknown>;
    publish: { requireReview: boolean };
    configFingerprint: string;
  } | null;
}

export interface CrawlRunSummary {
  crawlRunId: string;
  status: string;
  triggerType: "startup" | "admin";
  createdAt: string;
  finishedAt: string | null;
  modelName: string | null;
  promptVersion: string | null;
  configFingerprint: string;
  version: number;
  rowCount: number;
  validRowCount: number;
  importIds: string[];
  warningCount: number;
  errorCount: number;
}

export interface CrawlPageSummary {
  pageId: string;
  url: string;
  depth: number;
  status: "pending" | "fetched" | "extracted" | "skipped" | "failed";
  httpStatus: number | null;
  contentType: string | null;
  contentHash: string | null;
  title: string | null;
  fetchedAt: string | null;
  publishedAt: string | null;
  textChars: number;
  rowCount: number;
  hasSnapshot: boolean;
  error: string | null;
}

export interface CrawlRow {
  rowId: string;
  rowFingerprint?: string;
  data: Record<string, unknown>;
  evidence: string;
  locator: string;
  confidence: number | null;
  validation: {
    status: "valid" | "invalid";
    errors: { field: string; message: string }[];
    warnings: string[];
  };
  pageId?: string;
  pageUrl?: string;
  pageTitle?: string | null;
}

export interface CrawlRun extends CrawlRunSummary {
  progress: Record<string, unknown>;
  pagesSummary: Record<string, unknown>;
  warnings: unknown[];
  errors: unknown[];
  rows: CrawlRow[];
  imports: { importId: string; status: string; errors: unknown[] }[];
  review: {
    reviewedAt: string | null;
    reviewedBy: string | null;
    reason: string | null;
  };
  pages: CrawlPageSummary[];
  rowTotal: number;
  rowOffset: number;
  rowLimit: number;
}

export interface CrawlReviewInput {
  decision: "approve" | "reject";
  reason: string;
  expectedVersion: number;
  supersedesImportId?: string | null;
  acknowledgePublishedAtFallback?: boolean;
  rowsOverride?: Record<string, Record<string, unknown>[]> | null;
}

export function hasPermission(user: User | null, permission: string): boolean {
  return !!user?.permissions?.includes(permission);
}
