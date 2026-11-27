import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import {
  documentAcknowledgements,
  documents,
  documentVersions,
  tenants,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { dayOf, shiftDay } from '../i18n/time-zones.js';
import { EntitlementsService } from '../subscriptions/entitlements.service.js';
import { DocumentNotifier, type NotifiedDocument } from './document-notifier.js';
import { Publisher } from './publisher.js';

/**
 * Every fifteen minutes. The check is about days, but a day starts at a
 * different moment for each client: this publishes what is scheduled, and
 * sends what has come due, within a quarter of an hour of midnight there.
 * Each thing is done once however often it runs.
 */
export const POLICY_CHECK_EVERY_MS = 15 * 60_000;
/** Documents, versions or acknowledgements handled in one transaction. */
const BATCH = 100;
/** How long any one statement may take: see CHECK_STATEMENT_TIMEOUT_MS. */
export const POLICY_CHECK_STATEMENT_TIMEOUT_MS = 30_000;

/** Review reminders: how many days before, and their order. */
export const REVIEW_NOTICES = [
  { rank: 1, days: 60 },
  { rank: 2, days: 30 },
  { rank: 3, days: 7 },
] as const;
/** The rank of "overdue", after the three above. */
const OVERDUE_RANK = 4;

const ERROR_CODE = /^(?:[0-9A-Z]{5}|E[A-Z_]{2,30})$/;

/** The kind of a failure, never its message: see deadline-check.service.ts. */
const kindOf = (error: unknown) => {
  if (!(error instanceof Error)) return 'unknown error';
  const name = error.name === 'Error' ? error.constructor.name : error.name;
  const own = (error as { code?: unknown }).code;
  const code =
    databaseFailure(error)?.code ??
    (typeof own === 'string' && ERROR_CODE.test(own) ? own : null);
  return code ? `${name} (${code})` : name;
};

export type PolicyCheckResult = {
  listed: boolean;
  clients: number;
  failed: number;
  /** Versions published on their scheduled day. */
  published: number;
  /** People asked to acknowledge because they joined an audience. */
  assigned: number;
  notified: number;
};

type Client = { id: string; timeZone: string };

/**
 * The daily check of the policies module, beside the incident deadline
 * check and built the same way:
 *
 * - **Scheduled publishing:** an approved version whose effective day has
 *   come, on the client's calendar, is published (`Publisher`).
 * - **Review reminders:** the owner of an active document is told 60, 30
 *   and 7 days before its next review, and when it has passed; managers of
 *   the document are told too when it has passed. Each once per review
 *   date: the document records the last one sent, and for which date.
 * - **Acknowledgements:** whoever has joined the audience of a published
 *   version that asks for acknowledgement since it was published is asked
 *   and told; whoever has not acknowledged is reminded at half the time
 *   allowed, and when it has passed, each once.
 *
 * **Once, with any number of API processes.** Each thing is claimed by
 * locking its row and marking it in the transaction that writes the
 * notifications; rows another process holds are passed over, and found
 * marked a moment later. Asking someone to acknowledge is one insert that
 * adds each person once, whoever runs it.
 *
 * **Every client with the module, one at a time,** in short transactions of
 * its own under `TenantDb.withTenant`, none of whose statements may take
 * longer than 30 seconds. A client without the module, suspended by
 * Trustline or with its subscription cancelled is left alone; what came due
 * meanwhile is done, once, when it is back. A client whose check fails is
 * named in the log with the kind of failure, and tried again next run.
 *
 * Started by `main.ts` only; tests call `run()` with a moment and the
 * clients they made.
 */
@Injectable()
export class PolicyCheck implements OnModuleDestroy {
  private readonly logger = new Logger(PolicyCheck.name);
  private timer?: NodeJS.Timeout;
  private current?: Promise<unknown>;
  private stopped = true;
  statementTimeoutMs = POLICY_CHECK_STATEMENT_TIMEOUT_MS;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly entitlements: EntitlementsService,
    private readonly publisher: Publisher,
    private readonly notifier: DocumentNotifier,
  ) {}

  start(everyMs = POLICY_CHECK_EVERY_MS, only?: string[]) {
    if (!this.stopped) return;
    this.stopped = false;
    const next = (delay: number) => {
      this.timer = setTimeout(() => {
        this.current = this.run(new Date(), only)
          .catch((error: unknown) => {
            this.logger.error(`Policy check failed: ${kindOf(error)}`);
          })
          .finally(() => {
            this.current = undefined;
            if (!this.stopped) next(everyMs);
          });
      }, delay);
    };
    next(Math.min(everyMs, 1_000));
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.current;
  }

  async onModuleDestroy() {
    await this.stop();
  }

  get active() {
    return this.timer !== undefined || this.current !== undefined;
  }

  private get stopping() {
    return this.stopped && this.current !== undefined;
  }

  /**
   * One pass over every active client, as of `now`. `only` narrows it to
   * these clients: for tests, which share the database with clients they
   * did not make.
   */
  async run(now = new Date(), only?: string[]): Promise<PolicyCheckResult> {
    const result: PolicyCheckResult = {
      listed: false,
      clients: 0,
      failed: 0,
      published: 0,
      assigned: 0,
      notified: 0,
    };
    let clients: Client[];
    try {
      clients = await this.db.transaction(async (tx) => {
        await this.limitStatements(tx);
        return tx
          .select({ id: tenants.id, timeZone: tenants.timeZone })
          .from(tenants)
          .where(
            and(
              eq(tenants.status, 'active'),
              only ? inArray(tenants.id, only) : undefined,
            ),
          )
          .orderBy(asc(tenants.id));
      });
    } catch (error) {
      this.logger.error(
        `Policy check failed before any client was checked: ${kindOf(error)}`,
      );
      return result;
    }
    result.listed = true;
    result.clients = clients.length;
    for (const client of clients) {
      if (this.stopping) break;
      try {
        const done = await this.checkClient(client, now);
        result.published += done.published;
        result.assigned += done.assigned;
        result.notified += done.notified;
      } catch (error) {
        result.failed += 1;
        if (this.stopping) break;
        this.logger.error(
          `Policy check failed for client ${client.id}: ${kindOf(error)}`,
        );
      }
    }
    if (
      result.published + result.assigned + result.notified + result.failed >
      0
    ) {
      const summary = `Policy check: ${result.published} versions published, ${result.assigned} acknowledgements asked, ${result.notified} notifications written, ${result.failed} of ${result.clients} clients failed`;
      if (result.failed > 0) this.logger.warn(summary);
      else this.logger.log(summary);
    }
    return result;
  }

  private inClient<T>(tenantId: string, fn: (tx: Transaction) => Promise<T>) {
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      await this.limitStatements(tx);
      return fn(tx);
    });
  }

  private async limitStatements(tx: Transaction) {
    await tx.execute(
      sql`select set_config('statement_timeout', ${String(this.statementTimeoutMs)}, true)`,
    );
  }

  /** Everything due in one client as of `now`. */
  async checkClient(client: Client, now: Date) {
    const done = { published: 0, assigned: 0, notified: 0 };
    const inUse = await this.inClient(client.id, (tx) =>
      this.entitlements.mayUse(tx, client.id, 'policies'),
    );
    if (!inUse) return done;
    const today = dayOf(now, client.timeZone);
    const steps: (() => Promise<{
      claimed: number;
      published?: number;
      assigned?: number;
      notified: number;
    }>)[] = [
      () => this.publishScheduled(client.id, today, now),
      () => this.remindReviews(client.id, today),
      () => this.remindAcknowledgements(client.id, today, now),
    ];
    for (const step of steps) {
      for (let claimed = BATCH; claimed >= BATCH; ) {
        if (this.stopping) return done;
        const result = await step();
        claimed = result.claimed;
        done.published += result.published ?? 0;
        done.notified += result.notified;
      }
    }
    // Last, so that those just asked by a publication are not asked again.
    const joined = await this.askJoiners(client.id, today, now);
    done.assigned += joined.assigned;
    done.notified += joined.notified;
    return done;
  }

  /**
   * Publishes up to BATCH approved versions whose day has come. Each
   * document is locked before its version, as the routes do, and one
   * another process holds is passed over.
   */
  private publishScheduled(tenantId: string, today: string, now: Date) {
    return this.inClient(tenantId, async (tx) => {
      const due = await tx
        .select({ id: documentVersions.id, documentId: documentVersions.documentId })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.status, 'approved'),
            sql`${documentVersions.effectiveOn} <= ${today}`,
          ),
        )
        .orderBy(asc(documentVersions.effectiveOn), asc(documentVersions.id))
        .limit(BATCH);
      let published = 0;
      let notified = 0;
      for (const candidate of due) {
        const [doc] = await tx
          .select({
            id: documents.id,
            number: documents.number,
            ownerId: documents.ownerId,
            ownerUnitId: documents.ownerUnitId,
            status: documents.status,
            confidentiality: documents.confidentiality,
            publishedVersionId: documents.publishedVersionId,
            reviewMonths: documents.reviewMonths,
            nextReviewOn: documents.nextReviewOn,
          })
          .from(documents)
          .where(eq(documents.id, candidate.documentId))
          .for('update', { skipLocked: true });
        if (!doc || doc.status === 'retired') continue;
        const [version] = await tx
          .select({
            id: documentVersions.id,
            version: documentVersions.version,
            status: documentVersions.status,
            effectiveOn: documentVersions.effectiveOn,
            preparedBy: documentVersions.preparedBy,
            scheduledBy: documentVersions.scheduledBy,
            acknowledgementRequired: documentVersions.acknowledgementRequired,
            acknowledgeWithinDays: documentVersions.acknowledgeWithinDays,
          })
          .from(documentVersions)
          .where(eq(documentVersions.id, candidate.id))
          .for('update', { skipLocked: true });
        // Read again under the lock: published, recalled or moved since.
        if (
          !version ||
          version.status !== 'approved' ||
          !version.effectiveOn ||
          version.effectiveOn > today
        ) {
          continue;
        }
        const outcome = await this.publisher.publish(tx, tenantId, doc, version, {
          actorId: null,
          effectiveOn: version.effectiveOn,
          today,
          now,
        });
        published += 1;
        notified += outcome.notified;
      }
      // Only a full batch published means there may be more: candidates
      // passed over (held by another process) are that process's to do.
      return { claimed: published, published, notified };
    });
  }

  /**
   * Claims up to BATCH active documents whose next review has entered a
   * stage not yet announced for that date, marks them, and tells their
   * owners (and, once overdue, their managers).
   */
  private remindReviews(tenantId: string, today: string) {
    const rank = sql<number>`case
      when ${documents.nextReviewOn} < ${today}::date then ${sql.raw(String(OVERDUE_RANK))}
      ${sql.join(
        [...REVIEW_NOTICES]
          .reverse()
          .map(
            (n) =>
              sql`when ${documents.nextReviewOn} <= ${shiftDay(today, n.days)}::date then ${sql.raw(String(n.rank))}`,
          ),
        sql` `,
      )}
    end`;
    return this.inClient(tenantId, async (tx) => {
      const claimed = await tx
        .select({
          id: documents.id,
          number: documents.number,
          ownerId: documents.ownerId,
          ownerUnitId: documents.ownerUnitId,
          status: documents.status,
          confidentiality: documents.confidentiality,
          nextReviewOn: documents.nextReviewOn,
          rank: rank.mapWith(Number),
        })
        .from(documents)
        .where(
          and(
            eq(documents.status, 'active'),
            sql`${documents.nextReviewOn} <= ${shiftDay(today, REVIEW_NOTICES[0].days)}`,
            sql`(${documents.reviewNoticeFor} is distinct from ${documents.nextReviewOn} or coalesce(${documents.reviewNoticeRank}, 0) < ${rank})`,
          ),
        )
        .orderBy(asc(documents.nextReviewOn), asc(documents.id))
        .limit(BATCH)
        .for('update', { skipLocked: true });
      let notified = 0;
      for (const doc of claimed) {
        await tx
          .update(documents)
          .set({ reviewNoticeRank: doc.rank, reviewNoticeFor: doc.nextReviewOn })
          .where(eq(documents.id, doc.id));
        const overdue = doc.rank === OVERDUE_RANK;
        const managers = overdue ? await this.managersOf(tx, doc.ownerUnitId) : [];
        const days = REVIEW_NOTICES.find((n) => n.rank === doc.rank)?.days;
        notified += await this.notifier.send(tx, tenantId, doc, null, [
          {
            kind: overdue ? 'review_overdue' : 'review_due',
            data: {
              dueOn: doc.nextReviewOn!,
              ...(days !== undefined && { days }),
            },
            to: [doc.ownerId, ...managers],
            about: 'published',
          },
        ]);
      }
      return { claimed: claimed.length, notified };
    });
  }

  private async managersOf(tx: Transaction, unitId: string) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      with recursive up (id, parent_id) as (
        select o.id, o.parent_id from org_units o where o.id = ${unitId}
        union
        select o.id, o.parent_id from org_units o join up on o.id = up.parent_id
      )
      select distinct ra.user_id as id
      from role_assignments ra
      join roles r on r.id = ra.role_id
      where 'policies.manage' = any(r.permissions)
        and (ra.org_unit_id is null or ra.org_unit_id in (select id from up))`);
    return rows.map((r) => r.id);
  }

  /**
   * Claims up to BATCH acknowledgements not given, on the published version
   * of an active document, whose reminder has come: at half the time
   * allowed, or once the day has passed. Marks them and tells the person.
   */
  private remindAcknowledgements(tenantId: string, today: string, now: Date) {
    const ack = documentAcknowledgements;
    const half = sql`${ack.dueOn} - (${documentVersions.acknowledgeWithinDays} / 2)`;
    const overdue = sql`${ack.dueOn} < ${today}`;
    return this.inClient(tenantId, async (tx) => {
      const claimed = await tx
        .select({
          id: ack.id,
          userId: ack.userId,
          dueOn: ack.dueOn,
          remindedAt: ack.remindedAt,
          overdue: sql<boolean>`${overdue}`,
          version: documentVersions.version,
          documentId: documents.id,
        })
        .from(ack)
        .innerJoin(documentVersions, eq(documentVersions.id, ack.versionId))
        .innerJoin(
          documents,
          and(
            eq(documents.publishedVersionId, ack.versionId),
            eq(documents.status, 'active'),
          ),
        )
        .where(
          and(
            sql`${ack.acknowledgedAt} is null`,
            sql`exists (select from users u where u.id = ${ack.userId} and u.status = 'active')`,
            sql`((${overdue} and ${ack.overdueRemindedAt} is null) or (${ack.remindedAt} is null and ${half} <= ${today}::date))`,
          ),
        )
        .orderBy(asc(ack.dueOn), asc(ack.id))
        .limit(BATCH)
        .for('update', { of: ack, skipLocked: true });
      if (claimed.length === 0) return { claimed: 0, notified: 0 };
      for (const row of claimed) {
        await tx
          .update(ack)
          .set({
            remindedAt: row.remindedAt ?? now,
            ...(row.overdue && { overdueRemindedAt: now }),
          })
          .where(eq(ack.id, row.id));
      }
      const byDocument = new Map<string, typeof claimed>();
      for (const row of claimed) {
        byDocument.set(row.documentId, [...(byDocument.get(row.documentId) ?? []), row]);
      }
      const docs = await this.documentsById(tx, [...byDocument.keys()]);
      let notified = 0;
      for (const [documentId, rows] of byDocument) {
        const doc = docs.get(documentId);
        if (!doc) continue;
        for (const kind of ['acknowledgement_overdue', 'acknowledgement_due'] as const) {
          const of = rows.filter((r) => r.overdue === (kind === 'acknowledgement_overdue'));
          // One notice per person, with that person's day.
          for (const row of of) {
            notified += await this.notifier.send(tx, tenantId, doc, null, [
              {
                kind,
                data: { version: row.version, dueOn: row.dueOn },
                to: [row.userId],
                about: 'published',
              },
            ]);
          }
        }
      }
      return { claimed: claimed.length, notified };
    });
  }

  private async documentsById(tx: Transaction, ids: string[]) {
    if (ids.length === 0) return new Map<string, NotifiedDocument>();
    const found = await tx
      .select({
        id: documents.id,
        number: documents.number,
        ownerId: documents.ownerId,
        ownerUnitId: documents.ownerUnitId,
        status: documents.status,
        confidentiality: documents.confidentiality,
      })
      .from(documents)
      .where(inArray(documents.id, ids));
    return new Map(found.map((d) => [d.id, d]));
  }

  /**
   * Asks everyone who has joined the audience of a published version that
   * asks for acknowledgement, and has not been asked, BATCH documents to a
   * transaction. Each person is added once whoever runs it.
   */
  private async askJoiners(tenantId: string, today: string, now: Date) {
    let after = '00000000-0000-0000-0000-000000000000';
    const done = { assigned: 0, notified: 0 };
    for (;;) {
      if (this.stopping) return done;
      const page = await this.inClient(tenantId, async (tx) => {
        const list = await tx
          .select({
            id: documents.id,
            number: documents.number,
            ownerId: documents.ownerId,
            ownerUnitId: documents.ownerUnitId,
            status: documents.status,
            confidentiality: documents.confidentiality,
            versionId: documentVersions.id,
            version: documentVersions.version,
            days: documentVersions.acknowledgeWithinDays,
          })
          .from(documents)
          .innerJoin(
            documentVersions,
            and(
              eq(documentVersions.id, documents.publishedVersionId),
              eq(documentVersions.acknowledgementRequired, true),
            ),
          )
          .where(
            and(eq(documents.status, 'active'), sql`${documents.id} > ${after}`),
          )
          .orderBy(asc(documents.id))
          .limit(BATCH);
        let assigned = 0;
        let notified = 0;
        for (const doc of list) {
          const dueOn = shiftDay(today, doc.days);
          const added = await this.publisher.assignAcknowledgements(
            tx,
            tenantId,
            doc.id,
            doc.versionId,
            dueOn,
            now,
          );
          assigned += added.length;
          if (added.length > 0) {
            notified += await this.notifier.send(tx, tenantId, doc, null, [
              {
                kind: 'acknowledgement_assigned',
                data: { version: doc.version, dueOn },
                to: added,
                about: 'published',
              },
            ]);
          }
        }
        return { list, assigned, notified };
      });
      done.assigned += page.assigned;
      done.notified += page.notified;
      if (page.list.length < BATCH) return done;
      after = page.list[page.list.length - 1].id;
    }
  }
}
