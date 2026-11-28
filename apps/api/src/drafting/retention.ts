import { and, eq, inArray, lt, ne, or } from 'drizzle-orm';
import type { AuditAction } from '../audit/actions.js';
import type { Transaction } from '../database/client.js';
import { auditLog, draftingSessions } from '../database/schema.js';

/**
 * How long a drafting conversation is kept (docs/specs/ai-policy-drafting.md,
 * "Built"):
 *
 * - handed over: with the document, as part of its history, for as long as
 *   the document is kept (documents are never deleted); the database
 *   refuses to remove it (policy `drafting_sessions_keep_handed_over`);
 * - discarded by the person: removed by the next daily check;
 * - not handed over and untouched for ABANDONED_AFTER_DAYS: removed by the
 *   daily check.
 *
 * Its turns and versions go with it. The audit trail keeps that it existed
 * and what was done, never what it said.
 */
export const ABANDONED_AFTER_DAYS = 90;

/**
 * Removes up to `limit` conversations due to go, in the caller's
 * transaction of one client, and audits how many, as the system. Returns
 * how many were removed.
 */
export async function removeOldDrafts(tx: Transaction, tenantId: string, now: Date, limit: number) {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_DAYS * 86_400_000);
  const due = await tx
    .select({ id: draftingSessions.id, status: draftingSessions.status })
    .from(draftingSessions)
    .where(
      and(
        ne(draftingSessions.status, 'handed_over'),
        or(eq(draftingSessions.status, 'discarded'), lt(draftingSessions.lastActivityAt, cutoff)),
      ),
    )
    .limit(limit)
    .for('update', { skipLocked: true });
  if (due.length === 0) return 0;
  await tx.delete(draftingSessions).where(inArray(draftingSessions.id, due.map((d) => d.id)));
  const discarded = due.filter((d) => d.status === 'discarded').length;
  await tx.insert(auditLog).values({
    tenantId,
    actorId: null,
    action: 'ai_drafts_removed_by_system' satisfies AuditAction,
    entityType: 'tenant',
    entityId: tenantId,
    changes: { discarded, abandoned: due.length - discarded },
  });
  return due.length;
}
