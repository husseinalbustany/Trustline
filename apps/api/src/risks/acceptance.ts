import { ConflictException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { riskAcceptances, risks } from '../database/schema.js';
import type { ProvisioningService } from '../identity/provisioning.service.js';
import { addEvent } from './common.js';
import type { BandCode } from './defaults.js';
import type { RiskNotifier } from './risk-notifier.js';

/**
 * A risk's acceptances above tolerance (docs/specs/risk-management.md,
 * "Acceptance above tolerance"), as the register, the reviews and the risk
 * check need them: the one in approval, the one in force, and how one
 * lapses. The routes that ask for, sign and withdraw them are
 * `approvals.service.ts`.
 */

export const acceptanceColumns = {
  id: riskAcceptances.id,
  riskId: riskAcceptances.riskId,
  requestedBy: riskAcceptances.requestedBy,
  requestedAt: riskAcceptances.requestedAt,
  rationale: riskAcceptances.rationale,
  conditions: riskAcceptances.conditions,
  untilOn: riskAcceptances.untilOn,
  ratingId: riskAcceptances.ratingId,
  score: riskAcceptances.score,
  bandCode: riskAcceptances.bandCode,
  toleranceBand: riskAcceptances.toleranceBand,
  categoryId: riskAcceptances.categoryId,
  status: riskAcceptances.status,
  approvalRunId: riskAcceptances.approvalRunId,
  decidedAt: riskAcceptances.decidedAt,
  lapsedReason: riskAcceptances.lapsedReason,
  lapsedAt: riskAcceptances.lapsedAt,
};

export type AcceptanceRow = Pick<typeof riskAcceptances.$inferSelect, keyof typeof acceptanceColumns>;

/** The acceptance of a risk in approval, or in force, if any. */
export async function openAcceptance(tx: Transaction, riskId: string, lock = false) {
  const query = tx
    .select(acceptanceColumns)
    .from(riskAcceptances)
    .where(and(eq(riskAcceptances.riskId, riskId), inArray(riskAcceptances.status, ['in_approval', 'accepted'])));
  const [row] = lock ? await query.for('update') : await query;
  return row ?? null;
}

/**
 * Refuses a change to what an acceptance in approval was asked on (409
 * `acceptance_in_progress`: withdraw it first), and any change while a
 * closure waits for its signature (409 `closure_in_progress`). The database
 * keeps the first too: see migration 0075.
 */
export async function assertNotInApproval(
  tx: Transaction,
  risk: { id: string; closureRequestedAt: Date | null },
  { acceptance = true, closure = true } = {},
) {
  if (closure && risk.closureRequestedAt) throw new ConflictException({ code: 'closure_in_progress' });
  if (!acceptance) return;
  const open = await openAcceptance(tx, risk.id);
  if (open?.status === 'in_approval') throw new ConflictException({ code: 'acceptance_in_progress' });
}

export type LapseReason = 'last_day' | 'score_risen' | 'category_changed';

/**
 * Ends an acceptance in force (status `lapsed`), in the transaction that
 * causes it or by the risk check: on its last day, when the current score
 * rises above the score it accepted, or when the risk's category changes.
 * Written by the system; the owner and the managers of the risk's unit are
 * told. Returns how many notifications were written.
 */
export async function lapse(
  tx: Transaction,
  deps: { provisioning: ProvisioningService; notifier: RiskNotifier },
  tenantId: string,
  acceptance: Pick<AcceptanceRow, 'id' | 'riskId' | 'score'>,
  risk: { id: string; reference: string; orgUnitId: string | null; ownerId: string; currentBand: BandCode | null },
  reason: LapseReason,
) {
  const now = new Date();
  await tx
    .update(riskAcceptances)
    .set({ status: 'lapsed', lapsedReason: reason, lapsedAt: now })
    .where(eq(riskAcceptances.id, acceptance.id));
  await tx
    .update(risks)
    .set({ acceptanceId: null, revision: sql`${risks.revision} + 1`, updatedAt: now })
    .where(eq(risks.id, risk.id));
  const details = { acceptanceId: acceptance.id, reason, score: acceptance.score };
  await addEvent(tx, { tenantId, actorId: null }, risk.id, 'acceptance_lapsed', details);
  await deps.provisioning.audit(tx, tenantId, null, 'risk_acceptance_lapsed', 'risk', risk.id, details);
  const managers = await deps.notifier.managersOf(tx, risk.orgUnitId);
  return deps.notifier.send(tx, tenantId, risk, null, [
    { kind: 'risk_acceptance_lapsed', to: [risk.ownerId, ...managers], data: { reason } },
  ]);
}
