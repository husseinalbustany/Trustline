import { Injectable, NotFoundException } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ApprovalEngine } from '../approvals/approval-engine.service.js';
import { actions, documents, incidents, notifications, risks, users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import {
  viewerOf,
  visible as documentVisible,
} from '../policies/visibility.js';
import {
  readsAsActionOwner,
  riskViewerOf,
  visible as riskVisible,
} from '../risks/visibility.js';
import { kindsInUse } from './notifier.js';
import { visibleTo } from './visibility.js';

/**
 * A user's own notifications. Every query here is limited to the person
 * signed in: nobody reads, counts or marks another person's, whatever their
 * role, and another person's is answered as if it did not exist.
 */
@Injectable()
export class NotificationsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly engine: ApprovalEngine,
  ) {}

  /**
   * Whose they are: the caller's, and with `unread`, those not yet read. Of
   * the kinds of the modules the client has: the others are kept, and are
   * neither shown, counted nor marked while the module is off.
   */
  private mine(auth: AuthContext, unread = false) {
    const kinds = kindsInUse(auth.tenant.modules);
    return and(
      eq(notifications.userId, auth.user.id),
      kinds.length > 0 ? inArray(notifications.kind, kinds) : sql`false`,
      unread ? isNull(notifications.readAt) : undefined,
    );
  }

  /**
   * Newest first. Each says which incident it is about and whether the
   * caller can still open it: someone taken off an incident, or whose role
   * changed, keeps the notification and is not given the incident. One
   * about the hospital itself (`public_form_paused`) has `incident: null`.
   *
   * One about a controlled document (the policies module) has
   * `document: { id, number, title, canOpen }` instead, and the title only
   * while the caller can open the document (policies/visibility.ts): a
   * notification never tells anyone what a document they cannot see is
   * called.
   */
  list(
    auth: AuthContext,
    input: { unread: boolean; page: number; pageSize: number },
  ) {
    const where = this.mine(auth, input.unread);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [{ total }] = await tx
        .select({ total: count() })
        .from(notifications)
        .where(where);
      // Only asked when documents can be among them.
      const seesDocument = auth.tenant.modules.includes('policies')
        ? documentVisible(await viewerOf(tx, auth, this.engine), this.engine)
        : sql`false`;
      // And risks and their actions (risks/visibility.ts): a risk in full,
      // or its summary for an owner of one of its actions.
      const riskViewer = auth.tenant.modules.includes('risks') ? await riskViewerOf(tx, auth) : null;
      const seesRisk = riskViewer ? riskVisible(riskViewer) : sql`false`;
      const opensRisk = riskViewer ? sql`(${riskVisible(riskViewer)} or ${readsAsActionOwner(riskViewer)})` : sql`false`;
      const seesAction = riskViewer
        ? sql`(${actions.ownerId} = ${auth.user.id} or exists (select from ${risks} where ${risks.id} = ${actions.riskId} and ${riskVisible(riskViewer)}))`
        : sql`false`;
      const rows = await tx
        .select({
          id: notifications.id,
          kind: notifications.kind,
          createdAt: notifications.createdAt,
          readAt: notifications.readAt,
          incidentId: incidents.id,
          reference: incidents.reference,
          canOpen: sql<boolean>`coalesce(${visibleTo(auth)}, false)`,
          documentId: documents.id,
          number: documents.number,
          canOpenDocument: sql<boolean>`(${documents.id} is not null and ${seesDocument})`,
          documentTitle: sql<Record<
            string,
            string
          > | null>`case when ${documents.id} is not null and ${seesDocument} then ${documents.title} end`,
          riskId: risks.id,
          riskReference: risks.reference,
          canOpenRisk: sql<boolean>`(${risks.id} is not null and ${opensRisk})`,
          riskTitle: sql<Record<string, string> | null>`case when ${risks.id} is not null and ${seesRisk} then ${risks.title} end`,
          actionId: actions.id,
          actionReference: actions.reference,
          actionRiskId: actions.riskId,
          canOpenAction: sql<boolean>`(${actions.id} is not null and ${seesAction})`,
          data: notifications.data,
          personId: users.id,
          personName: users.name,
        })
        .from(notifications)
        .leftJoin(incidents, eq(incidents.id, notifications.incidentId))
        .leftJoin(documents, eq(documents.id, notifications.documentId))
        .leftJoin(risks, eq(risks.id, notifications.riskId))
        .leftJoin(actions, eq(actions.id, notifications.actionId))
        // The person one is about (`data.personId`), by their name now.
        .leftJoin(
          users,
          sql`${notifications.data} ? 'personId' and ${users.id} = (${notifications.data} ->> 'personId')::uuid`,
        )
        .where(where)
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      const items = rows.map(
        ({
          incidentId,
          reference,
          canOpen,
          documentId,
          number,
          canOpenDocument,
          documentTitle,
          riskId,
          riskReference,
          canOpenRisk,
          riskTitle,
          actionId,
          actionReference,
          actionRiskId,
          canOpenAction,
          personId,
          personName,
          ...notification
        }) => ({
          id: notification.id,
          kind: notification.kind,
          createdAt: notification.createdAt,
          readAt: notification.readAt,
          incident:
            incidentId === null || reference === null
              ? null
              : { id: incidentId, reference, canOpen },
          document:
            documentId === null || number === null
              ? null
              : {
                  id: documentId,
                  number,
                  title: canOpenDocument ? documentTitle : null,
                  canOpen: canOpenDocument,
                },
          // A risk's title only while the caller reads it in full.
          risk:
            riskId === null || riskReference === null
              ? null
              : { id: riskId, reference: riskReference, title: riskTitle, canOpen: canOpenRisk },
          action:
            actionId === null || actionReference === null
              ? null
              : { id: actionId, reference: actionReference, riskId: actionRiskId, canOpen: canOpenAction },
          person: personId === null ? null : { id: personId, name: personName },
          data: notification.data,
        }),
      );
      return { items, total };
    });
  }

  unread(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [{ unread }] = await tx
        .select({ unread: count() })
        .from(notifications)
        .where(this.mine(auth, true));
      return { unread };
    });
  }

  /**
   * Marks one of the caller's own as read. Read already, it keeps the time
   * it was first read. 404 for one that is not theirs.
   */
  markRead(auth: AuthContext, id: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [marked] = await tx
        .update(notifications)
        .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
        .where(and(eq(notifications.id, id), this.mine(auth)))
        .returning({ id: notifications.id, readAt: notifications.readAt });
      if (!marked) throw new NotFoundException();
      return marked;
    });
  }

  /** Marks all of the caller's own as read, and says how many that was. */
  markAllRead(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const marked = await tx
        .update(notifications)
        .set({ readAt: sql`now()` })
        .where(this.mine(auth, true))
        .returning({ id: notifications.id });
      return { marked: marked.length };
    });
  }
}
