import { sql } from 'drizzle-orm';
import {
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

// The role the API connects as. It owns nothing and cannot bypass row-level
// security. migrate.ts creates it before the migrations run.
export const appRole = pgRole('trustline_app').existing();

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

export const tenants = pgTable('tenants', {
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
  plan: tenantPlan().notNull().default('starter'),
  signInMethod: signInMethod().notNull().default('password'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

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
]);

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
    reportedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    // Set by the reporter, corrected at triage.
    harmLevel: incidentHarmLevel().notNull(),
    isSentinel: boolean().notNull().default(false),
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
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('incidents_tenant_id_id_key').on(t.tenantId, t.id),
    unique('incidents_tenant_id_reference_key').on(t.tenantId, t.reference),
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
    // The list is filtered by status and shown newest first.
    index('incidents_status_idx').on(t.tenantId, t.status, t.reportedAt),
    index('incidents_reported_by_idx').on(t.tenantId, t.reportedBy),
    index('incidents_org_unit_idx').on(t.tenantId, t.orgUnitId),
    index('incidents_owner_unit_idx').on(t.tenantId, t.ownerUnitId),
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
    authorId: uuid().notNull(),
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
