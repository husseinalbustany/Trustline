import type { Localized } from "./localized";

export const incidentTypes = ["incident", "near_miss", "hazard"] as const;
export type IncidentType = (typeof incidentTypes)[number];

export const harmLevels = [
  "none",
  "mild",
  "moderate",
  "severe",
  "death",
] as const;
export type HarmLevel = (typeof harmLevels)[number];

/** The statuses this app has wording for. */
export const incidentStatuses = [
  "new",
  "triaged",
  "in_progress",
  "closed",
  "rejected",
] as const;
export type KnownStatus = (typeof incidentStatuses)[number];
/**
 * A status as the API sends it. It may be one added to the API after this
 * app was built, so nothing here may assume it is one of the known ones:
 * word it with `wordFor`, colour it with `statusToneOf`.
 */
export type IncidentStatus = KnownStatus | (string & {});

export const sortOrders = ["newest", "oldest", "harm"] as const;
export type SortOrder = (typeof sortOrders)[number];

export type CommentVisibility = "everyone" | "internal";

type Named = { id: string; name: Localized };

export type IncidentCategory = { id: string; code: string; name: Localized };

export type IncidentSummary = {
  open: number;
  awaitingTriage: number;
  closedLast30Days: number;
  /** Open incidents assigned to the caller. */
  assignedToMe: number;
  /** Open incidents that are severe, a death, or a sentinel event. */
  serious: number;
  /**
   * The median time from opening the report form to sending it, over the
   * last 30 days. Null when no report in that time carries a start time.
   */
  medianSecondsToReport: number | null;
};

export type IncidentListItem = {
  id: string;
  reference: string;
  type: IncidentType;
  category: Named;
  orgUnit: Named;
  ownerUnit: Named | null;
  occurredAt: string;
  reportedAt: string;
  harmLevel: HarmLevel;
  isSentinel: boolean;
  status: IncidentStatus;
  assignedToMe: boolean;
  descriptionExcerpt: string;
};

export type IncidentList = { items: IncidentListItem[]; total: number };

type Note = { note: string | null } | null;

/** A changed value as an event records it: the new shape, or the older plain one. */
export type Was<T> = T | { from: T; to: T };

/** One entry on the timeline. What `details` holds depends on the kind. */
export type IncidentEvent = {
  id: string;
  occurredAt: string;
  /** Null for the report of an anonymous incident. */
  actor: Named | null;
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus | null;
} & (
  | { kind: "reported"; details: null }
  | {
      kind: "triaged";
      /**
       * Only what the triage changed, each as `{ from, to }`. Events stored
       * before that hold every field as a plain value.
       */
      details: {
        harmLevel?: Was<HarmLevel>;
        isSentinel?: Was<boolean>;
        ownerUnitId?: Was<string | null>;
        categoryId?: Was<string>;
      } | null;
    }
  | {
      kind: "assigned";
      details: { ownerUnitId: string; assignedTo: string | null };
    }
  | {
      kind: "status_changed" | "closed" | "rejected" | "reopened";
      details: Note;
    }
  | {
      kind: "commented";
      details: { commentId: string; visibility: CommentVisibility };
    }
);

export type IncidentComment = {
  id: string;
  author: Named;
  body: string;
  visibility: CommentVisibility;
  createdAt: string;
};

/** An org unit as an incident names it: still named when switched off. */
type Unit = Named & { active: boolean };

/** A change of status the caller may make now, as the API offers it. */
export type StatusMove = { to: IncidentStatus; noteRequired: boolean };

export type Incident = Omit<
  IncidentListItem,
  "descriptionExcerpt" | "assignedToMe" | "orgUnit" | "ownerUnit"
> & {
  orgUnit: Unit;
  ownerUnit: Unit | null;
  description: string;
  immediateAction: string | null;
  /** Null when it was reported anonymously. */
  reporter: Named | null;
  /** Always null for someone who sees the incident only as its reporter. */
  assignedTo: Named | null;
  triagedAt: string | null;
  closedAt: string | null;
  closureSummary: string | null;
  rejectionReason: string | null;
  access: "full" | "reporter";
  /**
   * Raised by every triage and status change (not by a comment); sent back
   * so a decision made on a stale page is refused.
   */
  revision: number;
  /** Names for the ids its events mention, including ones no longer listed. */
  people: Record<string, Localized>;
  units: Record<string, Localized>;
  categories: Record<string, Localized>;
  canTriage: boolean;
  /** The caller may triage it, and its status still allows that. */
  canRetriage: boolean;
  /** The status changes the caller may make now. The API holds the rules. */
  moves: StatusMove[];
  events: IncidentEvent[];
  comments: IncidentComment[];
};

export type AssignableUser = {
  id: string;
  name: Localized;
  orgUnitId: string | null;
};

export type StatusAction = "start" | "close" | "reject" | "reopen";

/**
 * Which wording a status change gets. This is about words only: which
 * changes are allowed, and whether a note is needed, comes from `moves` on
 * the incident. A change this app has no wording for returns null and is
 * shown as "Move to …".
 */
export function moveAction(
  from: IncidentStatus,
  to: IncidentStatus,
): StatusAction | null {
  if (to === "closed") return "close";
  if (to === "rejected") return "reject";
  if (to !== "in_progress") return null;
  // Work that starts for the first time, or again after the incident ended.
  if (from === "triaged") return "start";
  return from === "closed" || from === "rejected" ? "reopen" : null;
}

/**
 * The wording for a code the API sent, or `other` when this app has none
 * for it yet: a raw code is never shown.
 */
export const wordFor = (
  words: Record<string, string>,
  code: string | null | undefined,
  other: string,
): string => (code != null && Object.hasOwn(words, code) ? words[code] : other);

const statusTone: Record<KnownStatus, "ok" | "neutral"> = {
  // Not red: a reporter's fresh report is waiting, not in trouble.
  new: "neutral",
  triaged: "ok",
  in_progress: "ok",
  closed: "neutral",
  rejected: "neutral",
};

export const statusToneOf = (status: IncidentStatus) =>
  Object.hasOwn(statusTone, status)
    ? statusTone[status as KnownStatus]
    : "neutral";

/** Severe harm, a death or a sentinel event: marked so it cannot be missed. */
export const isSerious = (incident: {
  harmLevel: HarmLevel;
  isSentinel: boolean;
}) =>
  incident.isSentinel ||
  incident.harmLevel === "severe" ||
  incident.harmLevel === "death";

export const harmTone = {
  none: "neutral",
  mild: "neutral",
  moderate: "danger",
  severe: "alert",
  death: "alert",
} as const;
