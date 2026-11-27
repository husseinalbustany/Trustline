import { Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  notifications,
  users,
  type NotificationData,
} from '../database/schema.js';
import { AccessService } from '../identity/access.service.js';
import { inChunks, type NotificationKind } from '../incidents/notifier.js';
import { userInAudience } from './visibility.js';

/** What the notifier needs to know of a document. */
export type NotifiedDocument = {
  id: string;
  number: string;
  ownerId: string;
  ownerUnitId: string;
  status: 'draft' | 'active' | 'retired';
  confidentiality: 'all_staff' | 'restricted';
};

export type DocumentNotice = {
  kind: NotificationKind;
  /** Short values only: the version number, a day, a count. Never text. */
  data?: Record<string, string | number | boolean>;
  to: Iterable<string | null>;
  /**
   * What the recipients must be able to open: a version in progress (seen
   * only with full sight, or as an assignee of its run: `assignees`), or
   * the published version.
   */
  about: 'in_progress' | 'published';
  /** For `in_progress`: the assignees of the run, who may see it too. */
  assignees?: string[];
};

/**
 * Writes the notifications of the policies module, and is the one place
 * that does, so that the rules hold for every kind:
 *
 * - Nobody is told of their own action, and nobody twice of one event.
 * - Only active users, and only someone who can open what it is about at
 *   that moment (see visibility.ts): a version in progress only to those
 *   with full sight of the document and to the assignees of its run; a
 *   published version only to its readers.
 * - A notification carries the document's number, and the version or the
 *   day where it matters: never its title or any of its text. The list of
 *   notifications adds the title for those who can still open it.
 *
 * Call it in the transaction that makes the change.
 */
@Injectable()
export class DocumentNotifier {
  constructor(private readonly access: AccessService) {}

  async send(
    tx: Transaction,
    tenantId: string,
    document: NotifiedDocument,
    actorId: string | null,
    notices: DocumentNotice[],
  ) {
    const named = new Set<string>();
    for (const notice of notices) {
      for (const id of notice.to) if (id && id !== actorId) named.add(id);
    }
    if (named.size === 0) return 0;
    const holders = await this.access.holders(
      tx,
      ['policies.manage', 'policies.view_all'],
      [document.ownerUnitId],
    );
    const fullSight = new Set([
      ...holders.of('policies.manage', [document.ownerUnitId]),
      ...holders.of('policies.view_all', [document.ownerUnitId]),
    ]);
    // Written out in full: in a select of one table the query builder
    // leaves a column unqualified, which the subqueries would not resolve.
    const userColumn = sql.raw('"users"."id"');
    const active = new Set<string>();
    const readers = new Set<string>();
    for (const chunk of inChunks([...named])) {
      const found = await tx
        .select({
          id: users.id,
          reads: sql<boolean>`(${sql.raw(String(document.status === 'active'))} and (${userColumn} = ${document.ownerId} or (${userInAudience(sql`${document.id}::uuid`)}) or (${sql.raw(String(document.confidentiality === 'all_staff'))} and exists (
            select from role_assignments ra join roles r on r.id = ra.role_id
            where ra.user_id = ${userColumn}
              and r.permissions && array['policies.view', 'policies.manage', 'policies.view_all']::text[]))))`,
        })
        .from(users)
        .where(and(inArray(users.id, chunk), eq(users.status, 'active')));
      for (const user of found) {
        active.add(user.id);
        if (user.reads) readers.add(user.id);
      }
    }
    const rows: (typeof notifications.$inferInsert)[] = [];
    const told = new Set<string>();
    for (const notice of notices) {
      const assignees = new Set(notice.assignees ?? []);
      for (const userId of notice.to) {
        if (!userId || userId === actorId || told.has(userId)) continue;
        if (!active.has(userId)) continue;
        const mayOpen =
          fullSight.has(userId) ||
          (notice.about === 'published'
            ? readers.has(userId)
            : assignees.has(userId));
        if (!mayOpen) continue;
        told.add(userId);
        rows.push({
          tenantId,
          userId,
          kind: notice.kind,
          documentId: document.id,
          data: {
            ...notice.data,
            number: document.number,
            serious: false,
          } satisfies NotificationData,
        });
      }
    }
    for (const chunk of inChunks(rows)) {
      await tx.insert(notifications).values(chunk);
    }
    return rows.length;
  }

  /**
   * The weekly digest of overdue acknowledgements, to each manager named:
   * about no one document (`document_id` null), with counts only, so it
   * names no document a manager may not see and no person. Active users
   * only. The screen it leads to (`GET /policies/acknowledgements/overdue`)
   * shows each its own.
   */
  async sendDigest(
    tx: Transaction,
    tenantId: string,
    digests: { userId: string; data: Record<string, string | number> }[],
  ) {
    if (digests.length === 0) return 0;
    const active = new Set<string>();
    for (const chunk of inChunks(digests.map((d) => d.userId))) {
      const found = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, chunk), eq(users.status, 'active')));
      for (const u of found) active.add(u.id);
    }
    const rows: (typeof notifications.$inferInsert)[] = digests
      .filter((d) => active.has(d.userId))
      .map((d) => ({
        tenantId,
        userId: d.userId,
        kind: 'acknowledgements_overdue_digest' as const,
        data: { ...d.data, serious: false } satisfies NotificationData,
      }));
    for (const chunk of inChunks(rows)) {
      await tx.insert(notifications).values(chunk);
    }
    return rows.length;
  }
}
