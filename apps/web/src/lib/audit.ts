import type { Localized } from "./localized";

/** The areas the trail's entries fall under, in the order the filter offers them. */
export const auditAreas = [
  "sign_in",
  "accounts",
  "organization",
  "incidents",
  "documents",
  "exports",
  "trustline",
  "audit",
  "reports",
] as const;
export type AuditArea = (typeof auditAreas)[number];

/** The kinds of record an entry may be about, as the record filter offers them. */
export const auditEntityTypes = [
  "user",
  "role",
  "tenant",
  "org_unit",
  "incident",
  "document",
  "document_type",
  "document_category",
  "approval_route",
  "subscription",
  "ai_draft",
] as const;

/** Who acted. A person's name is theirs now; the reporter may be masked. */
export type AuditActor =
  | {
      kind: "person";
      id: string;
      name: Localized | null;
      /** An external reviewer, not a member of staff. */
      external?: boolean;
    }
  | { kind: "trustline_staff"; name: string | null }
  | { kind: "system" }
  | { kind: "reporter" }
  | { kind: "anonymous" };

export type AuditEntry = {
  id: string;
  /** Its number in the chain. */
  seq: number;
  at: string;
  actor: AuditActor;
  /** May be an action added to the API after this app was built. */
  action: string;
  area: string;
  entity: {
    type: string;
    id: string;
    /** A reference or number, or a name per language; null when gone. */
    label: string | Localized | null;
    canOpen: boolean;
  } | null;
  /** Raw values: the CSV and the chain file hold them; the screen does not word them. */
  details: Record<string, unknown> | null;
  /**
   * What the entry recorded, worded by the API in the request's language,
   * field first (language review 10). Missing from an API that does not
   * word them yet: then no details are shown.
   */
  detailLines?: string[];
  /** Given for sign-in entries only, while it is kept. */
  ip: string | null;
  /** Recorded before the trail was sealed. */
  sealedLate: boolean;
};

export type AuditPage = {
  items: AuditEntry[];
  more: boolean;
  next: string | null;
  total: number;
  /** The total is at least this: counted no further. */
  totalCapped: boolean;
};

/** What the daily check found wrong, in its own words. */
export type AuditBreakKind =
  | "content_changed"
  | "missing_entry"
  | "missing_seal"
  | "gap"
  | "head_rewound"
  | "backdated"
  | "bad_checkpoint"
  | (string & {});

export type AuditStatus = {
  head: { seq: number; at: string } | null;
  lastCheck: {
    at: string;
    result: "passed" | "failed" | (string & {});
    full: boolean;
    fromSeq: number | null;
    toSeq: number | null;
    kind: AuditBreakKind | null;
    firstBadSeq: number | null;
    firstBadEntryId: string | null;
    /** The checkpoint's signature holds. */
    signed: boolean;
  } | null;
  /** The first break found; it stays even after a later check passes. */
  broken: {
    at: string;
    kind: AuditBreakKind;
    firstBadSeq: number | null;
    firstBadEntryId: string | null;
  } | null;
  sealedOn: string | null;
  /** How many entries were recorded before the trail was sealed. */
  sealedBefore: number;
  /** "unsigned": this deployment signs no checkpoints. */
  signing: "signed" | "unsigned" | (string & {});
};

/** What the viewer is asked for, as the address holds it. */
export type AuditQuery = {
  from: string;
  to: string;
  actorId: string;
  action: string;
  area: string;
  entityType: string;
  entityId: string;
  reference: string;
  before: string;
};

const keys: (keyof AuditQuery)[] = [
  "from",
  "to",
  "actorId",
  "action",
  "area",
  "entityType",
  "entityId",
  "reference",
  "before",
];

export const readAuditQuery = (params: URLSearchParams): AuditQuery =>
  Object.fromEntries(keys.map((k) => [k, params.get(k)?.trim() ?? ""])) as AuditQuery;

/** The address's query for what is asked; empty values left out. */
export function auditQueryString(q: Partial<AuditQuery>): string {
  const out = new URLSearchParams();
  for (const k of keys) {
    const v = q[k];
    if (v) out.set(k, v);
  }
  return out.toString();
}

/** The same, as the API reads it (`actions` for one action). */
export function auditApiQuery(q: AuditQuery): URLSearchParams {
  const out = new URLSearchParams();
  if (q.from) out.set("from", q.from);
  if (q.to) out.set("to", q.to);
  if (q.actorId) out.set("actorId", q.actorId);
  if (q.action) out.set("actions", q.action);
  if (q.area) out.set("area", q.area);
  if (q.reference) out.set("reference", q.reference);
  else if (q.entityType) {
    out.set("entityType", q.entityType);
    if (q.entityId) out.set("entityId", q.entityId);
  }
  return out;
}

/** The viewer, filtered to one record: where a record's "Audit trail" link leads. */
export const auditPathFor = (lang: string, entityType: string, entityId: string) =>
  `/${lang}/admin/audit?${auditQueryString({ entityType, entityId })}`;
/** Every action the trail records, by area, as the API registers them. */
export const auditActionsByArea: Record<AuditArea, readonly string[]> = {
  sign_in: [
    "sign_in",
    "sign_in_failed",
    "sign_out",
    "password_set",
    "password_confirmation_failed",
    "signing_pin_set",
    "signing_pin_reset",
    "signing_pin_locked",
  ],
  accounts: [
    "user_created",
    "user_updated",
    "user_roles_changed",
    "sign_in_link_created",
    "role_created",
    "role_updated",
    "role_deleted",
    "administrator_created_by_platform",
    "built_in_roles_changed_by_system",
    "external_access_granted",
    "external_access_extended",
    "external_access_ended",
  ],
  organization: [
    "org_unit_created",
    "org_unit_updated",
    "org_unit_moved",
    "public_reporting_changed",
    "response_rules_changed",
    "email_setting_changed",
    "notification_preferences_changed",
    "organization_profile_updated",
    "ai_use_changed",
  ],
  incidents: [
    "incident_reported",
    "incident_triaged",
    "incident_status_changed",
    "incident_commented",
    "incident_deadlines_filled",
    "public_reporting_limit_reached",
  ],
  documents: [
    "document_created",
    "document_updated",
    "document_version_created",
    "document_version_edited",
    "document_submitted",
    "document_step_approved",
    "document_returned",
    "document_recalled",
    "document_version_withdrawn",
    "document_publish_scheduled",
    "document_published",
    "document_retired",
    "document_reviewed",
    "document_review_requested",
    "document_review_approved",
    "document_review_returned",
    "document_acknowledged",
    "document_imported",
    "document_import_signed",
    "import_confirmed",
    "document_type_created",
    "document_type_updated",
    "document_category_created",
    "document_category_updated",
    "approval_route_created",
    "approval_route_updated",
    "document_settings_updated",
    "document_design_updated",
    "ai_draft_started",
    "ai_draft_questions_asked",
    "ai_draft_answered",
    "ai_draft_version_created",
    "ai_draft_discarded",
    "ai_draft_handed_over",
    "ai_draft_ownership_taken",
    "ai_drafts_removed_by_system",
    "document_type_changed_by_system",
    "approval_routes_changed_by_system",
    "policy_defaults_reworded_by_system",
    "import_confirmations_corrected_by_system",
    "import_confirmations_backfilled_by_system",
  ],
  exports: [
    "documents_exported",
    "acknowledgements_exported",
    "imports_exported",
    "overdue_acknowledgements_exported",
    "person_acknowledgements_exported",
    "data_export_requested",
    "data_export_approved",
    "data_export_refused",
    "data_export_cancelled",
    "data_export_lapsed",
    "data_export_ready",
    "data_export_failed",
    "data_export_downloaded",
    "data_export_expired",
  ],
  trustline: [
    "subscription_changed",
    "import_window_changed",
    "client_created_by_platform",
    "client_settings_changed_by_platform",
    "ai_settings_changed",
  ],
  audit: [
    "audit_chain_started",
    "audit_entries_exported",
    "audit_chain_exported",
    "audit_checkpoints_exported",
    "external_reviewer_viewed",
    "audit_addresses_cleared",
  ],
  reports: [
    "measures_snapshot_taken",
    "measure_correction_requested",
    "measures_recomputed_by_system",
    "report_settings_changed",
    "measures_exported",
  ],
};
