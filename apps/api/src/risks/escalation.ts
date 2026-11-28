import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { riskCommittees, risks } from '../database/schema.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { addEvent, type Standing } from './common.js';
import type { BandCode } from './defaults.js';
import { bandOf, rankOf, type Matrix } from './matrix.js';
import { RiskNotifier } from './risk-notifier.js';

type Committee = { id: string; position: number; active: boolean };

/** A risk as escalation needs it, as it stands before the change. */
export type EscalatedRisk = {
  id: string;
  reference: string;
  orgUnitId: string | null;
  ownerId: string;
  status: string;
  escalatedToCommitteeId: string | null;
};

/**
 * Escalation to committees (docs/specs/risk-management.md, "Escalation";
 * business decision 10), and the notice of a risk newly above tolerance:
 *
 * - **Automatic:** when a current rating puts a risk on the register in a
 *   band that has a committee, the risk is escalated to it in the same
 *   transaction, unless it is already escalated to that committee or a
 *   higher one (a higher `position`) still in use. The timeline and the trail say it was
 *   automatic; the committee and the owner are told at once (emailed when
 *   Extreme).
 * - **By hand:** a manager escalates to any committee, with a reason.
 * - **Coming down** is never automatic: a member of the committee, or a
 *   manager for the whole organization, takes the risk off its list, once
 *   its band is below the committee's threshold (409
 *   `still_above_threshold`). The threshold is the lowest band of the
 *   matrix in use that escalates to that committee or a higher one.
 */
@Injectable()
export class RiskEscalation {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly notifier: RiskNotifier,
  ) {}

  async committees(tx: Transaction) {
    const rows = await tx
      .select({ id: riskCommittees.id, position: riskCommittees.position, active: riskCommittees.active })
      .from(riskCommittees);
    return new Map<string, Committee>(rows.map((c) => [c.id, c]));
  }

  /** The lowest band (its rank) that keeps a risk on this committee's list, or null. */
  thresholdRank(matrix: Matrix, committees: Map<string, Committee>, committeeId: string) {
    const committee = committees.get(committeeId);
    if (!committee) return null;
    const ranks = matrix.bands
      .filter((b) => {
        const to = b.escalateToCommitteeId ? committees.get(b.escalateToCommitteeId) : undefined;
        return !!to && to.position >= committee.position;
      })
      .map((b) => rankOf(b.code));
    return ranks.length > 0 ? Math.min(...ranks) : null;
  }

  /** Puts a risk before a committee, by hand or automatically. */
  async escalate(
    tx: Transaction,
    actor: { tenantId: string; actorId: string | null },
    risk: EscalatedRisk,
    committeeId: string,
    how: { automatic: boolean; band: BandCode | null; noteId?: string },
  ) {
    await tx
      .update(risks)
      .set({
        escalatedToCommitteeId: committeeId,
        escalatedAt: new Date(),
        revision: sql`${risks.revision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(risks.id, risk.id));
    const details = {
      committeeId,
      from: risk.escalatedToCommitteeId,
      automatic: how.automatic,
      band: how.band,
      // The reason is a note on the risk, named by its id (security review 17, L5).
      ...(how.noteId ? { noteId: how.noteId } : {}),
    };
    await addEvent(tx, actor, risk.id, 'escalated', details);
    await this.provisioning.audit(tx, actor.tenantId, actor.actorId, 'risk_escalated', 'risk', risk.id, details);
    const members = await this.notifier.membersOf(tx, committeeId);
    await this.notifier.send(tx, actor.tenantId, { id: risk.id, reference: risk.reference, currentBand: how.band }, actor.actorId, [
      {
        kind: 'risk_escalated',
        to: [...members, risk.ownerId],
        data: { committeeId, automatic: how.automatic, ...(how.band ? { band: how.band } : {}) },
      },
    ]);
  }

  /**
   * What follows a current rating of a risk on the register, in its
   * transaction: the automatic escalation its band calls for, and the
   * notice that it is newly above tolerance with nothing addressing it.
   * Returns whether it was escalated.
   */
  async afterCurrentRating(
    tx: Transaction,
    actor: { tenantId: string; actorId: string | null },
    risk: EscalatedRisk,
    standing: { before: Standing | null; after: Standing | null },
    band: BandCode,
    matrix: Matrix,
  ) {
    if (risk.status !== 'open') return false;
    if (standing.after === 'above_not_addressed' && standing.before !== 'above_not_addressed') {
      const managers = await this.notifier.managersOf(tx, risk.orgUnitId);
      await this.notifier.send(tx, actor.tenantId, { id: risk.id, reference: risk.reference, currentBand: band }, actor.actorId, [
        { kind: 'risk_above_tolerance', to: [risk.ownerId, ...managers], data: { band } },
      ]);
    }
    const target = bandOf(matrix, band).escalateToCommitteeId;
    if (!target) return false;
    const committees = await this.committees(tx);
    const committee = committees.get(target);
    if (!committee?.active) return false;
    if (risk.escalatedToCommitteeId) {
      if (risk.escalatedToCommitteeId === target) return false;
      // A committee switched off no longer holds a risk (security review 17, L3).
      const now = committees.get(risk.escalatedToCommitteeId);
      if (now?.active && now.position >= committee.position) return false;
    }
    await this.escalate(tx, actor, risk, target, { automatic: true, band });
    return true;
  }
}
