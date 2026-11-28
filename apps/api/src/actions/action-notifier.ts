import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  notifications,
  users,
  type NotificationData,
} from '../database/schema.js';
import { MailQueue } from '../email/mail-queue.service.js';
import { inChunks, type NotificationKind } from '../incidents/notifier.js';

export type ActionNotice = {
  kind: Extract<
    NotificationKind,
    'action_assigned' | 'action_due_soon' | 'action_overdue' | 'action_escalated' | 'action_completed'
  >;
  to: Iterable<string | null>;
  /** Short values only: a day. Never a title or a name. */
  data?: Record<string, string | number | boolean>;
};

/**
 * Writes the notifications of the actions engine (docs/specs/actions.md),
 * about one action (`action_id`): to active people only, never to whoever
 * made the change, each once. Every recipient may read the action: its
 * owner, the source's owner and the source's managers, as the engine
 * addresses them. A notification carries the action's and the source's
 * references and whether the source is serious; never a title or a name.
 * Call it in the transaction that makes the change.
 */
@Injectable()
export class ActionNotifier {
  constructor(private readonly mail: MailQueue) {}

  async send(
    tx: Transaction,
    tenantId: string,
    action: { id: string; reference: string },
    source: { reference: string; serious: boolean },
    actorId: string | null,
    notices: ActionNotice[],
  ) {
    const named = new Set<string>();
    for (const n of notices) for (const id of n.to) if (id && id !== actorId) named.add(id);
    if (named.size === 0) return 0;
    const active = new Set<string>();
    for (const chunk of inChunks([...named])) {
      const found = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, chunk), eq(users.status, 'active')));
      for (const u of found) active.add(u.id);
    }
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
          actionId: action.id,
          data: {
            ...n.data,
            reference: action.reference,
            sourceReference: source.reference,
            serious: source.serious,
          } satisfies NotificationData,
        });
      }
    }
    for (const chunk of inChunks(rows)) await tx.insert(notifications).values(chunk);
    await this.mail.enqueue(tx, tenantId, rows);
    return rows.length;
  }
}
