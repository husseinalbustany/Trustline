import { eq, inArray, or, sql } from 'drizzle-orm';
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

/** A tag, a hyphen and a run's random part are longer than this. */
const MIN_PREFIX = 8;

/**
 * Removes the clients and the platform admin a test run created, and nothing
 * else. The database is shared with hospitals this run did not make (the
 * demo hospitals, and whatever someone working next to the suite has made),
 * so what is removed is named exactly:
 *
 * - clients whose identifier starts with `slugPrefix`, letter for letter
 *   (never a pattern: an `_` or `%` in it stands for itself);
 * - the one platform admin with exactly this email.
 *
 * A prefix too short to be a run's own is refused: an empty one would name
 * every hospital there is.
 */
export async function removeTestData(slugPrefix: string, adminEmail: string) {
  if (slugPrefix.length < MIN_PREFIX) {
    throw new Error(
      `removeTestData: "${slugPrefix}" is too short to be one run's own prefix`,
    );
  }
  const { db, pool } = createDatabase(requireEnv('DATABASE_URL'));
  const ours = sql`starts_with(${tenants.slug}, ${slugPrefix})`;
  try {
    const ids = db.select({ id: tenants.id }).from(tenants).where(ours);
    const admins = db
      .select({ id: platformAdmins.id })
      .from(platformAdmins)
      .where(eq(platformAdmins.email, adminEmail));
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
    await db.delete(tenants).where(ours);
    await db.delete(platformAdmins).where(eq(platformAdmins.email, adminEmail));
  } finally {
    await pool.end();
  }
}
