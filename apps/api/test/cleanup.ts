import { eq, inArray, or, sql } from 'drizzle-orm';
import { createDatabase } from '../src/database/client.js';
import {
  approvalRoutes,
  approvalRouteSteps,
  approvalRuns,
  approvalRunSteps,
  auditChain,
  auditChainCheckpoints,
  auditChainHeads,
  auditChainVerifications,
  auditLog,
  documentAcknowledgements,
  documentReviewApprovals,
  documentAudiences,
  documentCategories,
  documentImportBatches,
  documentImports,
  documentReviewRounds,
  documentReviews,
  documents,
  documentSettings,
  documentTypes,
  documentVersions,
  emailOutbox,
  emailPreferences,
  emailQueue,
  emailSettings,
  moduleStarts,
  policyImportWindows,
  incidentCategories,
  incidentComments,
  incidentEvents,
  incidentResponseRules,
  incidents,
  notifications,
  orgUnits,
  plans,
  platformAdmins,
  platformAuditLog,
  policyReminders,
  referenceCounters,
  roleAssignments,
  roles,
  sessions,
  signatures,
  subscriptions,
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
 * - plans whose code starts with it, the same way;
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
    // In one transaction: another test file, which may be reading every
    // client at that moment, never sees one half removed (a client with
    // no subscription, say).
    await db.transaction(async (tx) => {
      const ids = tx.select({ id: tenants.id }).from(tenants).where(ours);
      const admins = tx
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(eq(platformAdmins.email, adminEmail));
      await tx
        .delete(platformAuditLog)
        .where(
          or(
            inArray(platformAuditLog.targetTenantId, ids),
            inArray(platformAuditLog.adminId, admins),
          ),
        );
      // A document and its published version point at each other.
      await tx
        .update(documents)
        .set({ publishedVersionId: null, status: 'draft' })
        .where(inArray(documents.tenantId, ids));
      // Children before what they point to: the email outbox before its
      // queue, the queue and preferences before notifications and users;
      // notifications, the timeline and
      // comments before incidents, incidents before categories, users and org
      // units; acknowledgements, reviews and run steps before signatures,
      // runs before routes, versions before documents before their types;
      // imports before their batches, signatures and versions.
      for (const table of [
        subscriptions,
        emailOutbox,
        emailQueue,
        emailPreferences,
        emailSettings,
        moduleStarts,
        policyImportWindows,
        notifications,
        policyReminders,
        documentSettings,
        documentAcknowledgements,
        documentReviewApprovals,
        documentReviews,
        documentReviewRounds,
        documentImports,
        documentImportBatches,
        approvalRunSteps,
        approvalRuns,
        signatures,
        approvalRouteSteps,
        approvalRoutes,
        documentAudiences,
        documentVersions,
        documents,
        documentTypes,
        documentCategories,
        incidentResponseRules,
        incidentEvents,
        incidentComments,
        incidents,
        incidentCategories,
        referenceCounters,
        // A whole test client's audit trail, its chain with it. Never the
        // entries of a client that is kept: its chain would break
        // (docs/specs/audit-trail.md, "Tests").
        auditChainVerifications,
        auditChainCheckpoints,
        auditChain,
        auditChainHeads,
        auditLog,
        userTokens,
        sessions,
        roleAssignments,
        users,
        roles,
        orgUnits,
      ]) {
        await tx.delete(table).where(inArray(table.tenantId, ids));
      }
      await tx.delete(tenants).where(ours);
      await tx
        .delete(plans)
        .where(sql`starts_with(${plans.code}, ${slugPrefix})`);
      await tx.delete(platformAdmins).where(eq(platformAdmins.email, adminEmail));
    });
  } finally {
    await pool.end();
  }
}
