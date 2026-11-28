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
  'risks',
  'actions',
  'exports',
  'trustline',
  'audit',
  'reports',
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
  | 'subscription'
  | 'ai_draft'
  | 'risk'
  | 'risk_matrix'
  | 'risk_category'
  | 'risk_committee'
  | 'action';

/**
 * The module an entry belongs to: one of a module the client does not have
 * is not shown in the viewer, as the module's routes answer as if they did
 * not exist. It stays in the chain, and in the chain file as a seal only.
 */
export type AuditModule = 'core' | 'incidents' | 'policies' | 'risks';

type ActionInfo = {
  area: AuditArea;
  module?: AuditModule;
  /**
   * Keys only entries written before held, which no code writes any more and
   * nothing shows (Trustline staff's email, before step 7 named them): the
   * sealed entries keep them, the viewer and the CSV leave them out.
   */
  legacy?: readonly string[];
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
  sign_in: code('sign_in', 'user', ['client', 'secondFactor']),
  sign_in_failed: code('sign_in', 'user', ['locked', 'reason']),
  sign_out: code('sign_in', 'user', ['client']),
  password_set: code('sign_in', 'user', ['purpose']),
  password_confirmation_failed: code('sign_in', 'user', ['locked', 'purpose', 'pin', 'pinFailures', 'pinLocked']),
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
  administrator_created_by_platform: code('accounts', 'user', ['platformAdminId', 'platformAdminName'], { by: 'platform', legacy: ['platformAdminEmail'] }),
  built_in_roles_changed_by_system: migration('accounts', 'tenant', ['roles', 'permissions', 'permissionsAdded', 'permissionsRemoved', 'rolesAdded', 'reworded']),
  // External reviewers (docs/specs/audit-trail.md, step 6).
  external_access_granted: code('accounts', 'user', ['organization', 'purpose', 'from', 'until', 'roleId']),
  external_access_extended: code('accounts', 'user', ['from', 'to', 'reason']),
  external_access_ended: code('accounts', 'user', ['by', 'until']),

  // Organization and settings.
  org_unit_created: code('organization', 'org_unit', ['type', 'parentId']),
  org_unit_updated: code('organization', 'org_unit', ['changed', 'active']),
  org_unit_moved: code('organization', 'org_unit', ['from', 'to']),
  public_reporting_changed: code('organization', 'tenant', ['from', 'to']),
  response_rules_changed: code('organization', 'tenant', ['none', 'mild', 'moderate', 'severe', 'death']),
  email_setting_changed: code('organization', 'tenant', ['enabled']),
  notification_preferences_changed: code('organization', 'user', ['immediate', 'digest', 'weekly', 'language', 'via']),
  // The organization's profile (docs/specs/ai-policy-drafting.md): which
  // of its parts changed.
  organization_profile_updated: code('organization', 'tenant', ['changed']),
  // The organization switched AI on or off (docs/specs/ai-providers-and-allowances.md).
  ai_use_changed: code('organization', 'tenant', ['from', 'to']),

  // Incidents.
  incident_reported: code('incidents', 'incident', ['reference', 'type', 'anonymous', 'channel'], { maskActor: true }),
  incident_triaged: code('incidents', 'incident', ['from', 'to', 'harmLevel', 'isSentinel', 'categoryId', 'ownerUnitId', 'assignedTo']),
  // Never the reporter's as reporter: no status move is (security review 14, H2).
  incident_status_changed: code('incidents', 'incident', ['from', 'to', 'kind', 'triageDueAt', 'closeDueAt']),
  incident_commented: code('incidents', 'incident', ['commentId', 'visibility', 'byReporter'], { maskActor: true }),
  incident_deadlines_filled: code('incidents', 'incident', ['triageDueAt', 'closeDueAt']),
  public_reporting_limit_reached: code('incidents', 'tenant', ['limit', 'perMinutes']),

  // Documents.
  document_created: code('documents', 'document', ['number', 'typeId', 'categoryId', 'ownerId', 'ownerUnitId', 'confidentiality', 'audience', 'versionId', 'source', 'aiDraftSessionId']),
  document_updated: code('documents', 'document', ['reason', 'categoryId', 'title', 'ownerId', 'ownerUnitId', 'confidentiality', 'keywords', 'references', 'reviewMonths', 'authoritativeLocale', 'audience', 'authoritative', 'versionsInProgress', 'nextReviewOn', 'confirmationDueFrom']),
  document_version_created: code('documents', 'document', ['versionId', 'version', 'copiedFromVersionId', 'contributors']),
  document_version_edited: code('documents', 'document', ['versionId', 'version', 'sections', 'changeSummary', 'acknowledgementRequired', 'acknowledgeWithinDays', 'contentHash']),
  document_submitted: code('documents', 'document', ['versionId', 'version', 'status', 'runId', 'routeId', 'contentHash']),
  document_step_approved: code('documents', 'document', ['versionId', 'version', 'runId', 'position', 'kind', 'signatureId', 'contentHash', 'comment', 'status']),
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
  document_type_created: code('documents', 'document_type', ['code', 'name', 'numberPrefix', 'sections', 'defaultReviewMonths', 'noChangeNeedsApproval', 'position']),
  document_type_updated: code('documents', 'document_type', ['name', 'numberPrefix', 'sections', 'defaultReviewMonths', 'noChangeNeedsApproval', 'active', 'position']),
  document_category_created: code('documents', 'document_category', ['code', 'name', 'parentId', 'position']),
  document_category_updated: code('documents', 'document_category', ['name', 'parentId', 'active', 'position']),
  approval_route_created: code('documents', 'approval_route', ['documentTypeId', 'name', 'active', 'steps', 'startingRoute', 'fallback']),
  approval_route_updated: code('documents', 'approval_route', ['name', 'documentTypeId', 'active', 'steps']),
  document_settings_updated: code('documents', 'tenant', ['maxReviewMonths', 'authoritativeLocale', 'authoritative', 'versionsInProgress']),
  // The document design, for the organization or for one type: which parts changed.
  document_design_updated: code('documents', 'tenant', ['documentTypeId', 'version', 'changed']),
  // Drafting with the assistant (docs/specs/ai-policy-drafting.md). The
  // conversation's text is kept with the draft, never in the trail.
  ai_draft_started: code('documents', 'ai_draft', ['typeId', 'locale']),
  ai_draft_questions_asked: code('documents', 'ai_draft', ['round', 'questions', 'aiRequestId']),
  ai_draft_answered: code('documents', 'ai_draft', ['round', 'answered', 'notDecided']),
  ai_draft_version_created: code('documents', 'ai_draft', ['version', 'author', 'gaps', 'assumptions', 'sources', 'model', 'aiRequestId']),
  ai_draft_discarded: code('documents', 'ai_draft', ['versions']),
  ai_draft_handed_over: code('documents', 'document', ['sessionId', 'version', 'number']),
  ai_draft_ownership_taken: code('documents', 'document', ['sessionId']),
  // The daily check removed conversations not handed over: discarded, or
  // with no activity for 90 days. How many, never what they said.
  ai_drafts_removed_by_system: code('documents', 'tenant', ['discarded', 'abandoned']),
  document_type_changed_by_system: migration('documents', 'document_type', ['noChangeNeedsApproval']),
  approval_routes_changed_by_system: migration('documents', 'tenant', ['routes', 'step']),
  policy_defaults_reworded_by_system: migration('documents', 'tenant', ['types', 'categories']),
  import_confirmations_corrected_by_system: migration('documents', 'tenant', ['reason', 'imports', 'confirmationDueIn']),
  import_confirmations_backfilled_by_system: migration('documents', 'tenant', ['recordedBy', 'imports', 'confirmedByImport']),

  // Risks (docs/specs/risk-management.md, "Audit"). The register.
  risk_created: code('risks', 'risk', ['reference', 'source', 'status', 'orgUnitId', 'categoryId', 'ownerId', 'treatment', 'targetOn', 'ratings', 'nextReviewOn', 'incidentId', 'incidentReference', 'linkKind']),
  risk_updated: code('risks', 'risk', ['reasonGiven', 'noteId', 'title', 'cause', 'event', 'consequence', 'orgUnitId', 'categoryId', 'ownerId', 'references', 'keywords', 'treatment', 'targetOn']),
  risk_proposal_accepted: code('risks', 'risk', ['ownerId', 'ratings', 'nextReviewOn']),
  risk_proposal_rejected: code('risks', 'risk', ['reasonGiven']),
  risk_rated: code('risks', 'risk', ['kind', 'from', 'to', 'matrixId', 'nextReviewOn']),
  risk_control_added: code('risks', 'risk', ['controlId', 'kind', 'hierarchy', 'ownerId', 'effectiveness', 'assessedOn', 'documentId']),
  risk_control_updated: code('risks', 'risk', ['controlId', 'description', 'kind', 'hierarchy', 'ownerId', 'effectiveness', 'assessedOn', 'documentId', 'active', 'reasonGiven']),
  // Text written once, corrected by a manager (security review 15, M1):
  // which, never the text.
  risk_text_corrected: code('risks', 'risk', ['kind', 'ratingId', 'reviewId', 'controlId', 'noteId', 'field', 'linkId']),
  risk_reviewed: code('risks', 'risk', ['reviewId', 'outcome', 'late', 'dueOn', 'nextReviewOn', 'committeeId', 'current', 'target', 'controls', 'treatment', 'targetOn']),
  // Put before a committee, by hand (with a reason) or automatically by a
  // rating (`automatic`, with the band), and taken off its list.
  risk_escalated: code('risks', 'risk', ['committeeId', 'from', 'automatic', 'band', 'reasonGiven', 'noteId']),
  risk_de_escalated: code('risks', 'risk', ['committeeId', 'band', 'reasonGiven', 'noteId']),
  // Acceptance above tolerance and closure (step 6), signed through the
  // approval engine. Text people write (a rationale, a comment, a reason)
  // is never in these: only that it was given.
  risk_acceptance_requested: code('risks', 'risk', ['acceptanceId', 'runId', 'routeId', 'band', 'score', 'tolerance', 'untilOn', 'signatureRequired']),
  risk_acceptance_step_approved: code('risks', 'risk', ['acceptanceId', 'runId', 'position', 'kind', 'signatureId', 'contentHash', 'commentGiven']),
  risk_acceptance_returned: code('risks', 'risk', ['acceptanceId', 'runId', 'position', 'commentGiven']),
  risk_acceptance_withdrawn: code('risks', 'risk', ['acceptanceId', 'runId', 'noteId']),
  risk_accepted: code('risks', 'risk', ['acceptanceId', 'untilOn', 'band', 'score', 'signatureRequired', 'runId']),
  // Written by the system: its last day passed, its score rose, its category changed.
  risk_acceptance_lapsed: code('risks', 'risk', ['acceptanceId', 'reason', 'score']),
  risk_closure_requested: code('risks', 'risk', ['runId', 'routeId', 'mergedIntoId', 'reasonGiven']),
  risk_closure_step_approved: code('risks', 'risk', ['runId', 'position', 'kind', 'signatureId', 'contentHash', 'commentGiven']),
  risk_closure_returned: code('risks', 'risk', ['runId', 'position', 'commentGiven']),
  risk_closed: code('risks', 'risk', ['mergedIntoId', 'reasonGiven', 'signedOff', 'runId']),
  risk_reopened: code('risks', 'risk', ['noteId', 'current', 'nextReviewOn']),
  // Links to incidents (step 7): never who reported one or how.
  risk_incident_linked: code('risks', 'risk', ['linkId', 'incidentId', 'incidentReference', 'kind', 'noteGiven']),
  risk_incident_unlinked: code('risks', 'risk', ['linkId', 'incidentId', 'reasonGiven']),
  // The module's settings.
  risk_settings_changed: code('risks', 'tenant', ['inherentRequired', 'frameworkDocumentId', 'assessmentThresholdBand', 'acceptanceMaxMonths']),
  risk_matrix_created: code('risks', 'risk_matrix', ['version', 'likelihoodLevels', 'impactLevels', 'copiedFromId']),
  // The wording of a matrix in use, or anything of a draft.
  risk_matrix_changed: code('risks', 'risk_matrix', ['version', 'status', 'levels', 'domains', 'bands', 'cells']),
  risk_matrix_discarded: code('risks', 'risk_matrix', ['version']),
  risk_matrix_put_in_use: code('risks', 'risk_matrix', ['version', 'previousMatrixId', 'risksRebanded', 'risksOutOfRange', 'risksTargetAboveCurrent', 'risksAwaitingAcceptance', 'riskIds']),
  risk_category_created: code('risks', 'risk_category', ['code', 'name', 'position', 'appetite', 'appetiteStatement', 'toleranceBand']),
  risk_category_updated: code('risks', 'risk_category', ['name', 'position', 'active', 'appetite', 'appetiteStatement', 'toleranceBand']),
  risk_committee_created: code('risks', 'risk_committee', ['code', 'name', 'position', 'memberRoleId', 'chairRoleId']),
  risk_committee_updated: code('risks', 'risk_committee', ['name', 'position', 'memberRoleId', 'chairRoleId', 'active']),
  risk_approval_route_created: code('risks', 'approval_route', ['subject', 'variant', 'name', 'steps']),
  risk_approval_route_updated: code('risks', 'approval_route', ['name', 'steps', 'active']),
  risk_defaults_created_by_system: migration('risks', 'tenant', ['matrix', 'categories', 'committees', 'routes']),

  // The shared actions engine (docs/specs/actions.md).
  action_created: code('actions', 'action', ['reference', 'sourceType', 'sourceId', 'ownerId', 'orgUnitId', 'dueOn', 'strength', 'hierarchy']),
  action_updated: code('actions', 'action', ['title', 'description', 'ownerId', 'orgUnitId', 'strength', 'hierarchy', 'status']),
  action_due_changed: code('actions', 'action', ['from', 'to', 'reasonGiven', 'noteId', 'originalDueOn']),
  action_completed: code('actions', 'action', ['from', 'onTime', 'dueOn']),
  action_verified: code('actions', 'action', ['outcome']),
  action_cancelled: code('actions', 'action', ['from', 'reasonGiven']),
  action_reopened: code('actions', 'action', ['from', 'reasonGiven', 'noteId']),
  // A note corrected by a manager of the source (security review 15, M1): which, never the text.
  action_text_corrected: code('actions', 'action', ['field', 'noteId']),

  // Exports: what was downloaded, in which language, how many rows.
  documents_exported: code('exports', 'tenant', ['filters', 'locale', 'rows']),
  acknowledgements_exported: code('exports', 'document', ['versionId', 'version', 'locale', 'rows']),
  imports_exported: code('exports', 'tenant', ['locale', 'rows']),
  overdue_acknowledgements_exported: code('exports', 'tenant', ['locale', 'rows']),
  person_acknowledgements_exported: code('exports', 'user', ['locale', 'rows']),

  // Written by Trustline's staff, from the admin portal.
  // `platformAdminName` names the staff member (`platformAdminEmail` in
  // entries written before the audit trail's step 7).
  subscription_changed: code('trustline', 'subscription', ['plan', 'status', 'modules', 'limits', 'aiAllowances', 'planUpdated', 'platformAdminId', 'platformAdminName'], { by: 'platform', legacy: ['platformAdminEmail'] }),
  import_window_changed: code('trustline', 'tenant', ['closesOn', 'reason', 'platformAdminId', 'platformAdminName'], { by: 'platform', module: 'policies', legacy: ['platformAdminEmail'] }),
  // Mirrored from Trustline's own log (spec, item 3): the client was made,
  // and what of it was changed (suspended or made active again, its time
  // zone, its languages, its standard), with the old and new values.
  client_created_by_platform: code('trustline', 'tenant', ['slug', 'plan', 'platformAdminId', 'platformAdminName'], { by: 'platform' }),
  client_settings_changed_by_platform: code('trustline', 'tenant', ['changes', 'platformAdminId', 'platformAdminName'], { by: 'platform' }),
  // How Trustline offers the client AI: on or off, each feature's provider
  // (where it processes) and model, the allowances, the medical option.
  ai_settings_changed: code('trustline', 'tenant', ['offered', 'features', 'allowances', 'medicalOptionAllowed', 'platformAdminId', 'platformAdminName'], { by: 'platform' }),

  // The audit trail itself.
  // The first entry the chain seals itself (migration 0058): how many were
  // there before, sealed as they then stood.
  audit_chain_started: { area: 'audit', entity: 'tenant', details: ['migration', 'sealedBefore', 'sealedOn'], by: 'database' },
  audit_entries_exported: code('audit', 'tenant', ['filters', 'locale', 'rows']),
  audit_chain_exported: code('audit', 'tenant', ['fromSeq', 'toSeq', 'entries', 'withheld']),
  audit_checkpoints_exported: code('audit', 'tenant', ['from', 'to', 'checkpoints']),
  // A record an external reviewer opened: what was examined.
  external_reviewer_viewed: code('audit', null, ['route', 'recordType', 'recordId', 'params', 'query']),
  // Addresses of sign-ins older than two years cleared (decision 7).
  audit_addresses_cleared: code('audit', 'tenant', ['before', 'count']),

  // Reports and measures (docs/specs/reports-and-measures.md).
  // A month's figures taken: one entry per client, module and month.
  measures_snapshot_taken: code('reports', 'tenant', ['month', 'module', 'method', 'rows']),
  // A correction asked for: recomputed by Trustline, never typed in.
  measure_correction_requested: code('reports', 'tenant', ['month', 'measures', 'unitId', 'reason', 'values']),
  measures_recomputed_by_system: migration('reports', 'tenant', ['reason', 'months']),
  report_settings_changed: code('reports', 'tenant', ['targets', 'baseline']),
  measures_exported: code('reports', 'tenant', ['filters', 'locale', 'rows']),

  // Full data export (docs/specs/data-export.md). Of the whole client's
  // data, whatever modules it has now: core.
  data_export_requested: code('exports', 'tenant', ['exportId', 'reason', 'note', 'locale', 'includePdfs'], { module: 'core' }),
  data_export_approved: code('exports', 'tenant', ['exportId'], { module: 'core' }),
  data_export_refused: code('exports', 'tenant', ['exportId', 'reason'], { module: 'core' }),
  data_export_cancelled: code('exports', 'tenant', ['exportId'], { module: 'core' }),
  // By the export worker: not approved within 7 days.
  data_export_lapsed: code('exports', 'tenant', ['exportId'], { module: 'core' }),
  data_export_ready: code('exports', 'tenant', ['exportId', 'archiveSha256', 'sizeBytes', 'counts'], { module: 'core' }),
  data_export_failed: code('exports', 'tenant', ['exportId', 'kind', 'attempt', 'final'], { module: 'core' }),
  data_export_downloaded: code('exports', 'tenant', ['exportId', 'archiveSha256', 'download'], { module: 'core' }),
  // Its file deleted: past its last day, or downloaded the most times.
  data_export_expired: code('exports', 'tenant', ['exportId', 'by'], { module: 'core' }),
  // Trustline's second approval, for a client with one holder of
  // `data.export`, on its contract contact's written request (decision 3):
  // written by `data_export_second_approval()`, called by the portal.
  data_export_approved_by_trustline: code('exports', 'tenant', ['exportId', 'writtenRequest', 'platformAdminId', 'platformAdminName'], { module: 'core', by: 'platform' }),
  // The contract's end, its exit window and its retention, set by
  // Trustline's staff (docs/specs/data-export.md).
  contract_end_set: code('trustline', 'tenant', ['endsOn', 'exitUntil', 'retainUntil', 'platformAdminId', 'platformAdminName'], { by: 'platform' }),
} as const satisfies Record<string, ActionInfo>;

/** The module each area belongs to, unless its action says otherwise. */
const AREA_MODULE: Record<AuditArea, AuditModule> = {
  sign_in: 'core',
  accounts: 'core',
  organization: 'core',
  incidents: 'incidents',
  documents: 'policies',
  // Risk management; and the shared actions engine, whose every action is a
  // risk's so far (docs/specs/actions.md, decision 3).
  risks: 'risks',
  actions: 'risks',
  exports: 'policies',
  trustline: 'core',
  audit: 'core',
  reports: 'core',
};

/** The module an action's entries belong to. */
export const moduleOfAction = (action: AuditAction): AuditModule => {
  const info: ActionInfo = AUDIT_ACTIONS[action];
  return info.module ?? AREA_MODULE[info.area];
};

export type AuditAction = keyof typeof AUDIT_ACTIONS;

/** Every key an entry's details may hold, worded in every language. */
export type AuditDetailKey = (typeof AUDIT_ACTIONS)[AuditAction]['details'][number];

/** The keys an action's stored entries may hold: its details, and its legacy keys. */
export const storedKeysOf = (action: AuditAction): readonly string[] => {
  const info: ActionInfo = AUDIT_ACTIONS[action];
  return [...info.details, ...(info.legacy ?? [])];
};

export const isAuditAction = (action: string): action is AuditAction =>
  Object.hasOwn(AUDIT_ACTIONS, action);

/** Who acted, when it was not one of the client's people. */
export const AUDIT_ACTORS = ['system', 'trustline_staff', 'reporter', 'anonymous'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];
