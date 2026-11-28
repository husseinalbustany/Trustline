import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import { databaseFailure } from '../database/database-error.filter.js';
import { DATABASE } from '../database/database.constants.js';
import {
  approvalRuns,
  approvalRunSteps,
  documentAcknowledgements,
  documents,
  documentVersions,
  policyReminders,
  tenants,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { dayOf, isoWeekOf, shiftDay } from '../i18n/time-zones.js';
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
 *   come, on the client's calendar, is published (`Publisher`), if its
 *   signatures still stand behind what it holds (`Publisher.isSigned`).
 *   One whose do not is left approved, unpublished, and named in the log
 *   with its client, on every run until someone deals with it; and the
 *   document's managers are told, once (`document_publish_failed`).
 * - **Overdue approval steps:** the current step of a run in progress past
 *   its due time is reported to the document's managers, once per step
 *   (`document_step_overdue`).
 * - **The weekly digest:** once a week (from the first run of each ISO
 *   week on the client's calendar), each manager of the units whose people
 *   have acknowledgements overdue is told how many
 *   (`acknowledgements_overdue_digest`); see `digestRecipients`.
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
    // Versions passed over in this run because their signatures do not
    // stand behind them: not looked at again until the next run.
    const unsigned = new Set<string>();
    const steps: (() => Promise<{
      claimed: number;
      published?: number;
      assigned?: number;
      notified: number;
    }>)[] = [
      () => this.publishScheduled(client.id, today, now, unsigned),
      () => this.remindReviews(client.id, today),
      () => this.remindAcknowledgements(client.id, today, now),
      () => this.reportOverdueSteps(client.id, now),
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
    if (this.stopping) return done;
    done.notified += await this.sendDigests(client.id, today, now);
    return done;
  }

  /**
   * Publishes up to BATCH approved versions whose day has come. Each
   * document is locked before its version, as the routes do, and one
   * another process holds is passed over. One whose signatures do not stand
   * behind what it holds now is not published: it is logged, with its
   * client, and added to `unsigned`.
   */
  private publishScheduled(
    tenantId: string,
    today: string,
    now: Date,
    unsigned: Set<string>,
  ) {
    return this.inClient(tenantId, async (tx) => {
      const due = await tx
        .select({ id: documentVersions.id, documentId: documentVersions.documentId })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.status, 'approved'),
            sql`${documentVersions.effectiveOn} <= ${today}`,
            unsigned.size > 0
              ? notInArray(documentVersions.id, [...unsigned])
              : undefined,
          ),
        )
        .orderBy(asc(documentVersions.effectiveOn), asc(documentVersions.id))
        .limit(BATCH);
      let published = 0;
      let passed = 0;
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
            sections: documentVersions.sections,
            content: documentVersions.content,
            changeSummary: documentVersions.changeSummary,
            acknowledgementRequired: documentVersions.acknowledgementRequired,
            acknowledgeWithinDays: documentVersions.acknowledgeWithinDays,
            authoritativeLocale: documentVersions.authoritativeLocale,
            signsAuthoritativeLocale: documentVersions.signsAuthoritativeLocale,
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
        if (!(await this.publisher.isSigned(tx, doc, version))) {
          unsigned.add(version.id);
          passed += 1;
          this.logger.error(
            `Policy check did not publish version ${version.id} of client ${tenantId}: its signatures do not match what it holds (content_changed)`,
          );
          // Its managers are told once: the log is not read by the client.
          if (await this.claim(tx, tenantId, 'publish_failed', version.id)) {
            notified += await this.notifier.send(tx, tenantId, doc, null, [
              {
                kind: 'document_publish_failed',
                data: {
                  version: version.version,
                  versionId: version.id,
                  effectiveOn: version.effectiveOn,
                  reason: 'content_changed',
                },
                to: await this.managersOf(tx, doc.ownerUnitId),
                about: 'in_progress',
              },
            ]);
          }
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
      // Only a full batch published or found unsigned means there may be
      // more: candidates passed over (held by another process) are that
      // process's to do. Unsigned ones are not looked at again this run.
      return { claimed: published + passed, published, notified };
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
          // Approved before Trustline: its review is its re-issue.
          reissue: sql<boolean>`exists (select from document_versions pv
            where pv.id = ${documents.publishedVersionId} and pv.source = 'imported')`,
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
              ...(doc.reissue && { reissue: true }),
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
          versionId: documentVersions.id,
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
                data: {
                  version: row.version,
                  versionId: row.versionId,
                  dueOn: row.dueOn,
                },
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
                data: { version: doc.version, versionId: doc.versionId, dueOn },
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

  /**
   * Claims something to be sent once: true for whoever records it first.
   * A second process doing the same waits on the first's row, then finds
   * it there.
   */
  private async claim(
    tx: Transaction,
    tenantId: string,
    kind: 'step_overdue' | 'publish_failed' | 'acknowledgement_digest',
    subjectId: string,
    period = '',
  ) {
    const added = await tx
      .insert(policyReminders)
      .values({ tenantId, kind, subjectId, period })
      .onConflictDoNothing()
      .returning({ subjectId: policyReminders.subjectId });
    return added.length > 0;
  }

  /**
   * Reports up to BATCH steps past their due time to their documents'
   * managers: the current step of a run in progress on a version in
   * review, not reported yet. Each once.
   */
  private reportOverdueSteps(tenantId: string, now: Date) {
    return this.inClient(tenantId, async (tx) => {
      const steps = await tx
        .select({
          stepId: approvalRunSteps.id,
          position: approvalRunSteps.position,
          kind: approvalRunSteps.kind,
          dueAt: approvalRunSteps.dueAt,
          versionId: documentVersions.id,
          version: documentVersions.version,
          documentId: documentVersions.documentId,
        })
        .from(approvalRunSteps)
        .innerJoin(
          approvalRuns,
          and(
            eq(approvalRuns.id, approvalRunSteps.runId),
            eq(approvalRuns.status, 'in_progress'),
            eq(approvalRuns.subjectType, 'document_version'),
          ),
        )
        .innerJoin(
          documentVersions,
          and(
            eq(documentVersions.id, approvalRuns.subjectId),
            eq(documentVersions.status, 'in_review'),
          ),
        )
        .where(
          and(
            eq(approvalRunSteps.status, 'pending'),
            sql`${approvalRunSteps.dueAt} < ${now.toISOString()}::timestamptz`,
            sql`not exists (select from ${policyReminders} pr
              where pr.kind = 'step_overdue' and pr.subject_id = ${approvalRunSteps.id})`,
          ),
        )
        .orderBy(asc(approvalRunSteps.dueAt), asc(approvalRunSteps.id))
        .limit(BATCH);
      const docs = await this.documentsById(
        tx,
        [...new Set(steps.map((s) => s.documentId))],
      );
      let notified = 0;
      for (const step of steps) {
        // Claimed first, whatever becomes of it, so that it is looked at once.
        if (!(await this.claim(tx, tenantId, 'step_overdue', step.stepId))) {
          continue;
        }
        const doc = docs.get(step.documentId);
        if (!doc || doc.status === 'retired') continue;
        notified += await this.notifier.send(tx, tenantId, doc, null, [
          {
            kind: 'document_step_overdue',
            data: {
              version: step.version,
              versionId: step.versionId,
              position: step.position,
              step: step.kind,
            },
            to: await this.managersOf(tx, doc.ownerUnitId),
            about: 'in_progress',
          },
        ]);
      }
      return { claimed: steps.length, notified };
    });
  }

  /**
   * Who is told of each overdue acknowledgement in the weekly digest: the
   * managers of the person's unit, meaning whoever holds
   * `policies.manage` or `policies.view_all` through a grant for that unit
   * or one above it (granted for a unit, not for the whole organization);
   * where no one does, or the person has no unit, those who manage
   * documents for the whole organization. Active people only, on the
   * version in force of each active document. And, since quality review 3
   * (S2), each manager of a document with an approval step overdue, as the
   * in-app notice of it goes. Returns, for each manager, how many
   * acknowledgements and people are overdue, and how many steps.
   */
  private async digestRecipients(tx: Transaction, today: string, now: Date) {
    const { rows } = await tx.execute<{
      manager_id: string;
      overdue: number;
      people: number;
      steps_overdue: number;
    }>(sql`
      with recursive overdue as (
        select a.id, a.user_id, u.org_unit_id
        from document_acknowledgements a
        join documents d on d.published_version_id = a.version_id and d.status = 'active'
        join users u on u.id = a.user_id and u.status = 'active'
        where a.acknowledged_at is null and a.due_on < ${today}::date
      ),
      up (start_id, id, parent_id) as (
        select distinct o.org_unit_id, ou.id, ou.parent_id
        from overdue o join org_units ou on ou.id = o.org_unit_id
        union
        select up.start_id, p.id, p.parent_id
        from up join org_units p on p.id = up.parent_id
      ),
      scoped as (
        select distinct o.id as ack_id, o.user_id, ra.user_id as manager_id
        from overdue o
        join up on up.start_id = o.org_unit_id
        join role_assignments ra on ra.org_unit_id = up.id
        join roles r on r.id = ra.role_id
          and r.permissions && array['policies.manage', 'policies.view_all']::text[]
        join users m on m.id = ra.user_id and m.status = 'active'
      ),
      everywhere as (
        select distinct o.id as ack_id, o.user_id, ra.user_id as manager_id
        from overdue o
        join role_assignments ra on ra.org_unit_id is null
        join roles r on r.id = ra.role_id and 'policies.manage' = any(r.permissions)
        join users m on m.id = ra.user_id and m.status = 'active'
        where not exists (select from scoped s where s.ack_id = o.id)
      ),
      acks as (
        select manager_id, count(distinct ack_id)::int as overdue, count(distinct user_id)::int as people
        from (select * from scoped union all select * from everywhere) routed
        group by manager_id
      ),
      -- The approval steps overdue (quality review 3, S2), to whoever is
      -- told of each in the app: those who manage the document, through a
      -- grant for its unit, one above it, or the whole organization.
      steps as (
        select s.id as step_id, d.owner_unit_id
        from approval_run_steps s
        join approval_runs r on r.id = s.run_id
          and r.status = 'in_progress' and r.subject_type = 'document_version'
        join document_versions v on v.id = r.subject_id and v.status = 'in_review'
        join documents d on d.id = v.document_id and d.status <> 'retired'
        where s.status = 'pending' and s.due_at < ${now.toISOString()}::timestamptz
      ),
      steps_up (step_id, id, parent_id) as (
        select s.step_id, ou.id, ou.parent_id
        from steps s join org_units ou on ou.id = s.owner_unit_id
        union
        select su.step_id, p.id, p.parent_id
        from steps_up su join org_units p on p.id = su.parent_id
      ),
      step_managers as (
        select su.step_id, ra.user_id as manager_id
        from steps_up su
        join role_assignments ra on ra.org_unit_id = su.id
        join roles r on r.id = ra.role_id and 'policies.manage' = any(r.permissions)
        join users m on m.id = ra.user_id and m.status = 'active'
        union
        select s.step_id, ra.user_id
        from steps s
        join role_assignments ra on ra.org_unit_id is null
        join roles r on r.id = ra.role_id and 'policies.manage' = any(r.permissions)
        join users m on m.id = ra.user_id and m.status = 'active'
      ),
      step_counts as (
        select manager_id, count(distinct step_id)::int as steps_overdue
        from step_managers group by manager_id
      )
      select coalesce(a.manager_id, sc.manager_id) as manager_id,
             coalesce(a.overdue, 0) as overdue,
             coalesce(a.people, 0) as people,
             coalesce(sc.steps_overdue, 0) as steps_overdue
      from acks a full join step_counts sc on sc.manager_id = a.manager_id
      order by 1`);
    return rows;
  }

  /**
   * Sends this week's digest to each manager who has acknowledgements
   * overdue among their people and has not had it this week. Counts only.
   */
  private sendDigests(tenantId: string, today: string, now: Date) {
    const week = isoWeekOf(today);
    return this.inClient(tenantId, async (tx) => {
      const recipients = await this.digestRecipients(tx, today, now);
      const due: { userId: string; data: Record<string, string | number> }[] =
        [];
      for (const r of recipients) {
        if (!(await this.claim(tx, tenantId, 'acknowledgement_digest', r.manager_id, week))) {
          continue;
        }
        due.push({
          userId: r.manager_id,
          data: {
            overdue: r.overdue,
            people: r.people,
            stepsOverdue: r.steps_overdue,
            week,
          },
        });
      }
      return this.notifier.sendDigest(tx, tenantId, due);
    });
  }
}
