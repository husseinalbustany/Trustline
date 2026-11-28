import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Transaction } from '../database/client.js';
import { notifications } from '../database/schema.js';
import { MailQueue } from '../email/mail-queue.service.js';

export type SigningPinNotice =
  | { kind: 'signing_pin_changed'; action: 'set' | 'changed' | 'reset' }
  | { kind: 'signing_pin_locked' };

/**
 * Security notices to a person about their own signing PIN (business
 * decision 9, security review 11): in the app, and by an email they cannot
 * switch off (email/kinds.ts), so that a change they did not make, or a
 * lock after wrong PINs, is seen even if someone else holds their session
 * and marks the notice read. Never the PIN. In the caller's transaction.
 */
@Injectable()
export class SecurityNotices {
  constructor(private readonly mail: MailQueue) {}

  async tell(tx: Transaction, tenantId: string, userId: string, notice: SigningPinNotice) {
    const row = {
      id: randomUUID(),
      tenantId,
      userId,
      kind: notice.kind,
      data: {
        ...(notice.kind === 'signing_pin_changed' && { action: notice.action }),
        serious: false,
      },
    };
    await tx.insert(notifications).values(row);
    await this.mail.enqueue(tx, tenantId, [row]);
  }
}
