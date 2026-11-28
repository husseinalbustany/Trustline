import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  AI_FEATURES,
  NO_AI_ALLOWANCES,
  type AiAllowances,
} from '../ai/features.js';
import { AI_PROVIDER_KINDS, INFERENCE_TYPES } from '../ai/provider.js';
import type { Localized } from '../i18n/locales.js';
import {
  SUBSCRIPTION_STATUSES,
  type Extras,
  type Limits,
} from '../subscriptions/modules.js';

// The role the API connects as. It owns nothing and cannot bypass row-level
// security. migrate.ts creates it before the migrations run.
export const appRole = pgRole('trustline_app').existing();

// The role the admin portal connects as. It manages the client records and
// reaches no hospital data.
export const platformRole = pgRole('trustline_platform').existing();

// The tenant the current transaction acts for, set by TenantDb.withTenant().
// Unset means no tenant, so every policy below matches no rows.
const currentTenant = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;

const tenantIsolation = () =>
  pgPolicy('tenant_isolation', {
    as: 'permissive',
    for: 'all',
    to: appRole,
    using: sql`tenant_id = ${currentTenant}`,
    withCheck: sql`tenant_id = ${currentTenant}`,
  });

export const accreditationStandard = pgEnum('accreditation_standard', [
  'JCI',
  'CBAHI',
]);

export const orgUnitType = pgEnum('org_unit_type', [
  'facility',
  'department',
  'unit',
]);

// `deleted`: the client's data deleted after its contract ended
// (docs/specs/data-export.md, "At the end of a contract"): its row stays
// as a stub, its identifier never reused, so Trustline's log keeps its
// reference.
export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended', 'deleted']);

export const signInMethod = pgEnum('sign_in_method', [
  'password',
  'sso',
  'both',
]);

export const tenants = pgTable(
  'tenants',
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    // The client's name in each of its languages.
    name: jsonb().$type<Localized>().notNull(),
    // The languages this client works in. Its text is written in these only.
    locales: text()
      .array()
      .notNull()
      .default(sql`'{en}'::text[]`),
    accreditationStandard: accreditationStandard().notNull(),
    defaultLocale: text().notNull().default('en'),
    // Where this tenant's data must be hosted. Null until the launch regions
    // are decided.
    dataRegion: text(),
    status: tenantStatus().notNull().default('active'),
    // When the client last went to or from suspended, by the database's
    // clock: every session and one-time link issued before it is void, so
    // reactivating a client brings none of them back. Null if it never did.
    accessResetAt: timestamp({ withTimezone: true }),
    signInMethod: signInMethod().notNull().default('password'),
    // Whether an incident can be reported without signing in, through the
    // hospital's link or QR code. Off until the hospital switches it on: it
    // is the one setting here that the hospital itself may change.
    publicReporting: boolean().notNull().default(false),
    // The hospital's own clock, as an IANA name ("Asia/Beirut"). Every day
    // the API works out for this hospital is a day there: the day a report
    // was made, "the last 30 days", a deadline counted in days. Set from the
    // admin portal, never by the hospital and never taken from a browser.
    timeZone: text().notNull().default('UTC'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // What the API stores, kept by the database too, so that a script or a
    // mistake cannot leave a hospital on a clock nothing can read: `UTC`, or
    // a name of the form Area/Location (one more part at most), each part
    // starting with a capital letter or a digit as IANA writes them, and
    // nothing from the `Etc/` area, whose names are offsets. Which names
    // exist is for the API to check against the runtime: the database's own
    // list of zones is not the same one.
    check(
      'tenants_time_zone_shape',
      sql`${t.timeZone} = 'UTC' or (${t.timeZone} ~ '^[A-Z][A-Za-z_]*(/[A-Z0-9][A-Za-z0-9_+-]*){1,2}$' and ${t.timeZone} !~ '^Etc/')`,
    ),
    // The application reads every client record: it has to find one by its
    // identifier before anyone has signed in.
    pgPolicy('tenants_app_read', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`true`,
    }),
    // It may change only the record of the hospital it is acting for, and a
    // migration grants it only the column above. So one hospital can never
    // open another to the internet.
    pgPolicy('tenants_app_own_settings', {
      as: 'permissive',
      for: 'update',
      to: appRole,
      using: sql`id = ${currentTenant}`,
      withCheck: sql`id = ${currentTenant}`,
    }),
    pgPolicy('tenants_platform', {
      as: 'permissive',
      for: 'all',
      to: platformRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

// A hospital's structure: facilities, their departments, and the units in
// those. The application role cannot delete one.
export const orgUnits = pgTable(
  'org_units',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    parentId: uuid(),
    type: orgUnitType().notNull(),
    code: text().notNull(),
    name: jsonb().$type<Localized>().notNull(),
    // Switched off, never deleted: incidents, users and role grants keep
    // pointing at it. An inactive unit cannot be chosen for anything new.
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('org_units_tenant_id_id_key').on(t.tenantId, t.id),
    unique('org_units_tenant_id_code_key').on(t.tenantId, t.code),
    // A parent must belong to the same tenant as its child.
    foreignKey({
      name: 'org_units_parent_fk',
      columns: [t.tenantId, t.parentId],
      foreignColumns: [t.tenantId, t.id],
    }),
    index('org_units_parent_idx').on(t.tenantId, t.parentId),
    tenantIsolation(),
  ],
);

export const userStatus = pgEnum('user_status', [
  'invited',
  'active',
  'disabled',
]);

// Who an account is for (docs/specs/audit-trail.md, "Time-limited access
// for an external surveyor"): the organization's own people, or a
// surveyor or auditor from outside, for a few days, read-only, signing in
// with a one-time code each time, and not counted as a named user.
export const userKind = pgEnum('user_kind', ['staff', 'external_reviewer']);

export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    orgUnitId: uuid(),
    employeeNumber: text(),
    name: jsonb().$type<Localized>().notNull(),
    // Stored lowercase.
    email: text().notNull(),
    phone: text(),
    jobTitle: text(),
    preferredLocale: text(),
    status: userStatus().notNull().default('invited'),
    // Null until the user sets a password, and for single sign-on only users.
    passwordHash: text(),
    passwordChangedAt: timestamp({ withTimezone: true }),
    // A signing PIN, for a person with no password (who signs in only
    // through their organization's single sign-on): hashed as a password
    // is, and asked wherever a password signature is (business decision 9).
    // Never shown, and set only by the person.
    signingPinHash: text(),
    signingPinSetAt: timestamp({ withTimezone: true }),
    // Wrong signing PINs since the last right one, whatever the lock in
    // between (security review 11): at SIGNING_PIN_MAX_FAILURES, signing
    // with the PIN is locked (`signing_pin_locked_at`) until an
    // administrator resets it.
    signingPinFailures: integer().notNull().default(0),
    signingPinLockedAt: timestamp({ withTimezone: true }),
    ssoSubject: text(),
    failedAttempts: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    lastSignInAt: timestamp({ withTimezone: true }),
    kind: userKind().notNull().default('staff'),
    // An external reviewer's access: its first and last days, on the
    // organization's calendar, where they come from and why, and whether
    // it was extended (once) or ended. Null for staff.
    accessFrom: date({ mode: 'string' }),
    accessUntil: date({ mode: 'string' }),
    accessOrganization: text(),
    accessPurpose: text(),
    accessExtendedAt: timestamp({ withTimezone: true }),
    accessExtensionReason: text(),
    accessEndedAt: timestamp({ withTimezone: true }),
    // For a change of the access: given with it, so that two at once do
    // not both apply.
    accessRevision: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('users_tenant_id_id_key').on(t.tenantId, t.id),
    unique('users_tenant_id_email_key').on(t.tenantId, t.email),
    foreignKey({
      name: 'users_org_unit_fk',
      columns: [t.tenantId, t.orgUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    check(
      'users_external_access',
      sql`(${t.kind} = 'external_reviewer') = (${t.accessFrom} is not null and ${t.accessUntil} is not null)`,
    ),
    tenantIsolation(),
  ],
);

/**
 * The one-time code an external reviewer is sent at each sign-in, after
 * the right password: the code and the challenge that goes with it, both
 * hashed. Ten minutes, five tries, once.
 */
export const signInCodes = pgTable(
  'sign_in_codes',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    userId: uuid().notNull(),
    challengeHash: text().notNull().unique(),
    codeHash: text().notNull(),
    client: text().notNull().default('web'),
    attempts: integer().notNull().default(0),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'sign_in_codes_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    code: text().notNull(),
    name: jsonb().$type<Localized>().notNull(),
    description: jsonb().$type<Localized>(),
    // Built-in roles are created for every client and cannot be changed.
    isSystem: boolean().notNull().default(false),
    permissions: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('roles_tenant_id_id_key').on(t.tenantId, t.id),
    unique('roles_tenant_id_code_key').on(t.tenantId, t.code),
    tenantIsolation(),
  ],
);

export const roleAssignments = pgTable(
  'role_assignments',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    userId: uuid().notNull(),
    roleId: uuid().notNull(),
    // Where the role applies. Null means the whole organization.
    orgUnitId: uuid(),
    grantedBy: uuid(),
    grantedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'role_assignments_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'role_assignments_role_fk',
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    foreignKey({
      name: 'role_assignments_org_unit_fk',
      columns: [t.tenantId, t.orgUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    // One grant per user, role and place.
    unique('role_assignments_once_key')
      .on(t.tenantId, t.userId, t.roleId, t.orgUnitId)
      .nullsNotDistinct(),
    index('role_assignments_user_idx').on(t.tenantId, t.userId),
    tenantIsolation(),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    userId: uuid().notNull(),
    // SHA-256 of the session token. The token itself is only with the client.
    tokenHash: text().notNull().unique(),
    client: text().notNull().default('web'),
    // How the person signed in for it: `password`, or `sso` once single
    // sign-on is built. Setting a signing PIN needs a sign-in this recent.
    method: text().notNull().default('password'),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lastSeenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'sessions_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    check('sessions_method', sql`${t.method} in ('password', 'sso')`),
    tenantIsolation(),
  ],
);

// One-time links: an invitation to set a first password, or a password reset.
export const userTokens = pgTable(
  'user_tokens',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    userId: uuid().notNull(),
    purpose: text().notNull(),
    tokenHash: text().notNull().unique(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'user_tokens_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);

// What happened in a hospital's account, and who did it. The application role
// can add rows and read them, never change or delete them.
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // Null for the system and for Trustline staff acting from the admin portal.
    actorId: uuid(),
    action: text().notNull(),
    entityType: text(),
    entityId: uuid(),
    changes: jsonb(),
    ipAddress: text(),
    // Random, set by the database with the address (migration 0058), and
    // kept beside it outside the sealed body: the body holds
    // SHA-256(salt + address) only, so that the address can later be
    // cleared without breaking the chain (docs/specs/audit-trail.md,
    // "Personal data in the trail").
    ipSalt: text(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    // For the viewer (docs/specs/audit-trail.md, "Performance"): newest
    // first, by person, by action.
    index('audit_log_time_idx').on(t.tenantId, t.occurredAt.desc(), t.id.desc()),
    index('audit_log_actor_idx').on(t.tenantId, t.actorId, t.occurredAt),
    index('audit_log_action_idx').on(t.tenantId, t.action, t.occurredAt),
    // One word each, so that no two entries can make the same body
    // (security review 12, L4): the registry's actions and entity types.
    check('audit_log_action_word', sql`${t.action} ~ '^[a-z_]+$'`),
    check('audit_log_entity_type_word', sql`${t.entityType} is null or ${t.entityType} ~ '^[a-z_]+$'`),
    tenantIsolation(),
    // The admin portal adds an entry when it changes what a client may use
    // (`subscription_changed`), the window in which it may import its
    // existing documents (`import_window_changed`) or how the client is
    // offered AI (`ai_settings_changed`), in the same transaction as the
    // change. It can neither read this log
    // nor change it: it holds INSERT alone, on the tenant, action, entity
    // and changes only (migration 0035), so the id and the time are always
    // the database's own. And only that entry, as nobody of the client's:
    // it cannot write a backdated or forged entry of anything else.
    pgPolicy('audit_log_platform_insert', {
      as: 'permissive',
      for: 'insert',
      to: platformRole,
      withCheck: sql`actor_id IS NULL AND ip_address IS NULL AND action IN ('subscription_changed', 'import_window_changed', 'client_created_by_platform', 'client_settings_changed_by_platform', 'ai_settings_changed', 'contract_end_set')`,
    }),
  ],
);

// The audit trail's hash chain (docs/specs/audit-trail.md, "Tamper
// evidence"): one per client, written only by the database's sealing
// function as each transaction that audited commits (migration 0058), so
// that every writer is chained. The application reads it and never writes
// it.

/** Each audit entry's place in its client's chain, and its seal. */
export const auditChain = pgTable(
  'audit_chain',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // From 1, with no gaps.
    seq: bigint({ mode: 'number' }).notNull(),
    // The entry (`audit_log.id`). No foreign key: a deleted entry leaves
    // its seal behind, which is how the daily check finds the deletion.
    entryId: uuid().notNull(),
    // The hash of the entry before (64 zeros for the first).
    prevHash: text().notNull(),
    // SHA-256 of the entry's body, its fixed text form.
    bodyHash: text().notNull(),
    // SHA-256("trustline-audit-v1\n" + seq + "\n" + prevHash + "\n" + bodyHash).
    hash: text().notNull(),
    // SHA-256(salt + address), when the entry had an address.
    ipCommitment: text(),
    sealedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Sealed by the migration that started the chain: shown as "recorded
    // before the trail was sealed". The chain proves it has not changed
    // since, not before.
    sealedLate: boolean().notNull().default(false),
  },
  (t) => [
    primaryKey({ name: 'audit_chain_pkey', columns: [t.tenantId, t.seq] }),
    unique('audit_chain_tenant_id_entry_id_key').on(t.tenantId, t.entryId),
    tenantIsolation(),
  ],
);

/** Each client's last sealed entry: the sealing function's lock. */
export const auditChainHeads = pgTable(
  'audit_chain_heads',
  {
    tenantId: uuid()
      .primaryKey()
      .references(() => tenants.id),
    seq: bigint({ mode: 'number' }).notNull(),
    hash: text().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  () => [tenantIsolation()],
);

/**
 * A client's head as the daily check found it unbroken, signed with
 * Trustline's key (Ed25519). Unsigned (no key, no signature) when the API
 * has no key configured: kept, but trusted by no check.
 */
export const auditChainCheckpoints = pgTable(
  'audit_chain_checkpoints',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    seq: bigint({ mode: 'number' }).notNull(),
    hash: text().notNull(),
    // When it was signed: what was signed holds this time, to the
    // millisecond.
    at: timestamp({ withTimezone: true, precision: 3 }).notNull(),
    keyId: text(),
    signature: text(),
  },
  (t) => [
    index('audit_chain_checkpoints_tenant_seq_idx').on(t.tenantId, t.seq),
    unique('audit_chain_checkpoints_tenant_id_id_key').on(t.tenantId, t.id),
    check(
      'audit_chain_checkpoints_signed_whole',
      sql`(${t.keyId} is null) = (${t.signature} is null)`,
    ),
    // Never dated ahead (security review 12, M1).
    check('audit_chain_checkpoints_not_ahead', sql`${t.at} <= now() + interval '5 minutes'`),
    tenantIsolation(),
  ],
);

export const auditChainResult = pgEnum('audit_chain_result', ['passed', 'failed']);
export const auditChainBreak = pgEnum('audit_chain_break', [
  // An entry, or its seal, is not what was sealed.
  'content_changed',
  // A seal whose entry is gone: a deletion.
  'missing_entry',
  // An entry with no seal, older than ten minutes: written round the trigger.
  'missing_seal',
  // A number missing in the chain.
  'gap',
  // The chain no longer reaches, or no longer matches, a signed checkpoint:
  // its end was cut off, or rewritten.
  'head_rewound',
  // An entry dated more than ten minutes before the checkpoint before it:
  // added after the fact.
  'backdated',
  // A checkpoint whose signature does not verify under its key.
  'bad_checkpoint',
]);

/**
 * Each run of the check: what it covered and what it found. The admin
 * portal reads these rows (and nothing of the entries), through a policy of
 * its own.
 */
export const auditChainVerifications = pgTable(
  'audit_chain_verifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    runAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    fromSeq: bigint({ mode: 'number' }).notNull(),
    toSeq: bigint({ mode: 'number' }).notNull(),
    // From entry 1 (weekly), or from the last signed checkpoint (daily).
    full: boolean().notNull(),
    result: auditChainResult().notNull(),
    kind: auditChainBreak(),
    // The first entry found wrong, by its number, or by its id for an entry
    // with no seal.
    firstBadSeq: bigint({ mode: 'number' }),
    firstBadEntryId: uuid(),
    // The checkpoint signed on success, if any, of the same client.
    checkpointId: uuid(),
    // Whether the break is taken as found (security review 12, L2): a bad
    // checkpoint, which the application role could have written, only
    // when the next run finds it again; every other kind at once.
    confirmed: boolean().notNull().default(true),
  },
  (t) => [
    index('audit_chain_verifications_tenant_run_idx').on(t.tenantId, t.runAt),
    foreignKey({
      name: 'audit_chain_verifications_checkpoint_fk',
      columns: [t.tenantId, t.checkpointId],
      foreignColumns: [auditChainCheckpoints.tenantId, auditChainCheckpoints.id],
    }),
    check(
      'audit_chain_verifications_failure_named',
      sql`(${t.result} = 'failed') = (${t.kind} is not null)`,
    ),
    tenantIsolation(),
    pgPolicy('audit_chain_verifications_platform_read', {
      as: 'permissive',
      for: 'select',
      to: platformRole,
      using: sql`true`,
    }),
  ],
);

export const incidentType = pgEnum('incident_type', [
  'incident',
  'near_miss',
  'hazard',
]);

export const incidentHarmLevel = pgEnum('incident_harm_level', [
  'none',
  'mild',
  'moderate',
  'severe',
  'death',
]);

export const incidentStatus = pgEnum('incident_status', [
  'new',
  'triaged',
  'in_progress',
  // A sentinel event or a death, whose closure waits for a second person.
  'awaiting_sign_off',
  'closed',
  'rejected',
]);

export const incidentEventKind = pgEnum('incident_event_kind', [
  'reported',
  'triaged',
  'assigned',
  'status_changed',
  'commented',
  'reopened',
  'closed',
  'rejected',
  // Closure that needs a second person: asked for, given, or refused.
  'sign_off_requested',
  'signed_off',
  'sent_back',
]);

// How a report arrived: from a signed-in member of staff, or through the
// hospital's public link, which is always anonymous.
export const incidentChannel = pgEnum('incident_channel', ['app', 'public']);

export const incidentCommentVisibility = pgEnum('incident_comment_visibility', [
  'everyone',
  // Not shown to someone who sees the incident only because they reported it.
  'internal',
]);

// What kind of thing went wrong. Every client starts with the default list in
// incidents/categories.ts.
export const incidentCategories = pgTable(
  'incident_categories',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    code: text().notNull(),
    name: jsonb().$type<Localized>().notNull(),
    position: integer().notNull().default(0),
    active: boolean().notNull().default(true),
  },
  (t) => [
    unique('incident_categories_tenant_id_id_key').on(t.tenantId, t.id),
    unique('incident_categories_tenant_id_code_key').on(t.tenantId, t.code),
    tenantIsolation(),
  ],
);

// A reported incident, near miss or hazard. Holds no patient identifier of
// any kind. The application role cannot delete one.
export const incidents = pgTable(
  'incidents',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // INC-<year>-<5 digits>, numbered per tenant and year by nextReference().
    reference: text().notNull(),
    type: incidentType().notNull(),
    categoryId: uuid().notNull(),
    // Where it happened.
    orgUnitId: uuid().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull(),
    // The reporter's own words, in whatever language they wrote.
    description: text().notNull(),
    immediateAction: text(),
    // Null when reported anonymously. Nothing else may record who it was.
    reportedBy: uuid(),
    channel: incidentChannel().notNull().default('app'),
    // SHA-256 of the follow-up code an anonymous reporter was shown once, so
    // they can come back to their report. The code itself is stored nowhere.
    // Null for a named report: its reporter signs in instead.
    followUpCodeHash: text(),
    reportedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // When the reporter opened the form, as their device told it, to measure
    // how long reporting takes. Null when not sent or not believable. It is
    // a time only: it says nothing about who reported.
    reportStartedAt: timestamp({ withTimezone: true }),
    // Set by the reporter, corrected at triage.
    harmLevel: incidentHarmLevel().notNull(),
    isSentinel: boolean().notNull().default(false),
    // Set once the incident has been a sentinel event or a death, when it is
    // reported or triaged, and never cleared: closing it then takes a second
    // person even if its harm level is lowered or the flag removed later.
    // A report through the public link is not set by the sender's own harm
    // level: only once a triager has graded it (`first_triaged_at`).
    signOffNeeded: boolean().notNull().default(false),
    status: incidentStatus().notNull().default('new'),
    // The department responsible, and the person in it. Both set at triage.
    ownerUnitId: uuid(),
    assignedTo: uuid(),
    triagedBy: uuid(),
    triagedAt: timestamp({ withTimezone: true }),
    closedBy: uuid(),
    closedAt: timestamp({ withTimezone: true }),
    closureSummary: text(),
    rejectionReason: text(),
    // Who asked for a sentinel event or a death to be closed, and when. Set
    // while it awaits sign-off and kept once signed off; cleared when the
    // request is sent back or withdrawn, or the incident reopened. The person
    // who signs off must be someone else.
    closureRequestedBy: uuid(),
    closureRequestedAt: timestamp({ withTimezone: true }),
    // When it should have been triaged by, and closed by: the reported time
    // plus what the hospital's response rules allowed when the report was
    // made. Triage never moves the first. The second is counted again, still
    // from the reported time, when triage changes the harm level or the
    // sentinel flag. A later change to the rules moves neither. A reopening
    // gives new ones, counted from the reopening (the `*_due_from` columns):
    // a closing deadline always, a triage deadline when the report goes
    // back to `new`. Whether an incident is overdue is worked out from these
    // when it is read, never stored.
    // Nullable only so that a release still running during a deployment can
    // go on storing reports: the deadline check fills in any it left empty.
    triageDueAt: timestamp({ withTimezone: true }),
    closeDueAt: timestamp({ withTimezone: true }),
    // When the time to triage it started to run: the reopening, for a report
    // set aside before triage and reopened, which goes back to `new` with a
    // new triage deadline counted from then. Null means from the report.
    triageDueFrom: timestamp({ withTimezone: true }),
    // The triage deadline its first triage (or setting aside) was measured
    // against, kept here when a reopening replaces `triage_due_at`, so that
    // "triaged on time" goes on judging that first decision by the deadline
    // it was made under. Null while `triage_due_at` is still that deadline.
    firstTriageDueAt: timestamp({ withTimezone: true }),
    // When the time to close it started to run: the reopening, for an
    // incident that was reopened, which gives it a new deadline counted from
    // then. Null means from the report. The deadline it had before stays on
    // the timeline, in the `reopened` entry.
    closeDueFrom: timestamp({ withTimezone: true }),
    // When it first left `new` by triage, or by being set aside, which
    // decides about it as much. `triagedAt` moves with every later
    // correction, so it cannot say whether the first decision was on time.
    // For a report through the public link it also says that its harm level
    // is now one a member of staff gave, not the sender's own.
    firstTriagedAt: timestamp({ withTimezone: true }),
    // When each deadline notification was sent, so each is sent once. The
    // deadline check claims an incident by setting the column, in the same
    // transaction as it writes the notifications.
    triageDueSoonAt: timestamp({ withTimezone: true }),
    triageOverdueAt: timestamp({ withTimezone: true }),
    closeDueSoonAt: timestamp({ withTimezone: true }),
    closeOverdueAt: timestamp({ withTimezone: true }),
    // The closing deadline each of the two was sent for. Triage can move the
    // deadline, and a deadline is announced only if it is later than the
    // last one announced at that stage, so that changing the harm level back
    // and forth never repeats a notification. Cleared with the two above
    // when the incident is reopened. Null beside a time set by a release
    // that did not record it: read as sent for the deadline it has.
    closeDueSoonFor: timestamp({ withTimezone: true }),
    closeOverdueFor: timestamp({ withTimezone: true }),
    // Raised by every triage and every change of status, and by nothing
    // else. Someone saving a decision says which revision they were looking
    // at, so a decision made on an out-of-date screen is refused. A comment
    // does not raise it: it changes nothing a decision rests on.
    revision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('incidents_tenant_id_id_key').on(t.tenantId, t.id),
    unique('incidents_tenant_id_reference_key').on(t.tenantId, t.reference),
    // A report is found by its follow-up code alone, so within a hospital no
    // two reports may share one. (Reports without a code do not collide.)
    unique('incidents_follow_up_code_key').on(t.tenantId, t.followUpCodeHash),
    foreignKey({
      name: 'incidents_category_fk',
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [incidentCategories.tenantId, incidentCategories.id],
    }),
    foreignKey({
      name: 'incidents_org_unit_fk',
      columns: [t.tenantId, t.orgUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    foreignKey({
      name: 'incidents_owner_unit_fk',
      columns: [t.tenantId, t.ownerUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    foreignKey({
      name: 'incidents_reported_by_fk',
      columns: [t.tenantId, t.reportedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'incidents_assigned_to_fk',
      columns: [t.tenantId, t.assignedTo],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'incidents_triaged_by_fk',
      columns: [t.tenantId, t.triagedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'incidents_closed_by_fk',
      columns: [t.tenantId, t.closedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'incidents_closure_requested_by_fk',
      columns: [t.tenantId, t.closureRequestedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    // A report through the public link names nobody, and only a report that
    // names nobody has a follow-up code: the code can never lead to a person.
    check(
      'incidents_public_is_anonymous',
      sql`${t.channel} <> 'public' or ${t.reportedBy} is null`,
    ),
    check(
      'incidents_follow_up_code_is_anonymous',
      sql`${t.followUpCodeHash} is null or ${t.reportedBy} is null`,
    ),
    // The list is filtered by status and shown newest first.
    index('incidents_status_idx').on(t.tenantId, t.status, t.reportedAt),
    index('incidents_reported_by_idx').on(t.tenantId, t.reportedBy),
    index('incidents_org_unit_idx').on(t.tenantId, t.orgUnitId),
    index('incidents_owner_unit_idx').on(t.tenantId, t.ownerUnitId),
    // "Assigned to me", and the assignee's part of who may see an incident:
    // without it every list for a reporter or assignee reads the whole table.
    index('incidents_assigned_to_idx').on(t.tenantId, t.assignedTo),
    // What the deadline check looks for every five minutes, and the order of
    // the list "by deadline".
    // How many reports came through the public link in the last hour: asked
    // before every such report, for the ceiling per hospital.
    index('incidents_public_recent_idx')
      .on(t.tenantId, t.reportedAt)
      .where(sql`${t.channel} = 'public'`),
    index('incidents_triage_due_idx').on(t.tenantId, t.status, t.triageDueAt),
    index('incidents_close_due_idx').on(t.tenantId, t.status, t.closeDueAt),
    tenantIsolation(),
  ],
);

// The timeline of an incident. Like the audit log, the application role can
// add rows and read them, never change or delete them.
export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid().notNull(),
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    kind: incidentEventKind().notNull(),
    // Null for an anonymous report.
    actorId: uuid(),
    fromStatus: incidentStatus(),
    toStatus: incidentStatus(),
    details: jsonb(),
    // Hidden unless said otherwise, so a forgotten value never shows the
    // reporter something internal.
    visibleToReporter: boolean().notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: 'incident_events_incident_fk',
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
    }),
    foreignKey({
      name: 'incident_events_actor_fk',
      columns: [t.tenantId, t.actorId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('incident_events_incident_idx').on(
      t.tenantId,
      t.incidentId,
      t.occurredAt,
    ),
    tenantIsolation(),
  ],
);

// The application role can add and read comments, not change or delete them.
export const incidentComments = pgTable(
  'incident_comments',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    incidentId: uuid().notNull(),
    // Null for a comment written with a follow-up code: its author is the
    // anonymous reporter, and nothing may record who that is.
    authorId: uuid(),
    // Written as the reporter: with a follow-up code, or signed in by someone
    // who at that moment saw the incident only because they reported it.
    // Decided when the comment is written, never worked out afterwards from
    // who the author is. To a reader not told who reported, such a comment
    // is "by the reporter" and names nobody.
    byReporter: boolean().notNull().default(false),
    // Written as one of the people handling the incident: the author saw all
    // of it at that moment. Such a comment carries its author's name for
    // every reader, also when the author happens to be the reporter, so a
    // name on a comment says nothing about who reported. False on comments
    // stored before this was recorded, and on any written by a release that
    // does not record it: those keep being read the old, cautious way.
    asHandler: boolean().notNull().default(false),
    body: text().notNull(),
    // No default: whoever writes a comment must say who may read it.
    visibility: incidentCommentVisibility().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'incident_comments_incident_fk',
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
    }),
    foreignKey({
      name: 'incident_comments_author_fk',
      columns: [t.tenantId, t.authorId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('incident_comments_incident_idx').on(
      t.tenantId,
      t.incidentId,
      t.createdAt,
    ),
    // Every comment is written by a user or by the anonymous reporter.
    check(
      'incident_comments_has_writer',
      sql`${t.authorId} is not null or ${t.byReporter}`,
    ),
    // Written as the reporter or as a handler, never as both.
    check(
      'incident_comments_one_capacity',
      sql`not (${t.byReporter} and ${t.asHandler})`,
    ),
    tenantIsolation(),
  ],
);

// How quickly a hospital means to triage and to close an incident, by harm
// level. One row per level; a sentinel event uses the `death` row. Every
// client starts with the values in incidents/response-rules.ts and is
// expected to change them. The application role cannot delete a row.
export const incidentResponseRules = pgTable(
  'incident_response_rules',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    harmLevel: incidentHarmLevel().notNull(),
    // Calendar time: hours on the clock, days on the hospital's calendar.
    triageWithinHours: integer().notNull(),
    closeWithinDays: integer().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'incident_response_rules_pkey',
      columns: [t.tenantId, t.harmLevel],
    }),
    check(
      'incident_response_rules_triage_hours',
      sql`${t.triageWithinHours} between 1 and 720`,
    ),
    check(
      'incident_response_rules_close_days',
      sql`${t.closeWithinDays} between 1 and 365`,
    ),
    tenantIsolation(),
  ],
);

/** What a notification carries: short words, flags and counts only. */
// A value is plain, or a name in each of the client's languages, shown with
// `pick()` (`review_approval_turned_off`'s `typeName`).
export type NotificationData = Record<string, string | number | boolean | Localized>;

export const notificationKind = pgEnum('notification_kind', [
  'incident_reported',
  'incident_assigned',
  'incident_handed_over',
  'comment_added',
  'status_changed',
  'sign_off_requested',
  'sign_off_decided',
  'due_soon',
  'overdue',
  // An incident was made a sentinel event at triage.
  'sentinel_flagged',
  // The hospital's public form turned a report away because it had taken
  // its hour's worth. About the hospital, not about an incident.
  'public_form_paused',
  // Policies and procedures: about a controlled document (`document_id`).
  // A step of an approval run is now the recipient's to decide.
  'document_step_assigned',
  // A version was returned to draft by a reviewer or approver.
  'document_returned',
  // A version passed the last step of its route.
  'document_approved',
  // A version requiring acknowledgement was published to its audience.
  'document_published',
  // Someone who joined a document's audience after it was published is
  // asked to acknowledge it.
  'acknowledgement_assigned',
  // Half the time allowed to acknowledge has gone.
  'acknowledgement_due',
  // The time allowed to acknowledge has passed.
  'acknowledgement_overdue',
  // A document's periodic review is 60, 30 or 7 days away.
  'review_due',
  // A document's periodic review date has passed.
  'review_overdue',
  // A step of an approval run has passed its due time undecided: to the
  // document's managers, once per step.
  'document_step_overdue',
  // An approved version was not published on its scheduled day because its
  // signatures no longer stand behind what it holds: to the document's
  // managers, once per version.
  'document_publish_failed',
  // Once a week, to the managers of the units whose people have
  // acknowledgements overdue: how many. About no one document.
  'acknowledgements_overdue_digest',
  // An import made the recipient the owner of a document (quality review
  // 3, S1): its periodic review, and its re-issue, are theirs.
  'document_owner_assigned',
  // An email's unsubscribe link switched a kind of email off, so that the
  // person sees it in Trustline (security review 8, L2): `data.switch`.
  // About nothing else.
  'email_turned_off',
  // An imported document awaits its owner's confirmation: 7 days before it
  // is due, and once it is overdue (`data.overdue`). To the owner and the
  // importer.
  'import_confirmation_due',
  // A "no change" periodic review awaits the Approving authority's
  // signature: to those who may give it.
  'review_approval_requested',
  // The Approving authority returned a "no change" review: to its owner.
  'review_returned',
  // The person's signing PIN was set, changed or reset. About nothing else.
  'signing_pin_changed',
  // Signing with the person's PIN was locked after too many wrong PINs
  // (security review 11). About nothing else.
  'signing_pin_locked',
  // A document type no longer asks for the Approving authority's signature
  // of a "no change" review (security review 11): to the Approving
  // authorities and the Administrators. About the type, not a document.
  'review_approval_turned_off',
  // The daily check found the audit trail broken (docs/specs/audit-trail.md):
  // to the holders of `audit.view` and `settings.manage`, at once. About
  // the organization.
  'audit_chain_broken',
  // Someone was given `policies.import` (business decision on security
  // review 11): to the other Quality officers and Administrators.
  // `data.personId` names them. About no document.
  'policies_import_granted',
  // An external reviewer's access was granted, extended or ended
  // (`data.change`, `data.personId`): to the holders of `users.manage` for
  // the whole organization.
  'external_access_changed',
  // Once a week, to the Administrators: the number and hash of the head
  // of the audit chain, so that a copy of it is outside Trustline's hands
  // (decision 5). Emailed, and not to be switched off.
  'audit_chain_head',
  // A full data export was asked for, approved, refused, made, failed, or
  // downloaded (docs/specs/data-export.md, `data.change`, `data.exportId`):
  // to every holder of `data.export` or `settings.manage` for the whole
  // organization, in the app and by email at once. Names nobody.
  'data_export_changed',
  // AI (docs/specs/ai-providers-and-allowances.md), to the client's
  // administrators, about the organization. Trustline's staff changed which
  // provider serves an AI feature, or whether AI is offered at all
  // (`data.features`, comma-separated).
  'ai_provider_changed',
  // 80% of a feature's monthly allowance is used (`data.feature`, `used`,
  // `allowance`, `month`): once a month per feature.
  'ai_allowance_warning',
  // All of it is used: the feature pauses until `data.resetsOn`. Once a
  // month per feature.
  'ai_allowance_reached',
  // The contract ends in 90, 30 or 7 days (`data.endsOn`, `data.days`): to
  // the client's administrators and holders of `data.export`, in the app
  // and by email, so that its data can be exported first.
  'contract_ending',
  // Someone was given `data.export` for the whole organization
  // (`data.personId`): to the other Administrators, as for
  // `policies.import`.
  'data_export_granted',
]);

// Something a user is told about an incident they can see. Stored so that it
// can be shown in the app now and sent by email later. The application role
// can add and read rows and set `read_at`, nothing else: what was sent to
// whom cannot be rewritten.
export const notifications = pgTable(
  'notifications',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // Who it is for. Never anyone who could not see the incident at the time.
    userId: uuid().notNull(),
    kind: notificationKind().notNull(),
    // Null only for a notification about the hospital itself rather than
    // one of its incidents (`public_form_paused`), and for one about a
    // controlled document, which names `document_id` instead.
    incidentId: uuid(),
    // The controlled document a notification of the policies module is
    // about. Whoever reads the list is told whether they can still open it.
    documentId: uuid(),
    // The incident's reference, whether it is serious and, for some kinds,
    // which deadline or which outcome. Never a name, a description or the
    // text of a comment: nothing a patient, a reporter or a member of staff
    // could be identified from.
    data: jsonb().$type<NotificationData>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'notifications_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notifications_incident_fk',
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
    }),
    foreignKey({
      name: 'notifications_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    // A user's own, newest first; and the count of those not yet read.
    index('notifications_user_idx').on(t.tenantId, t.userId, t.createdAt),
    // For the composite keys that point here (email_queue): a notification
    // of the same tenant only. Built concurrently on a database that has
    // notifications already (migrate.ts), before the migration that needs it.
    uniqueIndex('notifications_tenant_id_id_key').on(t.tenantId, t.id),
    index('notifications_unread_idx')
      .on(t.tenantId, t.userId)
      .where(sql`${t.readAt} is null`),
    // Every notification is about an incident or a document, never both,
    // except the kinds that are about the hospital, or about many
    // documents at once. Compared as text so that the check does not need a
    // new kind to be committed before it is created.
    check(
      'notifications_about_one_thing',
      sql`(${t.incidentId} is null or ${t.documentId} is null) and (${t.incidentId} is not null or ${t.documentId} is not null or ${t.kind}::text in ('public_form_paused', 'acknowledgements_overdue_digest', 'email_turned_off', 'signing_pin_changed', 'signing_pin_locked', 'review_approval_turned_off', 'audit_chain_broken', 'policies_import_granted', 'external_access_changed', 'audit_chain_head', 'data_export_changed', 'ai_provider_changed', 'ai_allowance_warning', 'ai_allowance_reached', 'contract_ending', 'data_export_granted'))`,
    ),
    tenantIsolation(),
  ],
);

// The last number given out for each kind of reference, per tenant and year.
// Only nextReference() in incidents/reference.ts should write here.
export const referenceCounters = pgTable(
  'reference_counters',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    prefix: text().notNull(),
    year: integer().notNull(),
    lastNumber: integer().notNull().default(0),
  },
  (t) => [
    primaryKey({
      name: 'reference_counters_pkey',
      columns: [t.tenantId, t.prefix, t.year],
    }),
    tenantIsolation(),
  ],
);

// Policies and procedures (docs/specs/policies-and-procedures.md), and the
// approval engine documents go through. Every table is tenant data under
// row-level security, every reference to another row is a composite foreign
// key with the tenant, and nothing a client writes is ever deleted: a
// document is retired, a version withdrawn or superseded. The grants for the
// application role are in the migration that follows this one.

/** One section a type of document is written in. */
export type DocumentSection = {
  /** Lowercase, fixed: the key of the section's text in a version. */
  key: string;
  name: Localized;
  /** Must be written in the default language before review. */
  required: boolean;
};

/**
 * A version's text: per language, per section key, Markdown limited to
 * paragraphs, lists, bold and headings (see policies/content.ts).
 */
export type DocumentContent = Partial<Record<string, Record<string, string>>>;

export const documentStatus = pgEnum('document_status', [
  // Never published.
  'draft',
  // Has a published version.
  'active',
  'retired',
]);

export const documentConfidentiality = pgEnum('document_confidentiality', [
  // Anyone who may read documents.
  'all_staff',
  // Only its audience, and those who manage documents or see them all.
  'restricted',
]);

export const documentVersionStatus = pgEnum('document_version_status', [
  'draft',
  'in_review',
  'approved',
  'published',
  'superseded',
  'withdrawn',
]);

// Where a version's text came from: `written` in Trustline's editor,
// `imported` from a client's existing library as approved before Trustline
// (always version 1 of a document made by the import, with its
// `document_imports` row), `ai_drafted` (docs/specs/ai-policy-drafting.md)
// for later. A document carries it too: how it came into Trustline. Fixed
// once written (migration 0045). Not part of what an approval signs.
export const documentVersionSource = pgEnum('document_version_source', [
  'written',
  'imported',
  'ai_drafted',
]);

export const documentReviewOutcome = pgEnum('document_review_outcome', [
  'no_change',
  'revised',
  'retired',
]);

// Policy, procedure, work instruction: the three every client starts with
// (policies/defaults.ts), and any it adds. Switched off, never deleted.
export const documentTypes = pgTable(
  'document_types',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // Lowercase, fixed once created.
    code: text().notNull(),
    name: jsonb().$type<Localized>().notNull(),
    // The start of each number: POL, PRC, WI. A change numbers documents
    // created from then on; a document keeps its number for life.
    numberPrefix: text().notNull(),
    // In order. A version takes the type's sections when it is created and
    // keeps them, so a later change here does not alter what was written.
    sections: jsonb().$type<DocumentSection[]>().notNull(),
    defaultReviewMonths: integer().notNull(),
    // Whether a periodic review confirmed as needing no change also needs
    // the Approving authority's signature before the next review date
    // moves (business decision 6). On for policies, by default.
    noChangeNeedsApproval: boolean().notNull().default(false),
    active: boolean().notNull().default(true),
    position: integer().notNull().default(0),
    // Raised by every change, for stale-save protection (409 `stale_type`).
    revision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_types_tenant_id_id_key').on(t.tenantId, t.id),
    unique('document_types_tenant_id_code_key').on(t.tenantId, t.code),
    check(
      'document_types_prefix_shape',
      sql`${t.numberPrefix} ~ '^[A-Z][A-Z0-9]{1,5}$'`,
    ),
    check(
      'document_types_review_months',
      sql`${t.defaultReviewMonths} between 1 and 120`,
    ),
    tenantIsolation(),
  ],
);

// What a document is about (governance, safety…), as a tree. The code is
// the middle of each number: PRC-SAF-014. Switched off, never deleted.
export const documentCategories = pgTable(
  'document_categories',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // Capitals and digits, fixed once created: it is in every number.
    code: text().notNull(),
    name: jsonb().$type<Localized>().notNull(),
    parentId: uuid(),
    active: boolean().notNull().default(true),
    position: integer().notNull().default(0),
    // Raised by every change, for stale-save protection (409
    // `stale_category`).
    revision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_categories_tenant_id_id_key').on(t.tenantId, t.id),
    unique('document_categories_tenant_id_code_key').on(t.tenantId, t.code),
    foreignKey({
      name: 'document_categories_parent_fk',
      columns: [t.tenantId, t.parentId],
      foreignColumns: [t.tenantId, t.id],
    }),
    check(
      'document_categories_code_shape',
      sql`${t.code} ~ '^[A-Z][A-Z0-9]{1,5}$'`,
    ),
    tenantIsolation(),
  ],
);

// One controlled document, which keeps its number for life. The
// application role cannot delete one.
export const documents = pgTable(
  'documents',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // <prefix>-<category code>-<at least 3 digits>, from reference_counters
    // when the document is created (policies/numbering.ts). Never reused.
    number: text().notNull(),
    typeId: uuid().notNull(),
    categoryId: uuid().notNull(),
    title: jsonb().$type<Localized>().notNull(),
    // The person accountable for it, and the unit that owns it. Managers
    // scoped to a unit manage the documents that unit and those below own.
    ownerId: uuid().notNull(),
    ownerUnitId: uuid().notNull(),
    confidentiality: documentConfidentiality().notNull().default('all_staff'),
    keywords: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Free text, e.g. "JCI IPSG.1", "ISO 45001 7.2".
    references: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    reviewMonths: integer().notNull(),
    // Days on the client's calendar.
    nextReviewOn: date({ mode: 'string' }),
    lastReviewedOn: date({ mode: 'string' }),
    // The language whose text of this document stands (business decision
    // 5): one of the client's, or null for the organization's setting.
    authoritativeLocale: text(),
    status: documentStatus().notNull().default('draft'),
    // How it came into Trustline: `written`, or `imported` with its first
    // version (approved before Trustline). Stays so after it is re-issued.
    source: documentVersionSource().notNull().default('written'),
    // An AI draft (docs/specs/ai-policy-drafting.md): the conversation it
    // came from, and the person who took ownership of it. Until someone
    // does, it is marked "AI draft" and cannot be sent for review.
    aiDraftSessionId: uuid(),
    aiDraftOwnedBy: uuid(),
    aiDraftOwnedAt: timestamp({ withTimezone: true }),
    // Its foreign keys to document_versions are added by migrations, as the
    // two tables point at each other, which this file cannot type:
    // documents_published_version_fk (with the tenant, 0039) and
    // documents_published_version_own_fk (with the tenant and the document,
    // so that a document names only a version of its own: 0041).
    publishedVersionId: uuid(),
    retiredAt: timestamp({ withTimezone: true }),
    retiredBy: uuid(),
    retireReason: text(),
    createdBy: uuid().notNull(),
    // Which review reminder was sent last (1: 60 days, 2: 30, 3: 7,
    // 4: overdue) and for which review date, so each is sent once. Claimed
    // by the daily check in the transaction that writes the notifications.
    reviewNoticeRank: integer(),
    reviewNoticeFor: date({ mode: 'string' }),
    // Raised by every change a decision rests on. Someone saving says which
    // revision they read, so a change made on an out-of-date screen is
    // refused (409 `stale_document`).
    revision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('documents_tenant_id_id_key').on(t.tenantId, t.id),
    unique('documents_tenant_id_number_key').on(t.tenantId, t.number),
    // An imported number is kept as given, in its own capitals; two numbers
    // that differ only by them would be the same number to a reader.
    uniqueIndex('documents_number_any_case_key').on(
      t.tenantId,
      sql`upper(${t.number})`,
    ),
    foreignKey({
      name: 'documents_type_fk',
      columns: [t.tenantId, t.typeId],
      foreignColumns: [documentTypes.tenantId, documentTypes.id],
    }),
    foreignKey({
      name: 'documents_category_fk',
      columns: [t.tenantId, t.categoryId],
      foreignColumns: [documentCategories.tenantId, documentCategories.id],
    }),
    foreignKey({
      name: 'documents_owner_fk',
      columns: [t.tenantId, t.ownerId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'documents_owner_unit_fk',
      columns: [t.tenantId, t.ownerUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    foreignKey({
      name: 'documents_retired_by_fk',
      columns: [t.tenantId, t.retiredBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'documents_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'documents_review_months',
      sql`${t.reviewMonths} between 1 and 120`,
    ),
    // Active means published: the one published version is named.
    check(
      'documents_active_is_published',
      sql`${t.status} <> 'active' or ${t.publishedVersionId} is not null`,
    ),
    index('documents_status_idx').on(t.tenantId, t.status, t.nextReviewOn),
    index('documents_owner_unit_idx').on(t.tenantId, t.ownerUnitId),
    index('documents_owner_idx').on(t.tenantId, t.ownerId),
    check(
      'documents_authoritative_locale',
      sql`${t.authoritativeLocale} is null or ${t.authoritativeLocale} ~ '^[a-z]{2}$'`,
    ),
    tenantIsolation(),
  ],
);

// Whom a document applies to: one row per org unit (null: the whole
// organization; a unit covers its descendants), optionally narrowed to
// people holding a role (null: anyone). Replaced as a whole when edited.
export const documentAudiences = pgTable(
  'document_audiences',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    documentId: uuid().notNull(),
    orgUnitId: uuid(),
    roleId: uuid(),
  },
  (t) => [
    foreignKey({
      name: 'document_audiences_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    foreignKey({
      name: 'document_audiences_org_unit_fk',
      columns: [t.tenantId, t.orgUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    // A role the audience is narrowed to cannot be deleted from under it.
    foreignKey({
      name: 'document_audiences_role_fk',
      columns: [t.tenantId, t.roleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    unique('document_audiences_once_key')
      .on(t.tenantId, t.documentId, t.orgUnitId, t.roleId)
      .nullsNotDistinct(),
    tenantIsolation(),
  ],
);

// One edition of a document's content. The application role cannot delete
// one. At most one is published and at most one is in progress (draft, in
// review or approved) per document, which the two indexes below keep.
export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    documentId: uuid().notNull(),
    version: integer().notNull(),
    status: documentVersionStatus().notNull().default('draft'),
    // The type's sections when the version was created, kept as they were.
    sections: jsonb().$type<DocumentSection[]>().notNull(),
    content: jsonb()
      .$type<DocumentContent>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Required from version 2, before review.
    changeSummary: jsonb().$type<Localized>(),
    preparedBy: uuid().notNull(),
    preparedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Everyone who created, edited or sent this version for review. None of
    // them may decide a step of its approval (403 `same_person`).
    contributors: uuid()
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // The day it takes effect, on the client's calendar. Set when it is
    // published, or when publishing is scheduled for a later day.
    effectiveOn: date({ mode: 'string' }),
    // Who scheduled it for `effective_on`, while it waits for that day.
    scheduledBy: uuid(),
    approvedAt: timestamp({ withTimezone: true }),
    publishedAt: timestamp({ withTimezone: true }),
    // Null when the daily check published it on its scheduled day.
    publishedBy: uuid(),
    supersededAt: timestamp({ withTimezone: true }),
    withdrawnAt: timestamp({ withTimezone: true }),
    withdrawnBy: uuid(),
    acknowledgementRequired: boolean().notNull().default(false),
    acknowledgeWithinDays: integer().notNull().default(14),
    source: documentVersionSource().notNull().default('written'),
    // The language whose text stands, recorded when the version is sent for
    // review or imported (security review 7, finding 3): every version that
    // is no longer a draft is checked, flagged and shown against it, whatever
    // the client's setting becomes. A draft follows the setting; this is
    // written again each time it is sent. Null on a draft never sent.
    authoritativeLocale: text(),
    // Whether what is signed of the version includes `authoritative_locale`
    // (policies/signed-content.ts): true for every version sent or imported
    // since migration 0049. False for those it recorded the language of,
    // whose signatures were made over the earlier form and stay valid.
    signsAuthoritativeLocale: boolean().notNull().default(false),
    // As documents.revision, for the version's own changes and decisions
    // (409 `stale_version`).
    revision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_versions_tenant_id_id_key').on(t.tenantId, t.id),
    // For documents_published_version_own_fk: a document's published
    // version is one of its own.
    unique('document_versions_document_id_key').on(
      t.tenantId,
      t.documentId,
      t.id,
    ),
    unique('document_versions_number_key').on(
      t.tenantId,
      t.documentId,
      t.version,
    ),
    foreignKey({
      name: 'document_versions_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    foreignKey({
      name: 'document_versions_prepared_by_fk',
      columns: [t.tenantId, t.preparedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_versions_scheduled_by_fk',
      columns: [t.tenantId, t.scheduledBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_versions_published_by_fk',
      columns: [t.tenantId, t.publishedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_versions_withdrawn_by_fk',
      columns: [t.tenantId, t.withdrawnBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    uniqueIndex('document_versions_one_published')
      .on(t.tenantId, t.documentId)
      .where(sql`${t.status} = 'published'`),
    uniqueIndex('document_versions_one_in_progress')
      .on(t.tenantId, t.documentId)
      .where(sql`${t.status} in ('draft', 'in_review', 'approved')`),
    check('document_versions_version', sql`${t.version} >= 1`),
    // An import makes a document with its first version; a later version
    // is written, through the route.
    check(
      'document_versions_imported_first',
      sql`${t.source} <> 'imported' or ${t.version} = 1`,
    ),
    check(
      'document_versions_acknowledge_days',
      sql`${t.acknowledgeWithinDays} between 1 and 365`,
    ),
    check(
      'document_versions_authoritative_locale',
      sql`${t.authoritativeLocale} is null or ${t.authoritativeLocale} ~ '^[a-z]{2}$'`,
    ),
    // What is signed can include only a language that is recorded.
    check(
      'document_versions_signed_locale_recorded',
      sql`not ${t.signsAuthoritativeLocale} or ${t.authoritativeLocale} is not null`,
    ),
    // What the daily check looks for: approved versions due to publish.
    index('document_versions_scheduled_idx')
      .on(t.tenantId, t.effectiveOn)
      .where(sql`${t.status} = 'approved' and ${t.effectiveOn} is not null`),
    tenantIsolation(),
  ],
);

export const approvalStepKind = pgEnum('approval_step_kind', [
  'review',
  'approve',
]);

export const approvalRunStatus = pgEnum('approval_run_status', [
  'in_progress',
  'approved',
  'returned',
  'cancelled',
]);

export const approvalRunStepStatus = pgEnum('approval_run_step_status', [
  // Not reached yet.
  'waiting',
  // The current step, to be decided.
  'pending',
  'approved',
  'returned',
  // Never reached: the run was returned or cancelled before it.
  'skipped',
]);

export const signatureMeaning = pgEnum('signature_meaning', [
  'reviewed',
  'approved',
  'reviewed_no_change',
  'acknowledged',
  // The importer's statement that an imported version's text matches the
  // original approved before Trustline, with the details of that approval.
  'imported',
  // The owner's confirmation of an imported document (business decision 1).
  'import_confirmed',
  // The Approving authority's signature of a "no change" periodic review
  // (business decision 6).
  'reviewed_no_change_approved',
]);

// The ordered steps something must pass before it is approved. Generic
// (approvals/): `subject` is `document` today, investigations later. Each
// client starts with one per document type (policies/defaults.ts).
export const approvalRoutes = pgTable(
  'approval_routes',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    name: jsonb().$type<Localized>().notNull(),
    subject: text().notNull(),
    // The route for documents of that type; null: for any type without one.
    documentTypeId: uuid(),
    active: boolean().notNull().default(true),
    revision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('approval_routes_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'approval_routes_document_type_fk',
      columns: [t.tenantId, t.documentTypeId],
      foreignColumns: [documentTypes.tenantId, documentTypes.id],
    }),
    check('approval_routes_subject', sql`${t.subject} in ('document')`),
    // One active route per subject and type, so which applies is never in
    // doubt.
    uniqueIndex('approval_routes_one_active')
      .on(
        t.tenantId,
        t.subject,
        sql`coalesce(${t.documentTypeId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      )
      .where(sql`${t.active}`),
    tenantIsolation(),
  ],
);

// A step of a route. Its assignee is a named user or a role (anyone holding
// it over the subject's owning unit), never both. Replaced as a whole when
// the route is edited; a run copies its steps when it starts.
export const approvalRouteSteps = pgTable(
  'approval_route_steps',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    routeId: uuid().notNull(),
    position: integer().notNull(),
    kind: approvalStepKind().notNull(),
    assigneeUserId: uuid(),
    assigneeRoleId: uuid(),
    // How many people of a role must act. 1 in this release.
    required: integer().notNull().default(1),
    dueInDays: integer().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'approval_route_steps_route_fk',
      columns: [t.tenantId, t.routeId],
      foreignColumns: [approvalRoutes.tenantId, approvalRoutes.id],
    }),
    foreignKey({
      name: 'approval_route_steps_user_fk',
      columns: [t.tenantId, t.assigneeUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'approval_route_steps_role_fk',
      columns: [t.tenantId, t.assigneeRoleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    unique('approval_route_steps_position_key').on(
      t.tenantId,
      t.routeId,
      t.position,
    ),
    check(
      'approval_route_steps_one_assignee',
      sql`(${t.assigneeUserId} is null) <> (${t.assigneeRoleId} is null)`,
    ),
    check('approval_route_steps_required', sql`${t.required} = 1`),
    check(
      'approval_route_steps_due_days',
      sql`${t.dueInDays} between 1 and 365`,
    ),
    tenantIsolation(),
  ],
);

// One pass of a subject through a route. At most one in progress per
// subject.
export const approvalRuns = pgTable(
  'approval_runs',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    routeId: uuid().notNull(),
    // `document_version` today.
    subjectType: text().notNull(),
    subjectId: uuid().notNull(),
    status: approvalRunStatus().notNull().default('in_progress'),
    currentPosition: integer(),
    startedBy: uuid().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    unique('approval_runs_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'approval_runs_route_fk',
      columns: [t.tenantId, t.routeId],
      foreignColumns: [approvalRoutes.tenantId, approvalRoutes.id],
    }),
    foreignKey({
      name: 'approval_runs_started_by_fk',
      columns: [t.tenantId, t.startedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'approval_runs_subject_type',
      sql`${t.subjectType} in ('document_version')`,
    ),
    index('approval_runs_subject_idx').on(
      t.tenantId,
      t.subjectType,
      t.subjectId,
    ),
    uniqueIndex('approval_runs_one_in_progress')
      .on(t.tenantId, t.subjectType, t.subjectId)
      .where(sql`${t.status} = 'in_progress'`),
    tenantIsolation(),
  ],
);

// A step of a run, copied from the route when the run started so that a
// later change of the route does not alter a run in progress.
export const approvalRunSteps = pgTable(
  'approval_run_steps',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    runId: uuid().notNull(),
    position: integer().notNull(),
    kind: approvalStepKind().notNull(),
    assigneeUserId: uuid(),
    assigneeRoleId: uuid(),
    dueInDays: integer().notNull(),
    status: approvalRunStepStatus().notNull().default('waiting'),
    // Set when the step becomes the current one.
    activatedAt: timestamp({ withTimezone: true }),
    dueAt: timestamp({ withTimezone: true }),
    decidedBy: uuid(),
    decidedAt: timestamp({ withTimezone: true }),
    comment: text(),
    // The signature of an approval; none for a return.
    signatureId: uuid(),
  },
  (t) => [
    foreignKey({
      name: 'approval_run_steps_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [approvalRuns.tenantId, approvalRuns.id],
    }),
    foreignKey({
      name: 'approval_run_steps_user_fk',
      columns: [t.tenantId, t.assigneeUserId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'approval_run_steps_role_fk',
      columns: [t.tenantId, t.assigneeRoleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    foreignKey({
      name: 'approval_run_steps_decided_by_fk',
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'approval_run_steps_signature_fk',
      columns: [t.tenantId, t.signatureId],
      foreignColumns: [signatures.tenantId, signatures.id],
    }),
    unique('approval_run_steps_position_key').on(
      t.tenantId,
      t.runId,
      t.position,
    ),
    check(
      'approval_run_steps_one_assignee',
      sql`(${t.assigneeUserId} is null) <> (${t.assigneeRoleId} is null)`,
    ),
    // "My pending steps".
    index('approval_run_steps_pending_idx')
      .on(t.tenantId, t.status)
      .where(sql`${t.status} = 'pending'`),
    tenantIsolation(),
  ],
);

// An electronic signature: written only after the signer re-entered their
// password in the same request, with a hash of exactly what was signed. The
// application role may add and read them, never change or delete one.
export const signatures = pgTable(
  'signatures',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    userId: uuid().notNull(),
    signedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    meaning: signatureMeaning().notNull(),
    // `document_version` or `document`.
    subjectType: text().notNull(),
    subjectId: uuid().notNull(),
    // SHA-256, hex, of the canonical JSON of what was signed
    // (approvals/signatures.ts).
    contentHash: text().notNull(),
    method: text().notNull().default('password'),
  },
  (t) => [
    unique('signatures_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'signatures_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'signatures_subject_type',
      sql`${t.subjectType} in ('document_version', 'document')`,
    ),
    check('signatures_method', sql`${t.method} in ('password')`),
    check('signatures_hash_shape', sql`${t.contentHash} ~ '^[0-9a-f]{64}$'`),
    index('signatures_subject_idx').on(t.tenantId, t.subjectType, t.subjectId),
    tenantIsolation(),
  ],
);

// A periodic review of a document. Written once, never changed.
export const documentReviews = pgTable(
  'document_reviews',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    documentId: uuid().notNull(),
    // The review date this answers.
    dueOn: date({ mode: 'string' }),
    outcome: documentReviewOutcome().notNull(),
    comment: text(),
    reviewedBy: uuid().notNull(),
    reviewedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    signatureId: uuid(),
    nextReviewOn: date({ mode: 'string' }),
    // Where the type asks for it (business decision 6): who approved a
    // "no change" review, and their signature.
    approvedBy: uuid(),
    approvalSignatureId: uuid(),
  },
  (t) => [
    foreignKey({
      name: 'document_reviews_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    foreignKey({
      name: 'document_reviews_reviewed_by_fk',
      columns: [t.tenantId, t.reviewedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_reviews_signature_fk',
      columns: [t.tenantId, t.signatureId],
      foreignColumns: [signatures.tenantId, signatures.id],
    }),
    foreignKey({
      name: 'document_reviews_approved_by_fk',
      columns: [t.tenantId, t.approvedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_reviews_approval_signature_fk',
      columns: [t.tenantId, t.approvalSignatureId],
      foreignColumns: [signatures.tenantId, signatures.id],
    }),
    index('document_reviews_document_idx').on(t.tenantId, t.documentId),
    tenantIsolation(),
  ],
);

export const reviewApprovalStatus = pgEnum('review_approval_status', [
  'pending',
  'approved',
  'returned',
]);

// A "no change" periodic review awaiting the Approving authority's
// signature (business decision 6): the owner's confirmation, signed, and
// how the approver decided. The review is recorded in document_reviews,
// and the next review date moves, only once it is approved.
export const documentReviewApprovals = pgTable(
  'document_review_approvals',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    documentId: uuid().notNull(),
    // The review date this answers.
    dueOn: date({ mode: 'string' }),
    comment: text().notNull(),
    requestedBy: uuid().notNull(),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    requestSignatureId: uuid().notNull(),
    status: reviewApprovalStatus().notNull().default('pending'),
    decidedBy: uuid(),
    decidedAt: timestamp({ withTimezone: true }),
    decisionComment: text(),
    decisionSignatureId: uuid(),
  },
  (t) => [
    foreignKey({
      name: 'document_review_approvals_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    foreignKey({
      name: 'document_review_approvals_requested_by_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_review_approvals_decided_by_fk',
      columns: [t.tenantId, t.decidedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_review_approvals_request_signature_fk',
      columns: [t.tenantId, t.requestSignatureId],
      foreignColumns: [signatures.tenantId, signatures.id],
    }),
    foreignKey({
      name: 'document_review_approvals_decision_signature_fk',
      columns: [t.tenantId, t.decisionSignatureId],
      foreignColumns: [signatures.tenantId, signatures.id],
    }),
    // One awaiting at a time per document.
    uniqueIndex('document_review_approvals_one_pending')
      .on(t.tenantId, t.documentId)
      .where(sql`${t.status} = 'pending'`),
    check(
      'document_review_approvals_decided',
      sql`(${t.status} = 'pending') = (${t.decidedBy} is null and ${t.decidedAt} is null)`,
    ),
    check(
      'document_review_approvals_approved_signed',
      sql`${t.status} <> 'approved' or ${t.decisionSignatureId} is not null`,
    ),
    tenantIsolation(),
  ],
);

// Who is asked to acknowledge a published version, and whether they have.
// One row per person and version: made when it is published, for everyone
// in its audience then, and by the daily check for those who join later.
export const documentAcknowledgements = pgTable(
  'document_acknowledgements',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    versionId: uuid().notNull(),
    userId: uuid().notNull(),
    assignedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // A day on the client's calendar.
    dueOn: date({ mode: 'string' }).notNull(),
    acknowledgedAt: timestamp({ withTimezone: true }),
    signatureId: uuid(),
    // When the reminder at half the time was sent, and the one when overdue.
    remindedAt: timestamp({ withTimezone: true }),
    overdueRemindedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'document_acknowledgements_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [documentVersions.tenantId, documentVersions.id],
    }),
    foreignKey({
      name: 'document_acknowledgements_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_acknowledgements_signature_fk',
      columns: [t.tenantId, t.signatureId],
      foreignColumns: [signatures.tenantId, signatures.id],
    }),
    unique('document_acknowledgements_once_key').on(
      t.tenantId,
      t.versionId,
      t.userId,
    ),
    check(
      'document_acknowledgements_signed',
      sql`(${t.acknowledgedAt} is null) = (${t.signatureId} is null)`,
    ),
    index('document_acknowledgements_user_idx')
      .on(t.tenantId, t.userId)
      .where(sql`${t.acknowledgedAt} is null`),
    tenantIsolation(),
  ],
);

// The policies module's settings that belong to a whole client. No row
// means the defaults: a client has one only once it changed something.
export const documentSettings = pgTable(
  'document_settings',
  {
    tenantId: uuid()
      .primaryKey()
      .references(() => tenants.id),
    // The longest review period a document may have, in months. A change
    // of a document's period above it is refused; documents set longer
    // before it was lowered keep theirs until they are next changed.
    maxReviewMonths: integer().notNull().default(36),
    // The language whose text of a document stands, against which the
    // others are checked, flagged and shown (policies/languages.ts). Null:
    // the client's main language, whatever it is at the time.
    authoritativeLocale: text(),
    revision: integer().notNull().default(1),
    updatedBy: uuid(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'document_settings_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'document_settings_max_review_months',
      sql`${t.maxReviewMonths} between 1 and 120`,
    ),
    check(
      'document_settings_authoritative_locale',
      sql`${t.authoritativeLocale} ~ '^[a-z]{2}$'`,
    ),
    tenantIsolation(),
  ],
);

// What a version held when it was sent for review, once per approval run:
// what its reviewers read (the database keeps a version in review from
// changing), so that a version returned and changed can be compared with
// what was returned. Written once, never changed.
export const documentReviewRounds = pgTable(
  'document_review_rounds',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    versionId: uuid().notNull(),
    runId: uuid().notNull(),
    sections: jsonb().$type<DocumentSection[]>().notNull(),
    content: jsonb().$type<DocumentContent>().notNull(),
    changeSummary: jsonb().$type<Localized>(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'document_review_rounds_version_fk',
      columns: [t.tenantId, t.versionId],
      foreignColumns: [documentVersions.tenantId, documentVersions.id],
    }),
    foreignKey({
      name: 'document_review_rounds_run_fk',
      columns: [t.tenantId, t.runId],
      foreignColumns: [approvalRuns.tenantId, approvalRuns.id],
    }),
    unique('document_review_rounds_run_key').on(t.tenantId, t.runId),
    index('document_review_rounds_version_idx').on(t.tenantId, t.versionId),
    tenantIsolation(),
  ],
);

// One import of a client's existing documents (docs/specs/policies-and-
// procedures.md, "Import"): one password re-entry by the importer covering
// the listed documents, each with its own signature. `list_hash` is the
// SHA-256 of the canonical list of what was signed, in order. Written once,
// never changed.
export const documentImportBatches = pgTable(
  'document_import_batches',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    importedBy: uuid().notNull(),
    importedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    size: integer().notNull(),
    listHash: text().notNull(),
  },
  (t) => [
    unique('document_import_batches_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'document_import_batches_imported_by_fk',
      columns: [t.tenantId, t.importedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('document_import_batches_size', sql`${t.size} between 1 and 100`),
    check(
      'document_import_batches_hash_shape',
      sql`${t.listHash} ~ '^[0-9a-f]{64}$'`,
    ),
    tenantIsolation(),
  ],
);

// What an imported document was before Trustline, as the paper says: the
// number as given (null when Trustline numbered it), its revision label,
// when and by whom it was approved, where the signed original is kept, the
// day it took effect, and its next review date; and which of its sections
// had no text when it was imported. With the importer's signature (meaning
// `imported`). One per imported document and version. Written once, never
// changed: what it says changes only through a new version.
export const documentImports = pgTable(
  'document_imports',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    batchId: uuid().notNull(),
    // Where it stood in the batch, from 0.
    batchIndex: integer().notNull(),
    documentId: uuid().notNull(),
    versionId: uuid().notNull(),
    numberAsGiven: text(),
    revisionLabel: text(),
    approvedOn: date({ mode: 'string' }).notNull(),
    // As written on the original: a transcription, not a translatable name.
    approvedBy: text().notNull(),
    originalKeptAt: jsonb().$type<Localized>().notNull(),
    effectiveOn: date({ mode: 'string' }).notNull(),
    nextReviewOn: date({ mode: 'string' }).notNull(),
    // When the original was last reviewed, as it says (quality review 3,
    // M2): the next review is counted from it, or from the approval.
    lastReviewedOn: date({ mode: 'string' }),
    // Where the text in Trustline differs from the original ("Table 2
    // written as a list"), per language (quality review 3, M3). Signed with
    // the import: the text matches the original except as noted here.
    differences: jsonb().$type<Localized>(),
    // The owner's confirmation of the import (business decision 1): due on
    // this day, given with a signature (`import_confirmed`); or given by the
    // import itself when the importer is the owner.
    confirmationDueOn: date({ mode: 'string' }),
    // Whom it is due from: the owner when imported, and each new owner
    // while it awaits (security review 11). Never the importer.
    confirmationDueFrom: uuid(),
    confirmedAt: timestamp({ withTimezone: true }),
    confirmedBy: uuid(),
    confirmationSignatureId: uuid(),
    confirmedByImport: boolean().notNull().default(false),
    // Sections with no text in the authoritative language when imported.
    sectionsNotWritten: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    signatureId: uuid().notNull(),
    importedBy: uuid().notNull(),
    importedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'document_imports_batch_fk',
      columns: [t.tenantId, t.batchId],
      foreignColumns: [documentImportBatches.tenantId, documentImportBatches.id],
    }),
    foreignKey({
      name: 'document_imports_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    // The version is one of the document's own.
    foreignKey({
      name: 'document_imports_version_fk',
      columns: [t.tenantId, t.documentId, t.versionId],
      foreignColumns: [
        documentVersions.tenantId,
        documentVersions.documentId,
        documentVersions.id,
      ],
    }),
    foreignKey({
      name: 'document_imports_signature_fk',
      columns: [t.tenantId, t.signatureId],
      foreignColumns: [signatures.tenantId, signatures.id],
    }),
    foreignKey({
      name: 'document_imports_imported_by_fk',
      columns: [t.tenantId, t.importedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_imports_confirmation_due_from_fk',
      columns: [t.tenantId, t.confirmationDueFrom],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_imports_confirmed_by_fk',
      columns: [t.tenantId, t.confirmedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'document_imports_confirmation_signature_fk',
      columns: [t.tenantId, t.confirmationSignatureId],
      foreignColumns: [signatures.tenantId, signatures.id],
    }),
    // Confirmed with its own signature, or by the import itself.
    check(
      'document_imports_confirmation',
      sql`${t.confirmedAt} is null or (${t.confirmedBy} is not null and (${t.confirmedByImport} or ${t.confirmationSignatureId} is not null))`,
    ),
    unique('document_imports_document_key').on(t.tenantId, t.documentId),
    unique('document_imports_version_key').on(t.tenantId, t.versionId),
    unique('document_imports_batch_index_key').on(
      t.tenantId,
      t.batchId,
      t.batchIndex,
    ),
    check(
      'document_imports_dates',
      sql`${t.effectiveOn} >= ${t.approvedOn} and ${t.nextReviewOn} > ${t.approvedOn}`,
    ),
    check(
      'document_imports_last_reviewed',
      sql`${t.lastReviewedOn} is null or (${t.lastReviewedOn} >= ${t.approvedOn} and ${t.nextReviewOn} > ${t.lastReviewedOn})`,
    ),
    tenantIsolation(),
  ],
);

// What the daily check of the policies module has sent once and must not
// send again: an overdue approval step (`step_overdue`, the run step), a
// scheduled version left unpublished (`publish_failed`, the version), the
// weekly digest of overdue acknowledgements (`acknowledgement_digest`, the
// manager, for the week). Claimed by inserting the row in the transaction
// that writes the notifications: whoever inserts it first sends it.
export const policyReminders = pgTable(
  'policy_reminders',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    kind: text().notNull(),
    subjectId: uuid().notNull(),
    // For what recurs: the week (`2026-W48`). Empty for what is sent once.
    period: text().notNull().default(''),
    sentAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'policy_reminders_pkey',
      columns: [t.tenantId, t.kind, t.subjectId, t.period],
    }),
    check(
      'policy_reminders_kind',
      sql`${t.kind} in ('step_overdue', 'publish_failed', 'acknowledgement_digest', 'import_confirmation_due', 'import_confirmation_overdue')`,
    ),
    tenantIsolation(),
  ],
);

// Email (docs/specs/email.md): notifications sent by email as well, from a
// queue the background worker sends, through SMTP or into an outbox when no
// mail service is configured. Every table is tenant data under row-level
// security; the grants for the application role are in migration 0047.

// An organization's email setting. No row: email is on.
export const emailSettings = pgTable(
  'email_settings',
  {
    tenantId: uuid()
      .primaryKey()
      .references(() => tenants.id),
    // Switched off by the client's administrator: nothing is sent to anyone.
    enabled: boolean().notNull().default(true),
    // The day, on the organization's calendar, whose daily digests have been
    // queued: claimed by whichever process moves it first, so each day is
    // queued once.
    digestsQueuedOn: date({ mode: 'string' }),
    updatedBy: uuid(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'email_settings_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    tenantIsolation(),
  ],
);

// What a person wants by email. No row: both on.
export const emailPreferences = pgTable(
  'email_preferences',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    userId: uuid().notNull(),
    // The immediate emails (docs/specs/email.md, section 1).
    immediate: boolean().notNull().default(true),
    // The daily digest and the weekly one.
    digest: boolean().notNull().default(true),
    // When each was last switched back on: an unsubscribe link issued
    // before it no longer works for it (security review 8, L2).
    immediateOnSince: timestamp({ withTimezone: true }),
    digestOnSince: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'email_preferences_pkey',
      columns: [t.tenantId, t.userId],
    }),
    foreignKey({
      name: 'email_preferences_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);

export const emailCategory = pgEnum('email_category', [
  'immediate',
  'daily_digest',
  'weekly_digest',
  // An external reviewer's one-time sign-in code: sent at once, by the
  // request that asks for it, never by the worker.
  'sign_in_code',
]);

export const emailStatus = pgEnum('email_status', [
  'pending',
  'sending',
  'sent',
  'skipped',
  'failed',
]);

// One email to send. Holds what it is about and where it stands, never its
// content or the address: those are made when it is sent. Kept 30 days once
// finished.
export const emailQueue = pgTable(
  'email_queue',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    userId: uuid().notNull(),
    category: emailCategory().notNull(),
    // The notification it sends (immediate, weekly digest). Null for a
    // daily digest, which is made from what waits for the person that day.
    // Of the same tenant (email_queue_notification_fk).
    notificationId: uuid(),
    // For a daily digest: its day on the organization's calendar.
    period: date({ mode: 'string' }),
    status: emailStatus().notNull().default('pending'),
    // Attempts made, the one in progress included: what a process that
    // claimed the row must still find there to record how it ended.
    attempts: integer().notNull().default(0),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Until when the process sending it holds its claim.
    claimedUntil: timestamp({ withTimezone: true }),
    sentAt: timestamp({ withTimezone: true }),
    // Why it was skipped or failed: a word, never a message.
    reason: text(),
    // The code of the last failure (`ECONNECTION`, `451`), never its text.
    lastError: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'email_queue_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
    // Keys with the tenant, as every other here (security review 8, L3):
    // a foreign key is checked past row-level security, so one of the id
    // alone could name another tenant's row.
    foreignKey({
      name: 'email_queue_notification_fk',
      columns: [t.tenantId, t.notificationId],
      foreignColumns: [notifications.tenantId, notifications.id],
    }).onDelete('cascade'),
    uniqueIndex('email_queue_tenant_id_id_key').on(t.tenantId, t.id),
    // One email per notification, and one daily digest per person per day.
    uniqueIndex('email_queue_notification_key')
      .on(t.tenantId, t.notificationId)
      .where(sql`${t.notificationId} is not null`),
    uniqueIndex('email_queue_digest_key')
      .on(t.tenantId, t.userId, t.period)
      .where(sql`${t.category} = 'daily_digest'`),
    // What the worker looks for: what is due, and what is finished.
    index('email_queue_due_idx')
      .on(t.tenantId, t.nextAttemptAt)
      .where(sql`${t.status} in ('pending', 'sending')`),
    index('email_queue_finished_idx').on(t.tenantId, t.updatedAt),
    check(
      'email_queue_about_one_thing',
      sql`(${t.category} = 'daily_digest') = (${t.notificationId} is null and ${t.period} is not null)`,
    ),
    check(
      'email_queue_reason_shape',
      sql`${t.reason} is null or ${t.reason} ~ '^[a-z_]{1,40}$'`,
    ),
    check(
      'email_queue_error_shape',
      sql`${t.lastError} is null or ${t.lastError} ~ '^[A-Za-z0-9_]{1,40}$'`,
    ),
    tenantIsolation(),
  ],
);

// What would have been sent, when no mail service is configured: kept here
// and never sent. One per queue row. Kept 30 days.
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // Of the same tenant (email_outbox_queue_fk).
    queueId: uuid().notNull(),
    toAddress: text().notNull(),
    subject: text().notNull(),
    textBody: text().notNull(),
    htmlBody: text().notNull(),
    headers: jsonb().$type<Record<string, string>>().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'email_outbox_queue_fk',
      columns: [t.tenantId, t.queueId],
      foreignColumns: [emailQueue.tenantId, emailQueue.id],
    }).onDelete('cascade'),
    uniqueIndex('email_outbox_queue_key').on(t.tenantId, t.queueId),
    index('email_outbox_created_idx').on(t.tenantId, t.createdAt),
    tenantIsolation(),
  ],
);

// Platform tables: Trustline's own staff and what they do in the admin portal.
// They hold no hospital data. Only the trustline_platform role can reach them,
// and that role has no access to tenant data tables.

export const platformAdmins = pgTable('platform_admins', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  name: text().notNull(),
  passwordHash: text().notNull(),
  failedAttempts: integer().notNull().default(0),
  lockedUntil: timestamp({ withTimezone: true }),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const platformSessions = pgTable('platform_sessions', {
  id: uuid().primaryKey().defaultRandom(),
  // SHA-256 of the session token. The token itself is only in the cookie.
  tokenHash: text().notNull().unique(),
  adminId: uuid()
    .notNull()
    .references(() => platformAdmins.id, { onDelete: 'cascade' }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const platformAuditLog = pgTable(
  'platform_audit_log',
  {
    id: uuid().primaryKey().defaultRandom(),
    adminId: uuid().references(() => platformAdmins.id),
    action: text().notNull(),
    targetTenantId: uuid().references(() => tenants.id),
    details: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('platform_audit_log_tenant_idx').on(t.targetTenantId)],
);

/** One price of a plan. Not shown to clients; nothing charges it yet. */
export type PlanPrice = {
  /** ISO 4217, e.g. "SAR". */
  currency: string;
  /** In the currency's smallest unit, so that no amount is a fraction. */
  amountMinor: number;
  term: 'monthly' | 'yearly';
  basis: 'flat' | 'per_user' | 'per_site';
};

// A plan Trustline offers: a named bundle of modules, limits and extras.
// Trustline's own data, not a client's: the admin portal writes it, and the
// application role may read only what entitlements are made of (see the
// grants migration), never prices. Retired, never deleted.
export const plans = pgTable('plans', {
  id: uuid().primaryKey().defaultRandom(),
  // Lowercase, fixed once created.
  code: text().notNull().unique(),
  // In every language the product has: any client may be shown it.
  name: jsonb().$type<Localized>().notNull(),
  description: jsonb().$type<Localized>(),
  // Codes from MODULES in subscriptions/modules.ts. Core is never listed.
  modules: text()
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  // Every key of LIMITS, null meaning no limit.
  limits: jsonb().$type<Limits>().notNull(),
  // Every key of EXTRAS.
  extras: jsonb().$type<Extras>().notNull(),
  prices: jsonb()
    .$type<PlanPrice[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  // The monthly AI allowance per feature (ai/features.ts): drafts,
  // suggestions, assistant messages. Every feature said; null is no limit,
  // zero is not included. A client's own override is in ai_client_settings.
  aiAllowances: jsonb()
    .$type<AiAllowances>()
    .notNull()
    .default(sql.raw(`'${JSON.stringify(NO_AI_ALLOWANCES)}'::jsonb`)),
  // A retired plan keeps its clients and can be given to no other.
  active: boolean().notNull().default(true),
  // Order in the admin portal, smallest first.
  position: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const subscriptionStatus = pgEnum(
  'subscription_status',
  SUBSCRIPTION_STATUSES,
);

// What a client is entitled to: its plan, and what was agreed for it on top.
// One per client. Tenant data under row-level security, which the
// application reads (never the note) and only the admin portal writes.
export const subscriptions = pgTable(
  'subscriptions',
  {
    tenantId: uuid()
      .primaryKey()
      .references(() => tenants.id),
    planId: uuid()
      .notNull()
      .references(() => plans.id),
    status: subscriptionStatus().notNull().default('active'),
    // Days, not moments: what a contract says.
    startsOn: date({ mode: 'string' }).notNull(),
    renewsOn: date({ mode: 'string' }),
    trialEndsOn: date({ mode: 'string' }),
    // Modules on top of the plan's.
    addOnModules: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    // Limits that differ from the plan's: a key present replaces the plan's
    // value (null: no limit), a key absent leaves it.
    limitOverrides: jsonb()
      .$type<Partial<Limits>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Trustline's own note. The application role cannot read it.
    note: text(),
    // Every session and one-time link issued before this moment is void.
    // Set, by the database's clock, whenever the subscription is cancelled
    // and whenever it leaves cancelled, so that making it active again
    // brings back none of what was issued before it was cancelled, nor
    // anything issued by a request that was under way when it was.
    accessResetAt: timestamp({ withTimezone: true }),
    // The contract's end, its exit window and its retention
    // (docs/specs/data-export.md, "At the end of a contract"), set by
    // Trustline's staff. None changes a status by itself. The exit window
    // is set to 90 days when the subscription is cancelled, unless staff
    // set another; the data is kept until `retain_until` (the end of the
    // exit window unless set), then deleted. The application reads the
    // three.
    endsOn: date({ mode: 'string' }),
    exitUntil: date({ mode: 'string' }),
    retainUntil: date({ mode: 'string' }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_plan_idx').on(t.planId),
    check('subscriptions_retain_after_exit', sql`${t.retainUntil} is null or ${t.exitUntil} is null or ${t.retainUntil} >= ${t.exitUntil}`),
    tenantIsolation(),
    pgPolicy('subscriptions_platform', {
      as: 'permissive',
      for: 'all',
      to: platformRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

/**
 * The day each module was first switched on for a client: when it first
 * became one of the modules its subscription gives, by whatever change
 * (its plan, an add-on, a plan given the module, the subscription leaving
 * cancelled). Written by the database itself (trigger
 * `record_module_starts`, migration 0049) and never changed: switched off
 * and on again, a module keeps its first day. The policies module reads it
 * for the import window (security review 7, finding 2).
 */
export const moduleStarts = pgTable(
  'module_starts',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    module: text().notNull(),
    // On the client's calendar.
    startedOn: date({ mode: 'string' }).notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'module_starts_pkey', columns: [t.tenantId, t.module] }),
    check('module_starts_module', sql`${t.module} ~ '^[a-z_]{1,40}$'`),
    tenantIsolation(),
    pgPolicy('module_starts_platform', {
      as: 'permissive',
      for: 'select',
      to: platformRole,
      using: sql`true`,
    }),
  ],
);

/**
 * When a client's window to import its existing documents closes, where
 * Trustline's staff have set it (reopened or closed it, with a reason). No
 * row: 90 days after the policies module was first switched on
 * (policies/import-window.ts). Written by the admin portal only.
 */
export const policyImportWindows = pgTable(
  'policy_import_windows',
  {
    tenantId: uuid()
      .primaryKey()
      .references(() => tenants.id),
    // The last day imports are accepted, on the client's calendar.
    closesOn: date({ mode: 'string' }).notNull(),
    reason: text().notNull(),
    setBy: uuid()
      .notNull()
      .references(() => platformAdmins.id),
    setAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'policy_import_windows_reason',
      sql`length(${t.reason}) between 1 and 500`,
    ),
    tenantIsolation(),
    pgPolicy('policy_import_windows_platform', {
      as: 'permissive',
      for: 'all',
      to: platformRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

// Reports and measures over time (docs/specs/reports-and-measures.md).

export const measureStatus = pgEnum('measure_status', ['provisional', 'final']);
export const measureMethod = pgEnum('measure_method', ['snapshot', 'reconstructed', 'corrected']);

/**
 * One measure's figure for one month, for the organization (`org_unit_id`
 * null) or one unit and everything beneath it. Never changed nor deleted
 * (SELECT and INSERT only, and a trigger: migration 0066): a correction, and
 * a provisional figure becoming final, are new revisions.
 */
export const measureSnapshots = pgTable(
  'measure_snapshots',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // The first day of the month, on the client's calendar.
    month: date({ mode: 'string' }).notNull(),
    // Its code (reports/measures.ts).
    measure: text().notNull(),
    orgUnitId: uuid(),
    // Which unit a record counts for: where it happened, its owner, the
    // person's own unit.
    unitBasis: text().notNull(),
    // The unit's path, from the top, when the figure was taken.
    unitPath: uuid().array(),
    value: numeric({ mode: 'number' }),
    numerator: integer(),
    denominator: integer(),
    details: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    target: numeric({ mode: 'number' }),
    // `business` (the default in code), `client` (its own), `baseline`
    // (the client's figure from before Trustline), `first_months` (the
    // first three months in Trustline), or null.
    targetSource: text(),
    status: measureStatus().notNull(),
    method: measureMethod().notNull(),
    revision: integer().notNull(),
    // Why a correction was asked for, and by whom. Null for the check.
    reason: text(),
    requestedBy: uuid(),
    // The month's first moment on its clock when taken (null on rows taken
    // before migration 0070): a correction works the month out again on
    // the same boundaries (security review 16, M1).
    startsAt: timestamp({ withTimezone: true }),
    // The end of the month: the first moment of the next, on its clock.
    asAt: timestamp({ withTimezone: true }).notNull(),
    // Set by the database for the application (migration 0071).
    takenAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    definitionVersion: integer().notNull(),
  },
  (t) => [
    uniqueIndex('measure_snapshots_once').on(
      t.tenantId,
      t.month,
      t.measure,
      sql`coalesce(${t.orgUnitId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.unitBasis,
      t.revision,
    ),
    index('measure_snapshots_series_idx').on(t.tenantId, t.measure, t.orgUnitId, t.month),
    foreignKey({
      name: 'measure_snapshots_unit_fk',
      columns: [t.tenantId, t.orgUnitId],
      foreignColumns: [orgUnits.tenantId, orgUnits.id],
    }),
    check('measure_snapshots_measure_code', sql`${t.measure} ~ '^[a-z_]+\\.[a-z_]+$'`),
    check('measure_snapshots_month_first', sql`extract(day from ${t.month}) = 1`),
    check('measure_snapshots_revision', sql`${t.revision} >= 1`),
    check(
      'measure_snapshots_correction_said',
      sql`(${t.method} = 'corrected') = (${t.reason} is not null)`,
    ),
    check(
      'measure_snapshots_correction_requested',
      sql`(${t.method} = 'corrected') = (${t.requestedBy} is not null)`,
    ),
    foreignKey({
      name: 'measure_snapshots_requested_by_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * A client's own targets and reporting baseline (decisions 1 and 2): one
 * row once it changed something. Targets by measure code; the baseline is
 * its monthly average of reports before Trustline, with where it comes
 * from.
 */
export const reportSettings = pgTable(
  'report_settings',
  {
    tenantId: uuid()
      .primaryKey()
      .references(() => tenants.id),
    targets: jsonb().$type<Record<string, number>>().notNull().default({}),
    baselineMonthlyAverage: numeric({ mode: 'number' }),
    baselineNote: jsonb().$type<Localized>(),
    revision: integer().notNull().default(1),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid(),
  },
  (t) => [
    foreignKey({
      name: 'report_settings_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    tenantIsolation(),
  ],
);

/** A contract contact's written request, as Trustline's staff record it. */
export type WrittenRequest = { receivedOn: string; from: string; reference: string; note: string | null };

export const dataExportReason = pgEnum('data_export_reason', ['contract_end', 'on_request']);
export const dataExportStatus = pgEnum('data_export_status', [
  // Asked for, waiting for a second holder of `data.export`.
  'requested',
  // Approved, waiting for the worker.
  'approved',
  'refused',
  // Not approved within 7 days.
  'lapsed',
  // Cancelled by the person who asked, before it was made.
  'cancelled',
  // Being made by the worker.
  'making',
  // Made, and downloadable until `expires_at` or the last download.
  'ready',
  // Could not be made after the retries.
  'failed',
  // Its file deleted: past `expires_at`, or downloaded the most times.
  'expired',
]);

/**
 * A full export of a client's data (docs/specs/data-export.md): asked for
 * by one holder of `data.export`, approved by another, made by the export
 * worker from one moment of the data, and kept, encrypted, until
 * downloaded at most 5 times within 7 days. The record stays when its file
 * is gone. At most one is asked for or in the making per client at a time
 * (`data_exports_one_open`).
 */
export const dataExports = pgTable(
  'data_exports',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    reason: dataExportReason().notNull(),
    note: text(),
    // The CSV files' language and the README's first one: one of the client's.
    locale: text().notNull(),
    // PDFs follow once the shared renderer exists (business decision): kept
    // as asked, and said in the archive.
    includePdfs: boolean().notNull().default(false),
    status: dataExportStatus().notNull().default('requested'),
    requestedBy: uuid().notNull(),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Seven days after the request, unless approved before.
    lapsesAt: timestamp({ withTimezone: true }).notNull(),
    approvedBy: uuid(),
    approvedAt: timestamp({ withTimezone: true }),
    // Trustline's approval, for a client with one holder of `data.export`
    // (decision 3): which staff member recorded it, when, and the contract
    // contact's written request it was made on. It releases nothing to
    // Trustline. Written only by `data_export_second_approval()`.
    trustlineApprovedBy: uuid().references(() => platformAdmins.id),
    trustlineApprovedAt: timestamp({ withTimezone: true }),
    writtenRequest: jsonb().$type<WrittenRequest>(),
    refusedBy: uuid(),
    refusedAt: timestamp({ withTimezone: true }),
    refusedReason: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    // The worker: its claim, the phase it is in, and its tries.
    claimedAt: timestamp({ withTimezone: true }),
    phase: text(),
    attempts: integer().notNull().default(0),
    // The kind of the last failure, never its message.
    errorKind: text(),
    // The moment of the data the archive holds.
    snapshotAt: timestamp({ withTimezone: true }),
    // Rows of each table in the archive.
    counts: jsonb().$type<Record<string, number>>(),
    sizeBytes: bigint({ mode: 'number' }),
    archiveSha256: text(),
    manifestSha256: text(),
    // Where the encrypted archive is kept, and its own key, wrapped by the
    // storage key (exports/storage.ts). Never shown.
    storageKey: text(),
    wrappedKey: text(),
    readyAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    expiredAt: timestamp({ withTimezone: true }),
    downloads: integer().notNull().default(0),
    lastDownloadedAt: timestamp({ withTimezone: true }),
    // Raised by every change, for stale-save protection (409 `stale_export`).
    revision: integer().notNull().default(1),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('data_exports_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'data_exports_requested_by_fk',
      columns: [t.tenantId, t.requestedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'data_exports_approved_by_fk',
      columns: [t.tenantId, t.approvedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'data_exports_refused_by_fk',
      columns: [t.tenantId, t.refusedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    // One asked for or in the making per client (409 `export_in_progress`).
    uniqueIndex('data_exports_one_open')
      .on(t.tenantId)
      .where(sql`${t.status} in ('requested', 'approved', 'making')`),
    index('data_exports_tenant_idx').on(t.tenantId, t.requestedAt),
    // The worker's queue, client by client.
    index('data_exports_status_idx').on(t.tenantId, t.status),
    check('data_exports_not_self_approved', sql`${t.approvedBy} is null or ${t.approvedBy} <> ${t.requestedBy}`),
    check('data_exports_not_self_refused', sql`${t.refusedBy} is null or ${t.refusedBy} <> ${t.requestedBy}`),
    check(
      'data_exports_one_approval',
      sql`(${t.trustlineApprovedBy} is null or ${t.approvedBy} is null) and ((${t.trustlineApprovedBy} is null) = (${t.writtenRequest} is null))`,
    ),
    // Trustline's staff see an export's status, never who asked (names are
    // the client's): the columns granted in a migration.
    pgPolicy('data_exports_platform_read', {
      as: 'permissive',
      for: 'select',
      to: platformRole,
      using: sql`true`,
    }),
    check('data_exports_downloads', sql`${t.downloads} between 0 and 5`),
    check('data_exports_note', sql`${t.note} is null or length(${t.note}) <= 1000`),
    tenantIsolation(),
  ],
);

// ---------------------------------------------------------------------------
// AI (docs/specs/ai-providers-and-allowances.md). The connections and the
// platform's own settings are Trustline's data; a client's settings, the
// features it is offered, its requests and its usage notices are tenant data
// under row-level security. No table here holds a credential or the text of
// a request: a connection names the environment variable its credential is
// in, and a request is recorded by its size, cost and outcome only.
// ---------------------------------------------------------------------------

export const aiProviderKind = pgEnum('ai_provider_kind', AI_PROVIDER_KINDS);
export const aiInferenceType = pgEnum('ai_inference_type', INFERENCE_TYPES);
export const aiFeature = pgEnum('ai_feature', AI_FEATURES);
export const aiRequestOutcome = pgEnum('ai_request_outcome', [
  // Admitted and sent; its cost is the most it can be until it ends.
  'pending',
  'succeeded',
  // The provider failed or timed out, twice if the first was worth a retry.
  'failed',
  // Not sent: the allowance or a spending limit was reached.
  'refused',
]);

/**
 * A model a connection offers, by the provider's own id for it (Bedrock's
 * differ from Anthropic's, and say where a request may go: `global.`,
 * `eu.`), with what it costs, in US dollars per million tokens, to estimate
 * each request's cost.
 */
export type AiModel = {
  id: string;
  label: string;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
};

// A provider connection Trustline holds: which service, where it processes
// requests, the models it offers, and the name of the environment variable
// that holds its credential (never the credential). Deactivated, never
// deleted: the requests made through it keep pointing at it. Written by the
// admin portal; read by the application, which needs the variable's name.
export const aiProviderConnections = pgTable(
  'ai_provider_connections',
  {
    id: uuid().primaryKey().defaultRandom(),
    // Trustline's own name for it. Not shown to clients.
    name: text().notNull().unique(),
    kind: aiProviderKind().notNull(),
    // The provider's region code (`me-central-1`), or for the Anthropic API
    // the geography asked for (`us`), or `global`.
    region: text().notNull(),
    inferenceType: aiInferenceType().notNull(),
    models: jsonb()
      .$type<AiModel[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // AI_CREDENTIAL_<NAME>: only such a variable may be named, so that no
    // connection can be pointed at another secret of the deployment.
    credentialEnv: text().notNull(),
    active: boolean().notNull().default(true),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'ai_provider_connections_credential_env',
      sql`${t.credentialEnv} ~ '^AI_CREDENTIAL_[A-Z0-9_]{1,50}$'`,
    ),
    check(
      'ai_provider_connections_name',
      sql`length(${t.name}) between 1 and 100`,
    ),
    check(
      'ai_provider_connections_region',
      sql`${t.region} ~ '^[a-z0-9-]{2,30}$'`,
    ),
  ],
);

// Trustline's own AI settings, one row: the spending limit over every
// client together, per calendar month in UTC. Null: no limit.
export const aiPlatformSettings = pgTable(
  'ai_platform_settings',
  {
    id: boolean().primaryKey().default(true),
    monthlySpendingLimitMicroUsd: bigint({ mode: 'number' }),
    updatedBy: uuid().references(() => platformAdmins.id),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ai_platform_settings_one_row', sql`${t.id}`),
    check(
      'ai_platform_settings_spending_limit',
      sql`${t.monthlySpendingLimitMicroUsd} is null or ${t.monthlySpendingLimitMicroUsd} >= 0`,
    ),
  ],
);

// How a client is offered AI, set by Trustline's staff, and its own switch.
// No row: AI is not offered. The admin portal writes every column; the
// application reads them and writes the client's switch alone (its grants).
export const aiClientSettings = pgTable(
  'ai_client_settings',
  {
    tenantId: uuid()
      .primaryKey()
      .references(() => tenants.id),
    // Whether Trustline offers the client AI at all.
    offered: boolean().notNull().default(false),
    // Allowances that differ from the plan's: a feature present replaces
    // the plan's (null: no limit), a feature absent leaves it.
    allowanceOverrides: jsonb()
      .$type<Partial<AiAllowances>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    // Whether the medical option may be offered. It still needs the
    // client's signed agreement (ai_agreements, a later step).
    medicalOptionAllowed: boolean().notNull().default(false),
    // The most the client's requests may cost in one of its months. Null:
    // no limit of the client's own (the platform's still applies).
    monthlySpendingLimitMicroUsd: bigint({ mode: 'number' }),
    // The client's own switch: off until it switches AI on.
    clientEnabled: boolean().notNull().default(false),
    clientSwitchedBy: uuid(),
    clientSwitchedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'ai_client_settings_switched_by_fk',
      columns: [t.tenantId, t.clientSwitchedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check(
      'ai_client_settings_spending_limit',
      sql`${t.monthlySpendingLimitMicroUsd} is null or ${t.monthlySpendingLimitMicroUsd} >= 0`,
    ),
    tenantIsolation(),
    pgPolicy('ai_client_settings_platform', {
      as: 'permissive',
      for: 'all',
      to: platformRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

// Which connection and model serve each feature offered to a client. No
// row for a feature: not offered. Written by the admin portal only.
export const aiClientFeatures = pgTable(
  'ai_client_features',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    feature: aiFeature().notNull(),
    connectionId: uuid()
      .notNull()
      .references(() => aiProviderConnections.id),
    // One of the connection's models.
    model: text().notNull(),
    // For quick answers, where the feature asks for one. Null: `model`.
    quickModel: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'ai_client_features_pkey', columns: [t.tenantId, t.feature] }),
    index('ai_client_features_connection_idx').on(t.connectionId),
    tenantIsolation(),
    pgPolicy('ai_client_features_platform', {
      as: 'permissive',
      for: 'all',
      to: platformRole,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
);

// Every AI request of a client: who, which feature, which connection and
// model, its size, its estimated cost and its outcome. Never its text. The
// application adds a row when it admits a request and finishes it when the
// provider answers; it can neither delete one nor change what it was. The
// admin portal reads them, for usage and cost.
export const aiRequests = pgTable(
  'ai_requests',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    feature: aiFeature().notNull(),
    connectionId: uuid()
      .notNull()
      .references(() => aiProviderConnections.id),
    model: text().notNull(),
    // Who asked. Null for what runs without a person (a scheduled check).
    userId: uuid(),
    // The client's month (its time zone) the request falls in: `YYYY-MM`.
    month: text().notNull(),
    // What it is counted under: the draft it belongs to (`unit_key`, the
    // draft's own id, never anything written in it), and whether this
    // request opened one counted unit of the allowance (a draft, a
    // suggestion, an assistant message).
    unitKey: uuid(),
    counted: boolean().notNull(),
    outcome: aiRequestOutcome().notNull(),
    // Why it failed (the kind of provider failure) or was refused
    // (`allowance_reached`, `spending_limit`). Never a provider's message.
    reason: text(),
    attempts: integer().notNull().default(0),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    // In millionths of a US dollar. While pending, the most it can cost.
    costMicroUsd: bigint({ mode: 'number' }).notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    foreignKey({
      name: 'ai_requests_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }),
    index('ai_requests_month_idx').on(t.tenantId, t.month, t.feature),
    index('ai_requests_unit_idx')
      .on(t.tenantId, t.unitKey, t.month)
      .where(sql`${t.unitKey} is not null`),
    index('ai_requests_created_idx').on(t.createdAt),
    check('ai_requests_month', sql`${t.month} ~ '^[0-9]{4}-[0-9]{2}$'`),
    check(
      'ai_requests_sizes',
      sql`${t.inputTokens} >= 0 and ${t.outputTokens} >= 0 and ${t.costMicroUsd} >= 0 and ${t.attempts} between 0 and 2`,
    ),
    tenantIsolation(),
    pgPolicy('ai_requests_platform_read', {
      as: 'permissive',
      for: 'select',
      to: platformRole,
      using: sql`true`,
    }),
  ],
);

export const aiUsageNoticeLevel = pgEnum('ai_usage_notice_level', [
  'warning',
  'reached',
]);

// That a client's administrators were told a feature's allowance is 80%
// used, or all used, in a month: so that each is said once a month.
export const aiUsageNotices = pgTable(
  'ai_usage_notices',
  {
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    month: text().notNull(),
    feature: aiFeature().notNull(),
    level: aiUsageNoticeLevel().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      name: 'ai_usage_notices_pkey',
      columns: [t.tenantId, t.month, t.feature, t.level],
    }),
    tenantIsolation(),
  ],
);

// ---------------------------------------------------------------------------
// AI drafting of policies and procedures (docs/specs/ai-policy-drafting.md).
// The client profile and the document design are the standing context of
// every draft, and useful without AI. A drafting session is the
// conversation behind one draft: the person's request, the assistant's
// questions and the answers, and every version of the draft. All tenant
// data under row-level security.
// ---------------------------------------------------------------------------

/**
 * The client's profile: facts about the organization, never about a
 * person. Every value a client writes is per language (`Localized`); the
 * shape is ProfileInput in drafting/profile-input.ts. Its structure is the
 * organization tree already in Trustline; its languages and numbering are
 * the client's settings and document types.
 */
export type OrganizationProfile = Record<string, unknown>;

export const organizationProfiles = pgTable(
  'organization_profiles',
  {
    tenantId: uuid()
      .primaryKey()
      .references(() => tenants.id),
    profile: jsonb().$type<OrganizationProfile>().notNull(),
    // Bumped by every change: a change made on an out-of-date screen is
    // refused.
    revision: integer().notNull().default(1),
    updatedBy: uuid().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'organization_profiles_updated_by_fk',
      columns: [t.tenantId, t.updatedBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    tenantIsolation(),
  ],
);

/**
 * A client's document design: the template rules, the writing rules and
 * guidance per section. One for the whole organization (no document type),
 * and optionally one per document type. Versioned: every change is a new
 * row and none is changed, so that a draft keeps the design it was written
 * in.
 */
export const documentDesigns = pgTable(
  'document_designs',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    // Null: the organization's design, for every type without its own.
    documentTypeId: uuid(),
    version: integer().notNull(),
    template: jsonb().$type<Record<string, unknown>>().notNull(),
    writing: jsonb().$type<Record<string, unknown>>().notNull(),
    sectionGuidance: jsonb().$type<Record<string, Localized>>().notNull(),
    createdBy: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('document_designs_tenant_id_id_key').on(t.tenantId, t.id),
    uniqueIndex('document_designs_version_key')
      .on(t.tenantId, sql`coalesce(${t.documentTypeId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.version),
    foreignKey({
      name: 'document_designs_type_fk',
      columns: [t.tenantId, t.documentTypeId],
      foreignColumns: [documentTypes.tenantId, documentTypes.id],
    }),
    foreignKey({
      name: 'document_designs_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    check('document_designs_version', sql`${t.version} >= 1`),
    tenantIsolation(),
  ],
);

export const draftingStatus = pgEnum('drafting_status', [
  // The assistant has asked questions, or is about to.
  'asking',
  // It has what it needs: the draft can be written.
  'ready',
  // A draft exists; it can be revised, edited or handed over.
  'drafted',
  // It became a document of the policies module. Kept with it.
  'handed_over',
  // Given up by the person. Removed by the next daily check.
  'discarded',
]);

export const draftingMessageKind = pgEnum('drafting_message_kind', [
  'questions',
  'answers',
  'revision_request',
]);

export const draftingAuthor = pgEnum('drafting_author', ['assistant', 'person']);

/**
 * One drafting conversation: whose it is, for which type of document, in
 * which language, and what was asked in the person's own words. Kept with
 * the document once handed over; otherwise removed 90 days after its last
 * activity, or at the next daily check once discarded
 * (drafting/retention.ts).
 */
export const draftingSessions = pgTable(
  'drafting_sessions',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    createdBy: uuid().notNull(),
    documentTypeId: uuid().notNull(),
    locale: text().notNull(),
    request: text().notNull(),
    status: draftingStatus().notNull().default('asking'),
    // Rounds of questions asked so far.
    rounds: integer().notNull().default(0),
    // The design the draft is written in.
    designId: uuid(),
    documentId: uuid(),
    handedOverVersion: integer(),
    revision: integer().notNull().default(1),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('drafting_sessions_tenant_id_id_key').on(t.tenantId, t.id),
    foreignKey({
      name: 'drafting_sessions_created_by_fk',
      columns: [t.tenantId, t.createdBy],
      foreignColumns: [users.tenantId, users.id],
    }),
    foreignKey({
      name: 'drafting_sessions_type_fk',
      columns: [t.tenantId, t.documentTypeId],
      foreignColumns: [documentTypes.tenantId, documentTypes.id],
    }),
    foreignKey({
      name: 'drafting_sessions_design_fk',
      columns: [t.tenantId, t.designId],
      foreignColumns: [documentDesigns.tenantId, documentDesigns.id],
    }),
    foreignKey({
      name: 'drafting_sessions_document_fk',
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }),
    index('drafting_sessions_owner_idx').on(t.tenantId, t.createdBy, t.status),
    index('drafting_sessions_activity_idx').on(t.lastActivityAt),
    check('drafting_sessions_request', sql`length(${t.request}) between 1 and 4000`),
    check(
      'drafting_sessions_handed_over',
      sql`(${t.status} = 'handed_over') = (${t.documentId} is not null)`,
    ),
    tenantIsolation(),
    // A conversation behind a document is part of its history: never
    // removed, whatever the application asks.
    pgPolicy('drafting_sessions_keep_handed_over', {
      as: 'restrictive',
      for: 'delete',
      to: appRole,
      using: sql`${t.status} <> 'handed_over'`,
    }),
  ],
);

/** A turn of a conversation: questions asked, answers given, a change asked for. */
export const draftingMessages = pgTable(
  'drafting_messages',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    sessionId: uuid().notNull(),
    seq: integer().notNull(),
    kind: draftingMessageKind().notNull(),
    body: jsonb().$type<Record<string, unknown>>().notNull(),
    // The AI request that produced it (ai_requests), for an assistant's turn.
    aiRequestId: uuid(),
    // Who wrote it, for a person's turn.
    createdBy: uuid(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('drafting_messages_seq_key').on(t.tenantId, t.sessionId, t.seq),
    foreignKey({
      name: 'drafting_messages_session_fk',
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [draftingSessions.tenantId, draftingSessions.id],
    }).onDelete('cascade'),
    tenantIsolation(),
  ],
);

/**
 * A version of the draft. Every request for a change, and every edit by
 * hand, is a new version: none is ever overwritten.
 */
export const draftingVersions = pgTable(
  'drafting_versions',
  {
    id: uuid().primaryKey().defaultRandom(),
    tenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    sessionId: uuid().notNull(),
    number: integer().notNull(),
    author: draftingAuthor().notNull(),
    // As a document version's: per language, per section key.
    content: jsonb().$type<DocumentContent>().notNull(),
    // The title the assistant proposes, in the draft's language.
    title: jsonb().$type<Localized>().notNull(),
    // Marked in the text too; listed here for the screens.
    gaps: jsonb().$type<{ section: string; text: string }[]>().notNull(),
    assumptions: jsonb().$type<{ section: string; text: string }[]>().notNull(),
    // The existing documents it drew on.
    sources: jsonb().$type<{ documentId: string; number: string; title: Localized }[]>().notNull(),
    model: text(),
    aiRequestId: uuid(),
    createdBy: uuid().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('drafting_versions_number_key').on(t.tenantId, t.sessionId, t.number),
    foreignKey({
      name: 'drafting_versions_session_fk',
      columns: [t.tenantId, t.sessionId],
      foreignColumns: [draftingSessions.tenantId, draftingSessions.id],
    }).onDelete('cascade'),
    check('drafting_versions_number', sql`${t.number} >= 1`),
    tenantIsolation(),
  ],
);

export const clientDeletionStatus = pgEnum('client_deletion_status', ['requested', 'approved', 'done', 'cancelled']);

/**
 * Deleting a client's data after its contract's retention date
 * (docs/specs/data-export.md, "After the exit window"): asked for by one
 * member of Trustline's staff, approved by another, then carried out from
 * the command line (`platform:delete-client`, as the owner), which writes
 * the signed deletion certificate here. Trustline's own table, not the
 * client's: the platform role reads and writes it, the application never.
 */
export const clientDeletions = pgTable(
  'client_deletions',
  {
    id: uuid().primaryKey().defaultRandom(),
    targetTenantId: uuid()
      .notNull()
      .references(() => tenants.id),
    status: clientDeletionStatus().notNull().default('requested'),
    requestedBy: uuid()
      .notNull()
      .references(() => platformAdmins.id),
    requestedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    reason: text().notNull(),
    // When no export was downloaded: the client's written instruction to
    // delete all the same.
    writtenInstruction: jsonb().$type<WrittenRequest>(),
    approvedBy: uuid().references(() => platformAdmins.id),
    approvedAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    executedAt: timestamp({ withTimezone: true }),
    // The deletion certificate, its fingerprint, and Trustline's signature.
    certificate: jsonb().$type<Record<string, unknown>>(),
    certificateSha256: text(),
    signature: jsonb().$type<{ algorithm: 'Ed25519'; keyId: string; signature: string }>(),
  },
  (t) => [
    uniqueIndex('client_deletions_one_open')
      .on(t.targetTenantId)
      .where(sql`${t.status} in ('requested', 'approved')`),
    check('client_deletions_two_people', sql`${t.approvedBy} is null or ${t.approvedBy} <> ${t.requestedBy}`),
    check('client_deletions_reason', sql`length(${t.reason}) between 1 and 1000`),
  ],
);
