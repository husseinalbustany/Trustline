import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  boolean,
  integer,
  jsonb,
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

export const tenantStatus = pgEnum('tenant_status', ['active', 'suspended']);

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
    ssoSubject: text(),
    failedAttempts: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    lastSignInAt: timestamp({ withTimezone: true }),
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
    occurredAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_entity_idx').on(t.tenantId, t.entityType, t.entityId),
    tenantIsolation(),
    // The admin portal adds an entry when it changes what a client may use,
    // in the same transaction as the change. It can neither read this log
    // nor change it: it holds INSERT alone, on the tenant, action, entity
    // and changes only (migration 0035), so the id and the time are always
    // the database's own. And only that entry, as nobody of the client's:
    // it cannot write a backdated or forged entry of anything else.
    pgPolicy('audit_log_platform_insert', {
      as: 'permissive',
      for: 'insert',
      to: platformRole,
      withCheck: sql`actor_id IS NULL AND ip_address IS NULL AND action = 'subscription_changed'`,
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
export type NotificationData = Record<string, string | number | boolean>;

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
    index('notifications_unread_idx')
      .on(t.tenantId, t.userId)
      .where(sql`${t.readAt} is null`),
    // Every notification is about an incident or a document, never both,
    // except the kinds that are about the hospital, or about many
    // documents at once. Compared as text so that the check does not need a
    // new kind to be committed before it is created.
    check(
      'notifications_about_one_thing',
      sql`(${t.incidentId} is null or ${t.documentId} is null) and (${t.incidentId} is not null or ${t.documentId} is not null or ${t.kind}::text in ('public_form_paused', 'acknowledgements_overdue_digest'))`,
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
    status: documentStatus().notNull().default('draft'),
    // How it came into Trustline: `written`, or `imported` with its first
    // version (approved before Trustline). Stays so after it is re-issued.
    source: documentVersionSource().notNull().default('written'),
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
    index('document_reviews_document_idx').on(t.tenantId, t.documentId),
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
      sql`${t.kind} in ('step_overdue', 'publish_failed', 'acknowledgement_digest')`,
    ),
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
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('subscriptions_plan_idx').on(t.planId),
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
