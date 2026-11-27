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

// Replaced by `subscriptions`: nothing reads it any more. Kept, with its
// column, while the admin portal's screens still show and send it; dropped
// in a migration once they no longer do.
export const tenantPlan = pgEnum('tenant_plan', [
  'starter',
  'professional',
  'enterprise',
]);

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
    // Deprecated: see `tenantPlan`. What a client may use is in its
    // subscription.
    plan: tenantPlan().notNull().default('starter'),
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
    // nor change it: it holds INSERT alone.
    pgPolicy('audit_log_platform_insert', {
      as: 'permissive',
      for: 'insert',
      to: platformRole,
      withCheck: sql`true`,
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
    // one of its incidents (`public_form_paused`).
    incidentId: uuid(),
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
    // A user's own, newest first; and the count of those not yet read.
    index('notifications_user_idx').on(t.tenantId, t.userId, t.createdAt),
    index('notifications_unread_idx')
      .on(t.tenantId, t.userId)
      .where(sql`${t.readAt} is null`),
    // Every notification is about an incident, except the one kind that is
    // about the hospital. Compared as text so that the check does not need
    // the new kind to be committed before it is created.
    check(
      'notifications_about_incident',
      sql`${t.incidentId} is not null or ${t.kind}::text = 'public_form_paused'`,
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
