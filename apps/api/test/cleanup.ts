import { inArray, like, or } from 'drizzle-orm';
import { createDatabase } from '../src/database/client.js';
import {
  auditLog,
  incidentCategories,
  incidentComments,
  incidentEvents,
  incidentResponseRules,
  incidents,
  notifications,
  orgUnits,
  platformAdmins,
  platformAuditLog,
  referenceCounters,
  roleAssignments,
  roles,
  sessions,
  tenants,
  users,
  userTokens,
} from '../src/database/schema.js';
import { requireEnv } from '../src/env.js';

/** Removes the clients and platform admins a test run created. */
export async function removeTestData(slugPrefix: string, adminEmail: string) {
  const { db, pool } = createDatabase(requireEnv('DATABASE_URL'));
  try {
    const ids = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(like(tenants.slug, `${slugPrefix}%`));
    const admins = db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(like(platformAdmins.email, adminEmail));
    await db
      .delete(platformAuditLog)
      .where(
        or(
          inArray(platformAuditLog.targetTenantId, ids),
          inArray(platformAuditLog.adminId, admins),
        ),
      );
    // Children before what they point to: notifications, the timeline and
    // comments before incidents, incidents before categories, users and org units.
    for (const table of [
      notifications,
      incidentResponseRules,
      incidentEvents,
      incidentComments,
      incidents,
      incidentCategories,
      referenceCounters,
      auditLog,
      userTokens,
      sessions,
      roleAssignments,
      users,
      roles,
      orgUnits,
    ]) {
      await db.delete(table).where(inArray(table.tenantId, ids));
    }
    await db.delete(tenants).where(like(tenants.slug, `${slugPrefix}%`));
    await db
      .delete(platformAdmins)
      .where(like(platformAdmins.email, adminEmail));
  } finally {
    await pool.end();
  }
}
