/**
 * What a full data export holds (docs/specs/data-export.md, "Every module's
 * records"): every table with `tenant_id` is here, either exported (its
 * file, and each column left out with the reason) or excluded with the
 * reason. `coverage.spec.ts` fails for a table that is in neither, for a
 * table here that does not exist, and for a column whose name looks like
 * a secret (`SECRET_LIKE`) that is neither left out nor kept with a reason.
 * So a new module's tables, and a new secret column, cannot be forgotten.
 *
 * **Adding a table** (a new module, a branch merging): one line,
 * `my_table: exported('area/my_table')`, or `excluded('why')`; `omit` /
 * `keep` for any column the test names; and its columns exported in
 * `coverage-columns.ts`. A column not listed there is left out of the
 * archive and fails the test until it is decided (security review 19, L2). A table read by people in
 * a spreadsheet may also get a CSV file in `CSV_FILES`, with its headings
 * in `wording/<lang>.ts` under `csv`.
 */

/** A column whose name says it may hold a secret or a secret's fingerprint. */
export const SECRET_LIKE = /hash|secret|token|salt|password|pin|key|code/;

export type Exported = {
  kind: 'export';
  /** The file in the archive, without its extension: `<folder>/<name>`. */
  file: string;
  /** Columns left out of the file, each with the reason. */
  omit: Record<string, string>;
  /** Columns whose name looks like a secret, kept, each with the reason. */
  keep: Record<string, string>;
};
export type Excluded = { kind: 'exclude'; reason: string };
export type Coverage = Exported | Excluded;

const exported = (
  file: string,
  how: { omit?: Record<string, string>; keep?: Record<string, string> } = {},
): Exported => ({ kind: 'export', file, omit: how.omit ?? {}, keep: how.keep ?? {} });
const excluded = (reason: string): Excluded => ({ kind: 'exclude', reason });

const SECRET = 'A secret, or the fingerprint of one: of no use outside Trustline, and never to leave it.';
const LOCKS = 'Counters and locks of sign-in and signing, which never leave Trustline.';
const CHAIN = 'The audit chain’s links and seals, to check it.';
const SIGNED = 'The fingerprint of what was signed, to check the signature against the text.';
const CODES = 'An identifying code chosen by the organization, not a secret.';
const TRUSTLINE_AI = 'Which of Trustline’s own provider connections served it: Trustline’s, which the client is not shown (security review 19, L2).';

export const COVERAGE: Record<string, Coverage> = {
  // Structure, people, settings.
  org_units: exported('structure/org_units', { keep: { code: CODES } }),
  users: exported('people/users', {
    omit: {
      password_hash: SECRET,
      signing_pin_hash: SECRET,
      failed_attempts: LOCKS,
      locked_until: LOCKS,
      signing_pin_failures: LOCKS,
      signing_pin_locked_at: LOCKS,
    },
    keep: {
      password_changed_at: 'When a password was last chosen, not the password.',
      signing_pin_set_at: 'When a signing PIN was set, not the PIN.',
    },
  }),
  roles: exported('people/roles', { keep: { code: CODES } }),
  role_assignments: exported('people/role_assignments'),
  email_preferences: exported('people/email_preferences'),
  email_settings: exported('organization/email_settings'),
  module_starts: exported('organization/module_starts'),
  reference_counters: exported('organization/reference_counters'),
  subscriptions: exported('organization/subscription', {
    omit: { note: 'Trustline’s own note about the client, which the application cannot read.' },
  }),
  data_exports: exported('organization/data_exports', {
    omit: {
      storage_key: 'Where Trustline keeps an archive: of no use outside it.',
      wrapped_key: SECRET,
    },
    keep: {
      archive_sha256: 'The fingerprint of each archive made, to check it.',
      manifest_sha256: 'The fingerprint of each archive’s manifest, to check it.',
    },
  }),

  // Incidents.
  incidents: exported('incidents/incidents', {
    omit: { follow_up_code_hash: 'The secret an anonymous reporter follows their report with.' },
  }),
  incident_events: exported('incidents/events'),
  incident_comments: exported('incidents/comments'),
  incident_categories: exported('incidents/categories', { keep: { code: CODES } }),
  incident_response_rules: exported('incidents/response_rules'),

  // Documents.
  documents: exported('documents/documents', { keep: { keywords: 'Words the organization files a document under.' } }),
  document_versions: exported('documents/versions'),
  document_types: exported('documents/types', { keep: { code: CODES } }),
  document_categories: exported('documents/categories', { keep: { code: CODES } }),
  document_audiences: exported('documents/audiences'),
  document_acknowledgements: exported('documents/acknowledgements'),
  document_reviews: exported('documents/reviews'),
  document_review_rounds: exported('documents/review_rounds'),
  document_review_approvals: exported('documents/review_approvals'),
  document_imports: exported('documents/imports'),
  document_import_batches: exported('documents/import_batches', {
    keep: { list_hash: 'The fingerprint of the list imported, as signed.' },
  }),
  document_settings: exported('documents/settings'),
  policy_import_windows: exported('documents/import_windows'),
  policy_reminders: exported('documents/reminders'),
  approval_routes: exported('documents/approval_routes'),
  approval_route_steps: exported('documents/approval_route_steps'),
  approval_runs: exported('documents/approval_runs'),
  approval_run_steps: exported('documents/approval_run_steps'),
  signatures: exported('documents/signatures', { keep: { content_hash: SIGNED } }),

  // Notifications and reports.
  notifications: exported('notifications/notifications'),
  measure_snapshots: exported('reports/measure_snapshots'),
  report_settings: exported('reports/settings'),

  // AI (docs/specs/ai-providers-and-allowances.md, ai-policy-drafting.md).
  // A request is recorded without its text, so its record goes whole.
  ai_client_settings: exported('ai/settings', {
    omit: {
      monthly_spending_limit_micro_usd: 'Trustline’s own limit on what it spends on the client’s AI, which the client is not shown.',
    },
  }),
  ai_client_features: exported('ai/features', {
    omit: { connection_id: TRUSTLINE_AI },
  }),
  ai_requests: exported('ai/requests', {
    omit: {
      connection_id: TRUSTLINE_AI,
      cost_micro_usd: 'What a request cost Trustline: Trustline’s control of its own costs, which the client is not shown (security review 19, L2).',
    },
    keep: {
      input_tokens: 'How much was sent, counted in the provider’s units: not a secret.',
      output_tokens: 'How much was answered, counted in the provider’s units: not a secret.',
      unit_key: 'The id of the draft a request belongs to: not a secret.',
    },
  }),
  ai_usage_notices: exported('ai/usage_notices'),
  organization_profiles: exported('organization/profile'),
  document_designs: exported('documents/designs'),
  drafting_sessions: exported('ai/drafting_sessions'),
  drafting_messages: exported('ai/drafting_messages'),
  drafting_versions: exported('ai/drafting_versions'),

  // The audit trail.
  audit_log: exported('audit/audit_log', {
    keep: { ip_salt: 'With the address, checks it against the commitment the chain holds.' },
  }),
  audit_chain: exported('audit/audit_chain', {
    keep: { prev_hash: CHAIN, body_hash: CHAIN, hash: CHAIN, ip_commitment: CHAIN },
  }),
  audit_chain_checkpoints: exported('audit/audit_chain_checkpoints', {
    keep: { hash: CHAIN, key_id: 'Which of Trustline’s published keys signed the checkpoint.' },
  }),
  audit_chain_verifications: exported('audit/audit_chain_verifications'),

  // Excluded.
  audit_chain_heads: excluded('The chain’s last link, rebuilt from audit/audit_chain.'),
  sessions: excluded('Sign-in sessions: hashes of secrets, of no use outside Trustline.'),
  user_tokens: excluded('Invitation and password links: hashes of secrets, of no use outside Trustline.'),
  sign_in_codes: excluded('One-time sign-in codes of external reviewers: hashes of secrets, of no use outside Trustline.'),
  email_queue: excluded('Emails waiting or sent, with delivery errors, kept for support only (email.md, section 7). What each person was told is in notifications/.'),
  email_outbox: excluded('Copies of emails and addresses, kept 30 days for support only (email.md, section 7).'),
};

/** How a CSV cell is worded from its column. */
export type CsvAs =
  | 'text'
  | 'number'
  | 'bool'
  | 'code'
  | 'localized'
  | 'moment'
  | 'day'
  | 'month'
  | 'unit'
  | 'user'
  | 'incident'
  | 'document'
  | 'version'
  | 'incidentCategory'
  | 'documentType'
  | 'documentCategory'
  | 'measure';

export type CsvFile = { columns: { column: string; as: CsvAs }[] };

const cols = (spec: Record<string, CsvAs>): CsvFile => ({
  columns: Object.entries(spec).map(([column, as]) => ({ column, as })),
});

/**
 * The tables people open in a spreadsheet (spec, "Formats"), each as a CSV
 * file beside its JSON Lines file, in the language asked for. Its headings
 * are in `wording/<lang>.ts` under `csv.<table>`. The worded audit log is
 * made by the audit trail's own export.
 */
export const CSV_FILES: Record<string, CsvFile> = {
  users: cols({
    name: 'localized', email: 'text', phone: 'text', job_title: 'text', employee_number: 'text', org_unit_id: 'unit',
    status: 'code', kind: 'code', preferred_locale: 'text', created_at: 'moment', last_sign_in_at: 'moment',
  }),
  org_units: cols({ code: 'text', name: 'localized', type: 'code', parent_id: 'unit', active: 'bool', created_at: 'moment' }),
  incidents: cols({
    reference: 'text', type: 'code', category_id: 'incidentCategory', org_unit_id: 'unit', occurred_at: 'moment',
    reported_at: 'moment', harm_level: 'code', is_sentinel: 'bool', status: 'code', channel: 'code', reported_by: 'user',
    owner_unit_id: 'unit', assigned_to: 'user', triaged_at: 'moment', closed_at: 'moment', description: 'text',
    immediate_action: 'text', closure_summary: 'text',
  }),
  incident_events: cols({
    incident_id: 'incident', occurred_at: 'moment', kind: 'code', actor_id: 'user', from_status: 'code', to_status: 'code',
  }),
  documents: cols({
    number: 'text', title: 'localized', type_id: 'documentType', category_id: 'documentCategory', owner_id: 'user',
    owner_unit_id: 'unit', confidentiality: 'code', status: 'code', next_review_on: 'day', last_reviewed_on: 'day', retired_at: 'moment',
  }),
  document_acknowledgements: cols({
    version_id: 'version', user_id: 'user', assigned_at: 'moment', due_on: 'day', acknowledged_at: 'moment',
  }),
  document_reviews: cols({
    document_id: 'document', due_on: 'day', outcome: 'code', reviewed_by: 'user', reviewed_at: 'moment', next_review_on: 'day',
    comment: 'text',
  }),
  measure_snapshots: cols({
    month: 'month', measure: 'measure', org_unit_id: 'unit', value: 'number', numerator: 'number', denominator: 'number',
    target: 'number', status: 'code', method: 'code', revision: 'number',
  }),
};

/** The most rows of one CSV file: spreadsheets open no more. */
export const CSV_PART_ROWS = 1_000_000;
