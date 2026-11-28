/**
 * Every action the client's audit trail (`audit_log`) records, in one
 * registry (docs/specs/audit-trail.md, "Wording of actions"). `audit()`
 * takes only an action listed here, checked at compile time; the entries
 * written in raw SQL and by migrations are held to it by
 * `actions.spec.ts`, which fails for any action written anywhere and not
 * listed. Each is worded in `wording/<lang>.ts`, and the web app's
 * dictionaries hold the same keys under `audit.actions`.
 *
 * For each action:
 * - `area`: the viewer's filter it falls under;
 * - `entity`: what `entity_type` it is about (null: about nothing else);
 * - `details`: the keys its `changes` may hold, for the viewer to word;
 * - `maskActor`: its actor may be the reporter of an incident, whom only
 *   holders of `incidents.see_reporter` may see (spec, "Masking");
 * - `by`: who writes it: the application's code, the admin portal
 *   (Trustline's staff, through the platform role), a migration, or the
 *   database itself.
 *
 * Trustline's own log (`platform_audit_log`) is not this registry's: it
 * gets its own chain in a later step (spec, "Order of build", 7).
 */

export const AUDIT_AREAS = [
  'sign_in',
  'accounts',
  'organization',
  'incidents',
  'documents',
  'exports',
  'trustline',
] as const;
export type AuditArea = (typeof AUDIT_AREAS)[number];

export type AuditEntityType =
  | 'user'
  | 'role'
  | 'tenant'
  | 'org_unit'
  | 'incident'
  | 'document'
  | 'document_type'
  | 'document_category'
  | 'approval_route'
  | 'subscription';

type ActionInfo = {
  area: AuditArea;
  entity: AuditEntityType | null;
  details: readonly string[];
  maskActor?: true;
  by: 'code' | 'platform' | 'migration' | 'database';
};

const code = (
  area: AuditArea,
  entity: AuditEntityType | null,
  details: readonly string[],
  extra: Partial<ActionInfo> = {},
): ActionInfo => ({ area, entity, details, by: 'code', ...extra });

/** Written by a migration: says which, and what it changed. */
const migration = (
  area: AuditArea,
  entity: AuditEntityType | null,
  details: readonly string[],
): ActionInfo => ({ area, entity, details: ['migration', ...details], by: 'migration' });

export const AUDIT_ACTIONS = {
  // Sign-in. The address is kept with these (`ip_address`), outside the
  // sealed body, which holds a commitment to it (spec, "Personal data").
  sign_in: code('sign_in', 'user', ['client']),
  sign_in_failed: code('sign_in', 'user', ['locked']),
  sign_out: code('sign_in', 'user', []),
  password_set: code('sign_in', 'user', ['purpose']),
  password_confirmation_failed: code('sign_in', 'user', ['locked', 'purpose', 'byPin', 'pinLocksNow']),
  signing_pin_set: code('sign_in', 'user', ['action']),
  signing_pin_reset: code('sign_in', 'user', []),
  signing_pin_locked: code('sign_in', 'user', ['failures']),

  // Accounts and roles.
  user_created: code('accounts', 'user', []),
  user_updated: code('accounts', 'user', ['changed', 'orgUnitId', 'status']),
  user_roles_changed: code('accounts', 'user', ['before', 'roles']),
  sign_in_link_created: code('accounts', 'user', ['purpose']),
  role_created: code('accounts', 'role', ['code', 'permissions']),
  role_updated: code('accounts', 'role', ['changed', 'before', 'after']),
  role_deleted: code('accounts', 'role', ['code']),
  administrator_created_by_platform: code('accounts', 'user', ['platformAdminId', 'platformAdminEmail'], { by: 'platform' }),
  built_in_roles_changed_by_system: migration('accounts', 'tenant', ['roles', 'permissionsAdded', 'permissionsRemoved']),

  // Organization and settings.
  org_unit_created: code('organization', 'org_unit', ['type', 'parentId']),
  org_unit_updated: code('organization', 'org_unit', ['changed', 'switched']),
  org_unit_moved: code('organization', 'org_unit', ['from', 'to']),
  public_reporting_changed: code('organization', 'tenant', ['from', 'to']),
  response_rules_changed: code('organization', 'tenant', ['harmLevel', 'triageHours', 'closeDays']),
  email_setting_changed: code('organization', 'tenant', ['enabled']),
  notification_preferences_changed: code('organization', 'user', ['immediate', 'digest', 'weekly', 'via']),
  // The first entry the chain seals itself (migration 0058): how many were
  // there before, sealed as they then stood.
  audit_chain_started: { area: 'organization', entity: 'tenant', details: ['migration', 'sealedBefore', 'sealedOn'], by: 'database' },

  // Incidents.
  incident_reported: code('incidents', 'incident', ['reference', 'type', 'anonymous', 'channel'], { maskActor: true }),
  incident_triaged: code('incidents', 'incident', ['from', 'to', 'personChanged']),
  incident_status_changed: code('incidents', 'incident', ['from', 'to', 'kind', 'triageDueAt', 'closeDueAt'], { maskActor: true }),
  incident_commented: code('incidents', 'incident', ['commentId', 'visibility', 'byReporter'], { maskActor: true }),
  incident_deadlines_filled: code('incidents', 'incident', ['triageDueAt', 'closeDueAt']),
  public_reporting_limit_reached: code('incidents', 'tenant', ['limit', 'perMinutes']),

  // Documents.
  document_created: code('documents', 'document', ['number', 'typeId', 'categoryId', 'ownerId', 'ownerUnitId', 'confidentiality', 'audience', 'versionId']),
  document_updated: code('documents', 'document', ['reason', 'title', 'keywords', 'references', 'ownerId', 'ownerUnitId', 'confidentiality', 'audience', 'reviewMonths', 'authoritativeLocale', 'confirmationDueFrom']),
  document_version_created: code('documents', 'document', ['versionId', 'version', 'copiedFromVersionId', 'contributors']),
  document_version_edited: code('documents', 'document', ['versionId', 'version', 'contentHash']),
  document_submitted: code('documents', 'document', ['versionId', 'version', 'status', 'runId', 'routeId', 'contentHash']),
  document_step_approved: code('documents', 'document', ['versionId', 'version', 'runId', 'position', 'kind', 'signatureId', 'contentHash', 'comment', 'approved']),
  document_returned: code('documents', 'document', ['versionId', 'version', 'runId', 'position', 'kind', 'status', 'comment']),
  document_recalled: code('documents', 'document', ['versionId', 'version', 'runId', 'status']),
  document_version_withdrawn: code('documents', 'document', ['versionId', 'version', 'status', 'runId', 'reason']),
  document_publish_scheduled: code('documents', 'document', ['versionId', 'version', 'effectiveOn']),
  document_published: code('documents', 'document', ['versionId', 'version', 'effectiveOn', 'supersededVersionId', 'nextReviewOn', 'acknowledgementsAsked', 'byScheduledCheck']),
  document_retired: code('documents', 'document', ['status', 'reason', 'withdrawnVersionId']),
  document_reviewed: code('documents', 'document', ['outcome', 'nextReviewOn', 'signatureId', 'contentHash', 'comment']),
  document_review_requested: code('documents', 'document', ['outcome', 'dueOn', 'approvers', 'signatureId', 'contentHash', 'comment']),
  document_review_approved: code('documents', 'document', ['outcome', 'requestedBy', 'nextReviewOn', 'signatureId', 'contentHash']),
  document_review_returned: code('documents', 'document', ['requestedBy', 'comment']),
  document_acknowledged: code('documents', 'document', ['versionId', 'version', 'signatureId', 'contentHash']),
  document_imported: code('documents', 'document', ['number', 'numberFrom', 'counter', 'typeId', 'categoryId', 'ownerId', 'ownerUnitId', 'confidentiality', 'audience', 'reviewMonths', 'versionId', 'original', 'sectionsNotWritten', 'acknowledgementRequired', 'acknowledgementsAsked', 'signatureId', 'contentHash', 'batchId', 'batchIndex', 'batchSize']),
  document_import_signed: code('documents', 'tenant', ['batchId', 'size', 'listHash', 'documents']),
  import_confirmed: code('documents', 'document', ['versionId', 'dueOn', 'signatureId', 'contentHash']),
  document_type_created: code('documents', 'document_type', ['code', 'name', 'prefix', 'sections']),
  document_type_updated: code('documents', 'document_type', ['name', 'prefix', 'sections', 'active', 'noChangeNeedsApproval']),
  document_category_created: code('documents', 'document_category', ['code', 'name', 'parentId']),
  document_category_updated: code('documents', 'document_category', ['name', 'parentId', 'active']),
  approval_route_created: code('documents', 'approval_route', ['documentTypeId', 'name', 'steps', 'startingRoute', 'fallback']),
  approval_route_updated: code('documents', 'approval_route', ['name', 'steps', 'active']),
  document_settings_updated: code('documents', 'tenant', ['maxReviewMonths', 'acknowledgeWithinDays', 'authoritativeLocale']),
  document_type_changed_by_system: migration('documents', 'document_type', ['noChangeNeedsApproval']),
  approval_routes_changed_by_system: migration('documents', 'tenant', ['routes']),
  policy_defaults_reworded_by_system: migration('documents', 'tenant', ['types']),
  import_confirmations_corrected_by_system: migration('documents', 'tenant', ['reason', 'imports', 'confirmationDueIn']),
  import_confirmations_backfilled_by_system: migration('documents', 'tenant', ['recordedBy', 'imports', 'confirmedByImport']),

  // Exports: what was downloaded, in which language, how many rows.
  documents_exported: code('exports', 'tenant', ['filters', 'locale', 'rows']),
  acknowledgements_exported: code('exports', 'document', ['versionId', 'version', 'locale', 'rows']),
  imports_exported: code('exports', 'tenant', ['locale', 'rows']),
  overdue_acknowledgements_exported: code('exports', 'tenant', ['locale', 'rows']),
  person_acknowledgements_exported: code('exports', 'user', ['locale', 'rows']),

  // Written by Trustline's staff, from the admin portal.
  subscription_changed: code('trustline', 'subscription', ['plan', 'status', 'modules', 'limits', 'planUpdated', 'platformAdminEmail'], { by: 'platform' }),
  import_window_changed: code('trustline', 'tenant', ['from', 'to', 'reason', 'platformAdminEmail'], { by: 'platform' }),
} as const satisfies Record<string, ActionInfo>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export const isAuditAction = (action: string): action is AuditAction =>
  Object.hasOwn(AUDIT_ACTIONS, action);

/** Who acted, when it was not one of the client's people. */
export const AUDIT_ACTORS = ['system', 'trustline_staff', 'reporter', 'anonymous'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];
