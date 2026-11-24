import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

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
  nameEn: text().notNull(),
  nameAr: text().notNull(),
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
    nameEn: text().notNull(),
    nameAr: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
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
