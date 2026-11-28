import type { Localized } from "./localized";

export const aiFeatures = ["drafting", "insights", "assistant"] as const;
export type AiFeature = (typeof aiFeatures)[number];

/** Who processes the requests of a feature, and where. */
export type AiProvider = {
  kind: "anthropic" | "bedrock" | (string & {});
  region: string;
  inferenceType: "in_region" | "regional" | "global" | (string & {});
};

export type AiFeatureState = {
  feature: AiFeature | (string & {});
  offered: boolean;
  active: boolean;
  provider: AiProvider | null;
  /** Only to whole-organization administrators: */
  reason?: string | null;
  model?: string | null;
  quickModel?: string | null;
  allowance?: number | null;
  used?: number;
  warning?: boolean;
  reached?: boolean;
};

export type AiSettings = {
  available: boolean;
  enabled: boolean;
  features: AiFeatureState[];
  month?: string;
  resetsOn?: string;
  medicalOptionAllowed?: boolean;
  switchedBy?: { id: string; name: Localized | null } | null;
  switchedAt?: string | null;
};

/** The AI refusals every feature may answer, with what they carry. */
export const aiRefusals = [
  "ai_not_offered",
  "ai_switched_off",
  "ai_allowance_reached",
  "ai_spending_limit",
  "ai_unavailable",
  "ai_request_too_large",
] as const;

/* ---------- Drafting ---------- */

export type DraftQuestion = { id: string; text: string; reason: string };

export type DraftTurn =
  | { seq: number; kind: "questions"; body: { round: number; questions: DraftQuestion[] } }
  | { seq: number; kind: "answers"; body: { round: number; answers: { questionId: string; answer: string | null }[] } }
  | { seq: number; kind: "revision_request"; body: { instruction: string; locale: string } }
  | { seq: number; kind: string; body: Record<string, unknown> };

export type DraftMark = { section: string; text: string };

export type DraftVersion = {
  number: number;
  author: "assistant" | "person" | (string & {});
  title: Localized;
  content: Record<string, Record<string, string | null>>;
  gaps: DraftMark[];
  assumptions: DraftMark[];
  sources: { documentId: string; number: string; title: Localized }[];
  model: string | null;
  createdAt: string;
};

export type Draft = {
  id: string;
  status: "asking" | "ready" | "drafted" | "handed_over" | (string & {});
  documentTypeId: string;
  locale: string;
  request: string;
  rounds: number;
  maxRounds: number;
  revision: number;
  designId: string | null;
  documentId: string | null;
  handedOverVersion: number | null;
  createdAt: string;
  lastActivityAt: string;
  openQuestions: DraftQuestion[];
  turns: DraftTurn[];
  versions: DraftVersion[];
};

export type DraftSummary = Pick<
  Draft,
  "id" | "status" | "documentTypeId" | "locale" | "request" | "createdAt" | "lastActivityAt"
> & { versions: number };

/** The marks the assistant leaves in its text, in each language. */
export const gapMark = /\[(To be decided|À décider|لم يُحدَّد بعد)\s?:[^\]]*\]/g;
export const assumptionMark = /\[(Assumed|Hypothèse|افتراض)\s?:[^\]]*\]/g;
