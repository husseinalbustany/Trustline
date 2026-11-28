import { Injectable, Logger } from '@nestjs/common';
import type { Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { emailQueue, type NotificationData } from '../database/schema.js';
import type { NotificationKind } from '../incidents/notifier.js';
import { categoryOf } from './kinds.js';

/** A notification as it is written, as the queue needs it. */
export type WrittenNotification = {
  id: string;
  userId: string;
  kind: NotificationKind;
  data: NotificationData;
};

/** Rows queued in one statement at most: see ROWS_PER_STATEMENT. */
const ROWS_PER_STATEMENT = 1000;

/**
 * Queues the email of a notification that is emailed (kinds.ts), in the
 * transaction that writes the notification, so that an email is queued if
 * and only if its notification is there. Nothing is sent here: the worker
 * sends, outside any request.
 *
 * Whether it is then sent (the person's switches, the organization's, the
 * module, the subscription) is decided when it is sent, not here.
 */
@Injectable()
export class MailQueue {
  private readonly logger = new Logger(MailQueue.name);

  /**
   * Never fails the caller: the rows go in a savepoint, and a failure to
   * queue them rolls back only the savepoint, is logged with the client and
   * the kind of failure, and the action that wrote the notifications goes on.
   * Returns how many were queued.
   */
  async enqueue(
    tx: Transaction,
    tenantId: string,
    written: WrittenNotification[],
  ): Promise<number> {
    const rows = written.flatMap((n) => {
      const category = categoryOf(n.kind, n.data);
      return category
        ? [{ tenantId, userId: n.userId, category, notificationId: n.id }]
        : [];
    });
    if (rows.length === 0) return 0;
    try {
      await tx.transaction(async (savepoint) => {
        for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
          await savepoint
            .insert(emailQueue)
            .values(rows.slice(i, i + ROWS_PER_STATEMENT))
            .onConflictDoNothing();
        }
      });
      return rows.length;
    } catch (error) {
      const code = databaseFailure(error)?.code;
      this.logger.error(
        `Email could not be queued for client ${tenantId}: ${error instanceof Error ? error.name : 'unknown error'}${code ? ` (${code})` : ''}`,
      );
      return 0;
    }
  }
}
