import { codeOf } from "./api";
import type { Localized } from "./localized";

/**
 * The risk register: types of what `/api/v1/risks` answers, and the
 * register's filters as the address holds them. The screens keep no copy of
 * the rules: what a reader may do comes as `moves`.
 */

export const bands = ["low", "medium", "high", "extreme"] as const;
export type Band = (typeof bands)[number];

export type Rating = {
  likelihood: number;
  impact: number;
  score: number;
  band: Band;
};
export type RatingKind = "inherent" | "current" | "target";
export const ratingKinds = ["inherent", "current", "target"] as const;
export type RatingInput = {
  likelihood: number;
  impact: number;
  rationale?: Localized | null;
};

export type Standing =
  | "within"
  | "above_treated"
  | "above_not_addressed"
  | "above_accepted";
export const riskStatuses = ["proposed", "open", "closed", "rejected"] as const;
export type RiskStatus = (typeof riskStatuses)[number];
export const treatments = ["reduce", "avoid", "share", "accept"] as const;
export type Treatment = (typeof treatments)[number];

export type Move =
  | "edit"
  | "rate"
  | "add_control"
  | "review"
  | "add_action"
  | "escalate"
  | "de_escalate"
  | "correct"
  | "link_incident"
  | "request_acceptance"
  | "withdraw_acceptance"
  | "approve_acceptance"
  | "return_acceptance"
  | "close"
  | "request_closure"
  | "approve_closure"
  | "return_closure"
  | "reopen"
  | "accept_proposal"
  | "reject_proposal";
export type ActionMove = "edit" | "complete" | "verify" | "cancel" | "reopen";

/**
 * The tone of a band is fixed here, never by the client (spec, "Colours of
 * the bands"), and its name is always shown with it: never colour alone.
 */
export const bandTone = {
  low: "neutral",
  medium: "warn",
  high: "danger",
  extreme: "alert",
} as const satisfies Record<Band, string>;

/** The tint of a band's cell in a matrix: the same tones, lighter. */
export const bandCell: Record<Band, string> = {
  low: "bg-surface",
  medium: "bg-warn-soft",
  high: "bg-danger-soft",
  extreme: "bg-danger text-background",
};

export type Level = {
  level: number;
  label: Localized;
  descriptor: Localized | null;
  frequency: Localized | null;
};
export type Domain = {
  id: string;
  name: Localized;
  descriptors: Record<string, Localized>;
  position: number;
  active: boolean;
};
export type MatrixBand = {
  code: Band;
  name: Localized;
  reviewIntervalDays: number;
  escalateToCommitteeId: string | null;
  acceptanceNeedsSignature: boolean;
};
export type MatrixStatus = "draft" | "in_use" | "retired";
export type Matrix = {
  id: string;
  version: number;
  status: MatrixStatus;
  likelihoodLevels: number;
  impactLevels: number;
  putInUseAt: string | null;
  putInUseBy: string | null;
  revision: number;
  likelihood: Level[];
  impact: Level[];
  domains: Domain[];
  bands: MatrixBand[];
  cells: { likelihood: number; impact: number; band: Band }[];
  preview?: {
    risksChangingBand: number;
    risksOutOfRange: number;
    risksTargetAboveCurrent: number;
  } | null;
};
export type MatrixHead = Pick<
  Matrix,
  | "id"
  | "version"
  | "status"
  | "likelihoodLevels"
  | "impactLevels"
  | "putInUseAt"
  | "putInUseBy"
  | "revision"
>;

export const appetites = [
  "averse",
  "minimal",
  "cautious",
  "open",
  "eager",
] as const;
export type Appetite = (typeof appetites)[number];
export type Category = {
  id: string;
  code: string;
  name: Localized;
  position: number;
  active: boolean;
  appetite: Appetite;
  appetiteStatement: Localized | null;
  toleranceBand: Band;
  revision: number;
};
export type Committee = {
  id: string;
  code: string;
  name: Localized;
  position: number;
  memberRoleId: string | null;
  chairRoleId: string | null;
  active: boolean;
  revision: number;
};

export type RiskSettings = {
  inherentRequired: boolean;
  frameworkDocumentId: string | null;
  frameworkDocument: {
    id: string;
    restricted: boolean;
    number: string | null;
    status: "draft" | "active" | "retired" | null;
    title: Localized | null;
  } | null;
  assessmentThresholdBand: Band;
  acceptanceMaxMonths: number;
  revision: number;
  matrix: Matrix | null;
  categories: Category[];
  committees: Committee[];
};

export type NameMap = Record<string, Localized>;
export type Names = {
  people: NameMap;
  units: NameMap;
  categories?: NameMap;
  committees?: NameMap;
};

export type RiskSummary = {
  id: string;
  reference: string;
  title: Localized;
  orgUnitId: string | null;
  categoryId: string;
  ownerId: string;
  status: RiskStatus;
  inherent: Rating | null;
  current: Rating | null;
  target: Rating | null;
  tolerance: Band;
  standing: Standing | null;
  trend: "up" | "down" | null;
  nextReviewOn: string | null;
  review: "due" | "overdue" | null;
  escalatedToCommitteeId: string | null;
  rerateNeeded: boolean;
  targetAboveCurrent: boolean;
  lastReviewedOn: string | null;
  actions: { open: number; overdue: number };
  acceptedUntil?: string | null;
  closureRequested?: boolean;
  updatedAt: string;
};

export type RiskList = Names & {
  items: RiskSummary[];
  total: number;
};

export type Effectiveness =
  | "not_assessed"
  | "effective"
  | "partly_effective"
  | "ineffective";
export const effectivenessLevels = [
  "not_assessed",
  "effective",
  "partly_effective",
  "ineffective",
] as const;
export const controlKinds = ["preventive", "detective", "mitigating"] as const;
export const hierarchies = [
  "elimination",
  "substitution",
  "engineering",
  "administrative",
  "protective_equipment",
] as const;
export type Hierarchy = (typeof hierarchies)[number];

export type LinkedDocument = {
  id: string;
  restricted: boolean;
  number: string | null;
  status: string | null;
  version?: number | null;
  nextReviewOn?: string | null;
  pastReview?: boolean;
  title: Localized | null;
};

export type Control = {
  id: string;
  description: Localized;
  kind: (typeof controlKinds)[number];
  hierarchy: Hierarchy | null;
  ownerId: string;
  effectiveness: Effectiveness;
  assessedOn: string | null;
  documentId: string | null;
  document: LinkedDocument | null;
  active: boolean;
  inactiveReason: string | null;
  flag?: "document_retired" | "document_past_review" | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
};

export const actionStrengths = ["stronger", "intermediate", "weaker"] as const;
export type ActionStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "verified"
  | "cancelled";
export type Action = {
  id: string;
  reference: string;
  sourceType: "risk";
  riskId: string;
  title: Localized;
  description: Localized | null;
  ownerId: string;
  orgUnitId: string | null;
  dueOn: string;
  originalDueOn: string;
  dueMoved: boolean;
  strength: (typeof actionStrengths)[number];
  hierarchy: Hierarchy | null;
  status: ActionStatus;
  completedAt: string | null;
  completedBy: string | null;
  completionNote: string | null;
  effectiveness: "effective" | "not_effective" | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  verificationNote: string | null;
  cancelReason: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  overdue: boolean;
  editable: "all" | "progress" | null;
  moves: ActionMove[];
};

export type TimelineEvent = {
  id: string;
  kind: string;
  actorId: string | null;
  occurredAt: string;
  details: Record<string, unknown> | null;
};

export type ActionPage = Action & {
  risk: {
    id: string;
    reference: string;
    title: Localized | null;
    current: Rating | null;
    access?: string;
  };
  events: TimelineEvent[];
  people: NameMap;
  units: NameMap;
};

export type ReviewOutcome =
  | "no_change"
  | "re_rated"
  | "treatment_changed"
  | "closure_proposed";
export const reviewOutcomes = [
  "no_change",
  "re_rated",
  "treatment_changed",
  "closure_proposed",
] as const;

export type Run = {
  id: string;
  status: "in_progress" | "approved" | "returned" | "cancelled";
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
  steps: {
    position: number;
    kind: "review" | "approve";
    assigneeUserId: string | null;
    assigneeRoleId: string | null;
    status: string;
    dueAt: string | null;
    decidedBy: string | null;
    decidedAt: string | null;
    comment: string | null;
    signatureId: string | null;
  }[];
};

export type Signature = {
  id: string;
  userId: string;
  meaning: "reviewed" | "risk_accepted" | "risk_closure_approved";
  signedAt: string;
  contentHash: string;
  method: string;
};

export type Acceptance = {
  id: string;
  requestedBy: string;
  requestedAt: string;
  rationale: Localized;
  conditions: Localized | null;
  untilOn: string;
  ratingId: string;
  score: number;
  bandCode: Band;
  toleranceBand: Band;
  categoryId: string;
  status: "in_approval" | "accepted" | "returned" | "withdrawn" | "lapsed";
  approvalRunId: string | null;
  decidedAt: string | null;
  lapsedReason: "last_day" | "score_risen" | "category_changed" | null;
  lapsedAt: string | null;
  run: Run | null;
  signatures: Signature[];
};

export type Note = {
  id: string;
  kind:
    | "change_reason"
    | "escalation_reason"
    | "de_escalation_reason"
    | "reopen_reason"
    | "withdraw_reason";
  text: string;
  writtenBy: string;
  writtenAt: string;
  correctedAt: string | null;
};

export type IncidentLink = {
  linkId: string;
  kind: "raised" | "supports";
  note: string | null;
  linkedBy: string;
  linkedAt: string;
  incident: {
    id: string;
    reference: string;
    type: string;
    categoryId: string | null;
    orgUnitId: string | null;
    occurredOn: string;
    harmLevel: string | null;
    status: string;
  };
};

export type RatingRecord = Rating & {
  id: string;
  kind: RatingKind;
  matrixId: string;
  rationale: Localized | null;
  ratedBy: string;
  ratedAt: string;
  reviewId: string | null;
};

export type Review = {
  id: string;
  dueOn: string | null;
  reviewedOn: string;
  reviewedBy: string;
  committeeId: string | null;
  outcome: ReviewOutcome;
  comment: string;
  nextReviewOn: string | null;
  late: boolean;
  createdAt: string;
};

export type Risk = RiskSummary &
  Names & {
    access: "full";
    cause: Localized | null;
    event: Localized | null;
    consequence: Localized | null;
    source: "manual" | "incident" | "assessment" | "investigation" | "ai_suggestion";
    treatment: Treatment | null;
    targetOn: string | null;
    references: string[];
    keywords: string[];
    escalatedAt: string | null;
    highestBand: Band | null;
    closureSignOffNeeded: boolean;
    currentAboveInherent: boolean;
    rejectedBy: string | null;
    rejectedAt: string | null;
    rejectReason: string | null;
    createdBy: string;
    createdAt: string;
    matrixId: string | null;
    revision: number;
    moves: Move[];
    ratings: RatingRecord[];
    reviews: Review[];
    actions: Action[];
    actionSummary: { open: number; overdue: number; allWeaker: boolean };
    controls: Control[];
    events: TimelineEvent[];
    acceptanceId?: string | null;
    acceptances?: Acceptance[];
    closure?: {
      requestedBy: string | null;
      requestedAt: string | null;
      closeReason: string | null;
      mergedIntoId: string | null;
      closedBy: string | null;
      closedAt: string | null;
      runs: Run[];
      signatures: Signature[];
    } | null;
    incidents?: {
      items: IncidentLink[];
      hidden: number;
      last12Months: number;
      categories: NameMap;
    } | null;
    notes?: Note[];
  };

/** One of its actions' owner, who reads only that much of the risk. */
export type RiskInBrief = {
  access: "summary";
  id: string;
  reference: string;
  title: Localized;
  status: RiskStatus;
  current: Rating | null;
  moves: [];
  actions: Action[];
  people?: NameMap;
  units?: NameMap;
};

/** A risk the reader no longer sees: after taking it off a list, or a decision. */
export type RiskGone = {
  access: "none";
  id: string;
  reference: string;
};

export type RiskAnswer = Risk | RiskInBrief | RiskGone;

export type Mine = {
  risks: RiskSummary[];
  actions: (Action & {
    risk: { id: string; reference: string; title: Localized | null; current: Rating | null };
  })[];
  committees: { id: string; name: Localized; risks: number }[];
  steps: ApprovalItem[];
  people?: NameMap;
  units?: NameMap;
  categories?: NameMap;
  committeesNames?: NameMap;
};

export type ApprovalItem = {
  subject: "acceptance" | "closure";
  runId: string;
  acceptanceId: string | null;
  riskId: string;
  reference: string;
  title: Localized;
  currentBand: Band | null;
  position: number;
  step: "review" | "approve";
  dueAt: string | null;
  overdue: boolean;
  requestedBy: string;
  requestedAt: string;
};

export type RiskSummaryFigures = {
  openRisks: number;
  highAndExtreme: number;
  aboveToleranceNotAddressed: number;
  reviewsOverdue: number;
  overdueActions: {
    code: string;
    count: number;
    of: number;
    percent: number | null;
    target: number;
    dueDaysMoved: number;
  };
};

export type ApprovalRoute = {
  id: string;
  name: Localized;
  subject: "risk_acceptance" | "risk_closure";
  variant: "medium" | "high" | "extreme" | null;
  active: boolean;
  revision: number;
  steps: {
    position: number;
    kind: "review" | "approve";
    userId: string | null;
    roleId: string | null;
    dueInDays: number;
    userName: Localized | null;
    roleName: Localized | null;
  }[];
};

export type PickerRole = { id: string; code: string; name: Localized; isSystem: boolean };
export type PickerPerson = { id: string; name: Localized; orgUnitId: string | null };

// The register's filters, held in the address.

export const registerSorts = ["score", "next_review", "reference", "updated"] as const;

export type RegisterFilters = {
  q: string;
  /** A unit id, or `whole` for the risks of the whole organization. */
  unitId: string;
  categoryId: string;
  ownerId: string;
  committeeId: string;
  band: Band | "";
  status: RiskStatus | "";
  mine: boolean;
  aboveTolerance: boolean;
  notAddressed: boolean;
  review: "" | "due" | "overdue";
  sort: (typeof registerSorts)[number];
  page: number;
};

export const noRegisterFilters: RegisterFilters = {
  q: "",
  unitId: "",
  categoryId: "",
  ownerId: "",
  committeeId: "",
  band: "",
  status: "",
  mine: false,
  aboveTolerance: false,
  notAddressed: false,
  review: "",
  sort: "score",
  page: 1,
};

const oneOf = <T extends string>(list: readonly T[], value: string | null) =>
  value !== null && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

const uuid = (value: string | null) =>
  value && /^[0-9a-f-]{36}$/i.test(value) ? value : "";

/** The register's filters, from its address. Anything unreadable is left out. */
export function readRegisterFilters(params: {
  get(name: string): string | null;
}): RegisterFilters {
  const page = Number(params.get("page"));
  const unit = params.get("unitId");
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    unitId: unit === "whole" ? "whole" : uuid(unit),
    categoryId: uuid(params.get("categoryId")),
    ownerId: uuid(params.get("ownerId")),
    committeeId: uuid(params.get("committeeId")),
    band: oneOf(bands, params.get("band")) ?? "",
    status: oneOf(riskStatuses, params.get("status")) ?? "",
    mine: params.get("mine") === "true",
    aboveTolerance: params.get("aboveTolerance") === "true",
    notAddressed: params.get("notAddressed") === "true",
    review: oneOf(["due", "overdue"] as const, params.get("review")) ?? "",
    sort: oneOf(registerSorts, params.get("sort")) ?? "score",
    page: Number.isInteger(page) && page >= 1 && page <= 100_000 ? page : 1,
  };
}

/** Only what differs from the plain register is written in the address. */
export function registerQuery(filters: Partial<RegisterFilters>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries({
    ...noRegisterFilters,
    ...filters,
  })) {
    if (value !== noRegisterFilters[name as keyof RegisterFilters]) {
      query.set(name, String(value));
    }
  }
  return query.toString();
}

export function registerPath(
  lang: string,
  filters: Partial<RegisterFilters> = {},
): string {
  const query = registerQuery(filters);
  return `/${lang}/risks${query ? `?${query}` : ""}`;
}

export const riskPath = (lang: string, id: string) => `/${lang}/risks/${id}`;
export const actionPath = (lang: string, id: string) =>
  `/${lang}/risks/actions/${id}`;
export const committeePath = (lang: string, id: string) =>
  `/${lang}/risks/committees/${id}`;

/** The band a matrix gives a place, or null outside it. */
export function bandAt(
  matrix: Pick<Matrix, "cells">,
  likelihood: number,
  impact: number,
): Band | null {
  return (
    matrix.cells.find((c) => c.likelihood === likelihood && c.impact === impact)
      ?.band ?? null
  );
}

/** A refusal that means the page shows an older state than the API's. */
export const isStale = (err: unknown) =>
  [
    "stale_risk",
    "stale_control",
    "stale_action",
    "stale_settings",
    "stale_matrix",
    "stale_category",
    "stale_committee",
    "stale_route",
    "not_editable",
    "not_proposed",
    "not_on_register",
    "not_draft",
    "not_in_approval",
    "not_current_step",
    "not_closed",
    "action_not_open",
    "action_not_completed",
  ].includes(codeOf(err) ?? "");
