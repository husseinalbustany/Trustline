import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { eq, inArray, or, sql } from 'drizzle-orm';
import { createDatabase } from '../src/database/client.js';
import {
  aiClientFeatures,
  aiClientSettings,
  aiPlatformSettings,
  aiProviderConnections,
  aiRequests,
  aiUsageNotices,
  actionEvents,
  actionNotes,
  actionReminders,
  actions,
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
  documentDesigns,
  draftingMessages,
  draftingSessions,
  draftingVersions,
  organizationProfiles,
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
  measureSnapshots,
  dataExports,
  notifications,
  orgUnits,
  plans,
  platformAdmins,
  clientDeletions,
  exportSecondApprovals,
  platformAuditLog,
  platformSessions,
  policyReminders,
  referenceCounters,
  reportSettings,
  riskAcceptances,
  riskBands,
  riskIncidentLinks,
  riskNotes,
  riskReminders,
  riskReviews,
  riskCategories,
  riskCommittees,
  riskControls,
  riskEvents,
  riskImpactDomains,
  riskMatrices,
  riskMatrixCells,
  riskMatrixLevels,
  riskRatings,
  risks,
  riskSettings,
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
import { isAuditAction, storedKeysOf } from '../src/audit/actions.js';

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
 * - AI provider connections whose name starts with it, the same way;
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
  // Every action and detail key the run's clients were written, against
  // the registry (src/audit/actions.ts): what the code writes through a
  // variable is checked here, where it was written for real.
  let unregistered: string[] = [];
  let checkFailed: unknown = null;
  let removedIds: string[] = [];
  try {
    const { rows } = await db.execute<{ action: string; key: string | null }>(sql`
      select distinct a.action, k as key
      from audit_log a
      join ${tenants} on ${tenants.id} = a.tenant_id
      left join lateral jsonb_object_keys(
        case when jsonb_typeof(a.changes) = 'object' then a.changes else '{}'::jsonb end) k on true
      where ${ours}`);
    unregistered = rows
      .filter((r) =>
        !isAuditAction(r.action) ||
        (r.key !== null && !storedKeysOf(r.action).includes(r.key)))
      .map((r) => (r.key === null ? r.action : `${r.action}.${r.key}`));
  } catch (error) {
    // The check only reads; the clean-up below goes on regardless, and the
    // failure is thrown after it (security review 14, L4).
    checkFailed = error;
  }
  try {
    // In one transaction: another test file, which may be reading every
    // client at that moment, never sees one half removed (a client with
    // no subscription, say).
    removedIds = (await db.select({ id: tenants.id }).from(tenants).where(ours)).map((r) => r.id);
    await db.transaction(async (tx) => {
      const ids = tx.select({ id: tenants.id }).from(tenants).where(ours);
      const admins = tx
        .select({ id: platformAdmins.id })
        .from(platformAdmins)
        .where(or(eq(platformAdmins.email, adminEmail), eq(platformAdmins.email, `second-${adminEmail}`)));
      // Deletions asked for, of the run's clients.
      await tx.delete(clientDeletions).where(inArray(clientDeletions.targetTenantId, ids));
      await tx.delete(exportSecondApprovals).where(inArray(exportSecondApprovals.targetTenantId, ids));
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
      // A risk and its acceptance in force point at each other too.
      await tx.update(risks).set({ acceptanceId: null }).where(inArray(risks.tenantId, ids));
      // Children before what they point to: the email outbox before its
      // queue, the queue and preferences before notifications and users;
      // notifications, the timeline and
      // comments before incidents, incidents before categories, users and org
      // units; acknowledgements, reviews and run steps before signatures,
      // runs before routes, versions before documents before their types;
      // imports before their batches, signatures and versions.
      // Trustline's own AI setting keeps no trace of the run's member of
      // staff, who is removed below.
      await tx
        .update(aiPlatformSettings)
        .set({ updatedBy: null })
        .where(inArray(aiPlatformSettings.updatedBy, admins));
      for (const table of [
        aiRequests,
        aiUsageNotices,
        aiClientFeatures,
        aiClientSettings,
        // A drafting conversation points at its document, type, design and
        // author; its turns and versions at it.
        draftingMessages,
        draftingVersions,
        draftingSessions,
        documentDesigns,
        organizationProfiles,
        subscriptions,
        emailOutbox,
        emailQueue,
        emailPreferences,
        emailSettings,
        moduleStarts,
        policyImportWindows,
        notifications,
        policyReminders,
        // The risks module and the actions engine, after the notifications
        // that point at them: what points at an action or a risk before
        // it, ratings before reviews, risks before their categories,
        // committees and matrix cells, cells before bands, bands before
        // committees; all before documents, users, roles and units.
        actionReminders,
        actionEvents,
        actionNotes,
        actions,
        riskReminders,
        riskNotes,
        riskIncidentLinks,
        riskAcceptances,
        riskEvents,
        riskControls,
        riskRatings,
        riskReviews,
        risks,
        riskSettings,
        riskMatrixCells,
        riskBands,
        riskImpactDomains,
        riskMatrixLevels,
        riskMatrices,
        riskCategories,
        riskCommittees,
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
        // A whole test client's figures, before its units.
        measureSnapshots,
        reportSettings,
        dataExports,
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
      await tx
        .delete(aiProviderConnections)
        .where(sql`starts_with(${aiProviderConnections.name}, ${slugPrefix})`);
      await tx.delete(platformSessions).where(inArray(platformSessions.adminId, admins));
      await tx
        .delete(platformAdmins)
        .where(or(eq(platformAdmins.email, adminEmail), eq(platformAdmins.email, `second-${adminEmail}`)));
    });
  } finally {
    await pool.end();
  }
  // The run's clients' export archives, encrypted, and their working files
  // (security review 19, L9): where ExportStorage keeps them.
  const root = resolve(process.env.EXPORT_STORAGE_DIR?.trim() || join(tmpdir(), 'trustline-exports'));
  for (const id of removedIds) {
    await rm(join(root, id), { recursive: true, force: true });
    await rm(join(root, 'work', id), { recursive: true, force: true });
  }
  if (checkFailed) throw checkFailed;
  if (unregistered.length > 0) {
    throw new Error(`Audit entries not in the registry (src/audit/actions.ts): ${[...new Set(unregistered)].sort().join(', ')}`);
  }
}
