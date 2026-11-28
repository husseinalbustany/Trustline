import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  notifications,
  riskCommittees,
  roleAssignments,
  users,
  type NotificationData,
} from '../database/schema.js';
import { MailQueue } from '../email/mail-queue.service.js';
import { AccessService } from '../identity/access.service.js';
import { inChunks, type NotificationKind } from '../incidents/notifier.js';
import type { BandCode } from './defaults.js';
import { rankOf } from './matrix.js';

export type RiskNotice = {
  kind: Extract<
    NotificationKind,
    | 'risk_owner_assigned'
    | 'risk_review_due'
    | 'risk_review_overdue'
    | 'risk_above_tolerance'
    | 'risk_escalated'
    | 'risk_de_escalated'
    | 'risk_step_assigned'
    | 'risk_step_overdue'
    | 'risk_acceptance_decided'
    | 'risk_acceptance_ending'
    | 'risk_acceptance_lapsed'
    | 'risk_closed'
    | 'risk_proposed'
    | 'risk_incident_linked'
    | 'risk_control_document_retired'
  >;
  to: Iterable<string | null>;
  /** Short values only: a band, a day, a committee's id, a flag. Never text. */
  data?: Record<string, string | number | boolean>;
};

/** What the notifier needs of a risk, as it stands after the change. */
export type NotifiedRisk = {
  id: string;
  reference: string;
  currentBand: BandCode | null;
};

/** High or Extreme, as it stands: what every notification says. */
export const isSerious = (band: BandCode | null) =>
  band !== null && rankOf(band) >= rankOf('high');

/**
 * Writes the notifications of the risks module about a risk (`risk_id`),
 * and is the one place that does, so the rules hold for every kind
 * (docs/specs/risk-management.md, "Notifications and email"):
 *
 * - nobody is told of their own action, nobody twice of one event, and
 *   only active people;
 * - only people who read the risk: callers address its owner, the managers
 *   of its unit and the members of the committee it is escalated to, who
 *   read it by their place or their permission;
 * - a notification carries the reference and `serious`, and for some kinds
 *   a band, a day or a committee; never a title, a description or a name.
 *
 * Call it in the transaction that makes the change.
 */
@Injectable()
export class RiskNotifier {
  constructor(
    private readonly access: AccessService,
    private readonly mail: MailQueue,
  ) {}

  /** Those who manage risks of this unit (null: for the whole organization). */
  async managersOf(tx: Transaction, unitId: string | null) {
    const holders = await this.access.holders(tx, ['risks.manage'], [unitId]);
    return [...holders.of('risks.manage', [unitId])];
  }

  /**
   * A committee's members: the active holders of its member or chair role,
   * granted for the whole organization. With no role set yet, those who
   * manage risks for the whole organization (spec, "Escalation").
   */
  async membersOf(tx: Transaction, committeeId: string) {
    const [committee] = await tx
      .select({ memberRoleId: riskCommittees.memberRoleId, chairRoleId: riskCommittees.chairRoleId })
      .from(riskCommittees)
      .where(eq(riskCommittees.id, committeeId));
    if (!committee) return [];
    const roleIds = [committee.memberRoleId, committee.chairRoleId].filter((r): r is string => !!r);
    if (committee.memberRoleId === null) return this.managersOf(tx, null);
    const rows = await tx
      .selectDistinct({ id: users.id })
      .from(roleAssignments)
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(
        and(
          inArray(roleAssignments.roleId, roleIds),
          isNull(roleAssignments.orgUnitId),
          eq(users.status, 'active'),
        ),
      );
    return rows.map((r) => r.id);
  }

  async send(
    tx: Transaction,
    tenantId: string,
    risk: NotifiedRisk,
    actorId: string | null,
    notices: RiskNotice[],
  ) {
    const named = new Set<string>();
    for (const n of notices) for (const id of n.to) if (id && id !== actorId) named.add(id);
    if (named.size === 0) return 0;
    const active = await this.active(tx, [...named]);
    const told = new Set<string>();
    const rows: (typeof notifications.$inferInsert & { id: string })[] = [];
    for (const n of notices) {
      for (const userId of n.to) {
        if (!userId || userId === actorId || told.has(userId) || !active.has(userId)) continue;
        told.add(userId);
        rows.push({
          id: randomUUID(),
          tenantId,
          userId,
          kind: n.kind,
          riskId: risk.id,
          data: {
            ...n.data,
            reference: risk.reference,
            serious: isSerious(risk.currentBand),
          } satisfies NotificationData,
        });
      }
    }
    for (const chunk of inChunks(rows)) await tx.insert(notifications).values(chunk);
    // The emails of the kinds that are emailed. Never fails this.
    await this.mail.enqueue(tx, tenantId, rows);
    return rows.length;
  }

  /**
   * The weekly email to those who manage risks: about no one risk, with
   * counts only, so that it names nothing a manager may not see.
   */
  async sendDigest(
    tx: Transaction,
    tenantId: string,
    digests: { userId: string; data: Record<string, string | number> }[],
  ) {
    if (digests.length === 0) return 0;
    const active = await this.active(tx, digests.map((d) => d.userId));
    const rows = digests
      .filter((d) => active.has(d.userId))
      .map((d) => ({
        id: randomUUID(),
        tenantId,
        userId: d.userId,
        kind: 'risks_overdue_digest' as const,
        data: { ...d.data, serious: false } satisfies NotificationData,
      }));
    for (const chunk of inChunks(rows)) await tx.insert(notifications).values(chunk);
    await this.mail.enqueue(tx, tenantId, rows);
    return rows.length;
  }

  private async active(tx: Transaction, ids: string[]) {
    const active = new Set<string>();
    for (const chunk of inChunks([...new Set(ids)])) {
      const found = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, chunk), eq(users.status, 'active')));
      for (const u of found) active.add(u.id);
    }
    return active;
  }
}
