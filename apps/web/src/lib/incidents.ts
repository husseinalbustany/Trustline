import type { OrgUnit } from "./identity";
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

export type IncidentStatus =
  | "new"
  | "triaged"
  | "in_progress"
  | "closed"
  | "rejected";

export type CommentVisibility = "everyone" | "internal";

type Named = { id: string; name: Localized };

export type IncidentCategory = { id: string; code: string; name: Localized };

export type IncidentSummary = {
  open: number;
  awaitingTriage: number;
  closedLast30Days: number;
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
  descriptionExcerpt: string;
};

export type IncidentList = { items: IncidentListItem[]; total: number };

type Note = { note: string | null } | null;

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
      details: {
        harmLevel: HarmLevel;
        isSentinel: boolean;
        ownerUnitId: string;
        categoryId?: string;
      };
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

export type Incident = Omit<IncidentListItem, "descriptionExcerpt"> & {
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
  canTriage: boolean;
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
 * The status changes the API accepts from each status, so the screen offers
 * exactly those. The API decides; this only mirrors POST /incidents/:id/status.
 */
export const statusMoves: Record<
  IncidentStatus,
  { action: StatusAction; to: IncidentStatus; note: "required" | "optional" }[]
> = {
  new: [{ action: "reject", to: "rejected", note: "required" }],
  triaged: [
    { action: "start", to: "in_progress", note: "optional" },
    { action: "close", to: "closed", note: "required" },
  ],
  in_progress: [{ action: "close", to: "closed", note: "required" }],
  closed: [{ action: "reopen", to: "in_progress", note: "required" }],
  rejected: [{ action: "reopen", to: "in_progress", note: "required" }],
};

/** Triage is accepted only while an incident is new or already triaged. */
export const canBeTriaged = (status: IncidentStatus) =>
  status === "new" || status === "triaged";

export const statusTone = {
  new: "danger",
  triaged: "ok",
  in_progress: "ok",
  closed: "neutral",
  rejected: "neutral",
} as const;

export const harmTone = {
  none: "neutral",
  mild: "neutral",
  moderate: "danger",
  severe: "danger",
  death: "danger",
} as const;

const indent = { facility: "", department: "— ", unit: "— — " };

/**
 * Org units as the options of a select: each one under its parent, indented
 * by level. The API returns them ordered by code, not by place in the tree.
 */
export function unitOptions(
  units: OrgUnit[],
  nameOf: (unit: OrgUnit) => string,
): { id: string; label: string }[] {
  const ids = new Set(units.map((u) => u.id));
  const out: { id: string; label: string }[] = [];
  const seen = new Set<string>();
  const add = (parentId: string | null) => {
    for (const unit of units) {
      const isChild = parentId
        ? unit.parentId === parentId
        : !unit.parentId || !ids.has(unit.parentId);
      if (!isChild || seen.has(unit.id)) continue;
      seen.add(unit.id);
      out.push({ id: unit.id, label: indent[unit.type] + nameOf(unit) });
      add(unit.id);
    }
  };
  add(null);
  return out;
}
