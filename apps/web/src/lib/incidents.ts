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
  "awaiting_sign_off",
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

/**
 * What a change of status is, whatever status it leads to. The API names it
 * on every move it offers; buttons, notes and timeline wording follow it.
 */
export const moveKinds = [
  "start",
  "close",
  "reject",
  "reopen",
  "request_sign_off",
  "sign_off",
  "send_back",
  "withdraw",
] as const;
export type MoveKind = (typeof moveKinds)[number] | (string & {});

/**
 * Who did something, when no person is named. `byReporter`: the reporter,
 * whose name this reader may not see (or who gave none). `byStaff`: someone
 * at the hospital, for a reader who came with a follow-up code and is not
 * shown staff names.
 */
type Unnamed = { byReporter: boolean; byStaff?: boolean };

/** A changed value as an event records it: the new shape, or the older plain one. */
export type Was<T> = T | { from: T; to: T };

/** One entry on the timeline. What `details` holds depends on the kind. */
export type IncidentEvent = {
  id: string;
  occurredAt: string;
  /** Null when the reader is not shown who it was: see `Unnamed`. */
  actor: Named | null;
  fromStatus: IncidentStatus | null;
  toStatus: IncidentStatus | null;
} & Unnamed &
  (
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
        kind: "closed" | "rejected" | "reopened" | "signed_off";
        details: Note;
      }
    | {
        /** A request for sign-off taken back carries `withdrawn`. */
        kind: "status_changed";
        details: { note: string | null; withdrawn?: boolean } | null;
      }
    | {
        /** The note is the closure summary being proposed. */
        kind: "sign_off_requested";
        details: Note;
      }
    | {
        /** Its note is not for the reporter: null in the reporter's view. */
        kind: "sent_back";
        details: Note;
      }
    | {
        kind: "commented";
        details: { commentId: string; visibility: CommentVisibility };
      }
  );

export type IncidentComment = Unnamed & {
  id: string;
  /** Null when the reader is not shown who wrote it. */
  author: Named | null;
  body: string;
  visibility: CommentVisibility;
  createdAt: string;
};

/** An org unit as an incident names it: still named when switched off. */
type Unit = Named & { active: boolean };

/** A change of status the caller may make now, as the API offers it. */
export type StatusMove = {
  to: IncidentStatus;
  noteRequired: boolean;
  /** Sent back with the change: two moves can lead to the same status. */
  kind: MoveKind;
};

export type Incident = Omit<
  IncidentListItem,
  "descriptionExcerpt" | "assignedToMe" | "orgUnit" | "ownerUnit"
> & {
  orgUnit: Unit;
  ownerUnit: Unit | null;
  description: string;
  immediateAction: string | null;
  /**
   * Whether this reader may know who reported it. When false, `reporter` is
   * null and says nothing: a named and an anonymous report look the same.
   */
  reporterShown: boolean;
  /** With `reporterShown`: null means it was reported anonymously. */
  reporter: Named | null;
  /** How it arrived. Null when the reporter is not shown. */
  channel: "app" | "public" | null;
  /** A sentinel event or a death: closing it takes a second person. */
  needsSignOff: boolean;
  /** Who asked for it to be closed, while it awaits sign-off. */
  closureRequestedBy: Named | null;
  closureRequestedAt: string | null;
  /** Always null for someone who sees the incident only as its reporter. */
  assignedTo: Named | null;
  triagedAt: string | null;
  closedAt: string | null;
  /** While it awaits sign-off: the summary being proposed. */
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
  awaiting_sign_off: "ok",
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

/**
 * What the API answers when a report is sent. Someone signed in gets the
 * incident and its reference. Someone who is not gets neither: references
 * run in one series, and one of them would tell a stranger how many
 * incidents the hospital has had.
 */
export type ReportSent = {
  id?: string;
  reference?: string;
  /** Only for an anonymous report, and only this once. */
  followUpCode?: string;
};

/**
 * An incident as someone holding its follow-up code reads it: the
 * reporter's view, without its number and with no person named.
 */
export type FollowUpView = Omit<Incident, "id" | "reference">;

/** What the report form needs, for someone who has not signed in. */
export type PublicReporting = {
  name: Localized;
  locales: string[];
  defaultLocale: string;
  orgUnits: {
    id: string;
    parentId: string | null;
    type: "facility" | "department" | "unit";
    name: Localized;
  }[];
  categories: IncidentCategory[];
};
