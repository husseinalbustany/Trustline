import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { ActionsService, type ActionRow } from '../actions/actions.service.js';
import type { CreateActionInput, UpdateActionInput } from '../actions/input.js';
import { overdueActions } from '../actions/measures.js';
import type { Transaction } from '../database/client.js';
import { actions, riskCategories, riskCommittees, riskControls, riskRatings, riskReviews, risks } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import { shiftDay, startOfDay } from '../i18n/time-zones.js';
import { assertNotInApproval } from './acceptance.js';
import {
  aboveTolerance,
  addEvent,
  beingTreated,
  copyOf,
  copyValues,
  matrixInUse,
  namesOf,
  notYours,
  riskColumns,
  short,
  stale,
  summaryOf,
  todayOf,
  writeNote,
  writeRatings,
} from './common.js';
import { RiskApprovalsService } from './approvals.service.js';
import { RiskEscalation } from './escalation.js';
import type { ActionCorrectionInput, ReviewInput } from './input.js';
import { bandOf, matrixInUseId, rankOf } from './matrix.js';
import { RiskRegisterService, unitAndBelow } from './register.service.js';
import { isSerious, RiskNotifier } from './risk-notifier.js';
import { manages, riskViewerOf, roleOf, visible } from './visibility.js';

/** How far ahead "my risks" and the digest count a review as due. */
export const REVIEW_DUE_DAYS = 14;
/** How far ahead "Reviews due" lists a review. */
export const REVIEWS_LIST_DAYS = 30;
/** How far ahead the digest counts an action as due. */
export const ACTION_DUE_DAYS = 7;

/**
 * The work done on risks, steps 3 to 5 of docs/specs/risk-management.md:
 * reviews, escalation by hand and coming down, actions on risks through the
 * shared engine, and the answers that gather work for a person ("My
 * risks", "Reviews due", the summary, a committee's list, the digest).
 * Every lookup goes through `visibility.ts`; every change is audited in its
 * transaction and written to the risk's timeline.
 */
@Injectable()
export class RiskWorkService implements OnModuleInit {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly register: RiskRegisterService,
    private readonly engine: ActionsService,
    private readonly escalation: RiskEscalation,
    private readonly notifier: RiskNotifier,
    private readonly approvals: RiskApprovalsService,
  ) {}

  /** The risks module's rules for actions whose source is a risk. */
  onModuleInit() {
    this.engine.register('risk', {
      module: 'risks',
      record: async (tx, id) => {
        const [r] = await tx
          .select({ id: risks.id, reference: risks.reference, orgUnitId: risks.orgUnitId, ownerId: risks.ownerId, band: risks.currentBand })
          .from(risks)
          .where(eq(risks.id, id));
        return r ? { id: r.id, reference: r.reference, orgUnitId: r.orgUnitId, ownerId: r.ownerId, serious: isSerious(r.band) } : null;
      },
      managersOf: (tx, record) => this.notifier.managersOf(tx, record.orgUnitId),
    });
  }

  // Reviews (step 3).

  /**
   * Records a review of a risk on the register, given its revision: by its
   * owner, a manager, or a member of the committee it is escalated to, who
   * then reviews for the committee (`committeeId`). It records a current
   * rating (confirmed or changed, a new row either way), and the target,
   * treatment and controls' effectiveness if changed. The next review is
   * today plus the interval of the band it leaves the risk in, or an earlier
   * day given (400 `review_interval_too_long` for a later one). An outcome
   * of `no_change` with another current rating is 400 `outcome_mismatch`.
   * The comment stays on the review, correctable; the trail says what was
   * decided, not the text. Its treatment is set by the owner or a manager,
   * never by a member reviewing for a committee only, and never to "accept"
   * above tolerance, which only a signed acceptance gives (security review
   * 17, L1). Not while an acceptance or a closure is in approval (409); a
   * score above the one an acceptance in force accepted ends it.
   */
  review(auth: AuthContext, id: string, input: ReviewInput) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const matrix = await matrixInUse(tx);
      const risk = await this.register.lock(tx, viewer, id);
      const role = roleOf(viewer, risk);
      if (input.committeeId !== undefined) {
        if (input.committeeId !== risk.escalatedToCommitteeId || !role.member) {
          throw new ForbiddenException({ code: 'not_a_member' });
        }
      } else if (!role.manager && !role.owner) {
        throw notYours();
      }
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'open') throw new ConflictException({ code: 'not_on_register' });
      await assertNotInApproval(tx, risk);
      if (input.treatment !== undefined && input.treatment !== risk.treatment) {
        if (!role.manager && !role.owner) throw notYours();
      }
      const before = copyOf(risk, 'current');
      const rated = this.register.rateAll(matrix, { current: input.current, target: input.target }, {
        current: null,
        target: input.target ? null : copyOf(risk, 'target'),
      });
      const current = rated.current!;
      if (input.treatment !== undefined && input.treatment !== risk.treatment) {
        this.register.assertTreatment(input.treatment, current.band, await this.register.toleranceOf(tx, risk.categoryId));
      }
      if (
        input.outcome === 'no_change' &&
        (!before || before.likelihood !== current.likelihood || before.impact !== current.impact)
      ) {
        throw new BadRequestException({ code: 'outcome_mismatch' });
      }
      const today = todayOf(auth);
      const longest = shiftDay(today, bandOf(matrix, current.band).reviewIntervalDays);
      if (input.nextReviewOn !== undefined) {
        if (input.nextReviewOn <= today) throw new BadRequestException({ code: 'review_day_past' });
        if (input.nextReviewOn > longest) {
          throw new BadRequestException({ code: 'review_interval_too_long', latest: longest });
        }
      }
      const nextReviewOn = input.nextReviewOn ?? longest;
      const controls = [];
      for (const c of input.controls) {
        const [found] = await tx
          .select({ id: riskControls.id, effectiveness: riskControls.effectiveness })
          .from(riskControls)
          .where(and(eq(riskControls.id, c.controlId), eq(riskControls.riskId, id), eq(riskControls.active, true)))
          .for('update');
        if (!found) throw new BadRequestException({ code: 'unknown_control' });
        if (found.effectiveness === c.effectiveness) continue;
        await tx
          .update(riskControls)
          .set({
            effectiveness: c.effectiveness,
            assessedOn: c.effectiveness === 'not_assessed' ? null : today,
            revision: sql`${riskControls.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(riskControls.id, c.controlId));
        controls.push({ controlId: c.controlId, from: found.effectiveness, to: c.effectiveness });
      }
      const late = !!risk.nextReviewOn && risk.nextReviewOn < today;
      const [review] = await tx
        .insert(riskReviews)
        .values({
          tenantId: auth.tenant.id,
          riskId: id,
          dueOn: risk.nextReviewOn,
          reviewedOn: today,
          reviewedBy: auth.user.id,
          committeeId: input.committeeId ?? null,
          outcome: input.outcome,
          comment: input.comment,
          nextReviewOn,
          late,
        })
        .returning({ id: riskReviews.id });
      await writeRatings(tx, auth, id, rated, review.id);
      const treatment = input.treatment === undefined ? risk.treatment : input.treatment;
      await tx
        .update(risks)
        .set({
          ...copyValues('current', current),
          ...(rated.target ? copyValues('target', rated.target) : {}),
          ...(input.treatment !== undefined ? { treatment: input.treatment } : {}),
          ...(input.targetOn !== undefined ? { targetOn: input.targetOn } : {}),
          lastReviewedOn: today,
          nextReviewOn,
          revision: sql`${risks.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(risks.id, id));
      const details = {
        reviewId: review.id,
        outcome: input.outcome,
        late,
        dueOn: risk.nextReviewOn,
        nextReviewOn,
        committeeId: input.committeeId ?? null,
        current: { from: short(before), to: short(current) },
        ...(rated.target ? { target: { from: short(copyOf(risk, 'target')), to: short(rated.target) } } : {}),
        ...(controls.length ? { controls } : {}),
        ...(input.treatment !== undefined && input.treatment !== risk.treatment
          ? { treatment: { from: risk.treatment, to: input.treatment } }
          : {}),
        ...(input.targetOn !== undefined && input.targetOn !== risk.targetOn
          ? { targetOn: { from: risk.targetOn, to: input.targetOn } }
          : {}),
      };
      await addEvent(tx, auth, id, 'reviewed', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_reviewed', 'risk', id, details);
      const lapsed = await this.register.lapseIfRisen(tx, auth, risk, current.score, current.band);
      await this.register.afterCurrent(
        tx,
        auth,
        risk,
        {
          band: current.band,
          targetBand: rated.target?.band ?? risk.targetBand,
          treatment,
          status: 'open',
          acceptanceId: lapsed ? null : risk.acceptanceId,
        },
        matrix,
      );
      return this.register.view(tx, auth, viewer, id);
    });
  }

  // Escalation (step 5).

  /**
   * Puts a risk on the register before a committee by hand, for a manager
   * of it, with a reason kept as a correctable note (the trail names the
   * note, never its text). 400 `unknown_committee` for one the client does
   * not have or has switched off; 409 `already_escalated` to the same one
   * or one below it (a lower `position`) while that one is in use: a
   * committee does not send a risk down by escalating it (security review
   * 17, M1). Open while the subscription is suspended: safety work
   * (business decision 16).
   */
  escalate(auth: AuthContext, id: string, input: { revision: number; committeeId: string; reason: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.register.lock(tx, viewer, id);
      if (!roleOf(viewer, risk).manager) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'open') throw new ConflictException({ code: 'not_on_register' });
      const committees = await this.escalation.committees(tx);
      const to = committees.get(input.committeeId);
      if (!to?.active) throw new BadRequestException({ code: 'unknown_committee' });
      const now = risk.escalatedToCommitteeId ? committees.get(risk.escalatedToCommitteeId) : undefined;
      if (risk.escalatedToCommitteeId === input.committeeId || (now?.active && now.position >= to.position)) {
        throw new ConflictException({ code: 'already_escalated' });
      }
      const noteId = await writeNote(tx, { tenantId: auth.tenant.id, userId: auth.user.id }, id, 'escalation_reason', input.reason);
      await this.escalation.escalate(tx, { tenantId: auth.tenant.id, actorId: auth.user.id }, risk, input.committeeId, {
        automatic: false,
        band: risk.currentBand,
        noteId,
      });
      return this.register.view(tx, auth, viewer, id);
    });
  }

  /**
   * Takes a risk off its committee's list, for a member of that committee
   * or a manager of risks for the whole organization, with a reason, once
   * its band is below the committee's threshold (409
   * `still_above_threshold`). Never automatic. A band that calls for a
   * lower committee puts it before that one at once. Not by whoever lowered
   * its current rating the same day (403 `same_person`: security review 17,
   * L1). The reason is kept as a correctable note.
   */
  deEscalate(auth: AuthContext, id: string, input: { revision: number; reason: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const matrix = await matrixInUse(tx);
      const risk = await this.register.lock(tx, viewer, id);
      const committeeId = risk.escalatedToCommitteeId;
      if (!committeeId || risk.status !== 'open') throw new ConflictException({ code: 'not_escalated' });
      if (!roleOf(viewer, risk).member && !covers(auth, 'risks.manage', null)) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (await this.loweredToday(tx, auth, id)) throw new ForbiddenException({ code: 'same_person' });
      const committees = await this.escalation.committees(tx);
      const threshold = this.escalation.thresholdRank(matrix, committees, committeeId);
      if (threshold !== null && risk.currentBand && rankOf(risk.currentBand) >= threshold) {
        throw new ConflictException({ code: 'still_above_threshold' });
      }
      await tx
        .update(risks)
        .set({ escalatedToCommitteeId: null, escalatedAt: null, revision: sql`${risks.revision} + 1`, updatedAt: new Date() })
        .where(eq(risks.id, id));
      const noteId = await writeNote(tx, { tenantId: auth.tenant.id, userId: auth.user.id }, id, 'de_escalation_reason', input.reason);
      const details = { committeeId, band: risk.currentBand, noteId };
      await addEvent(tx, auth, id, 'de_escalated', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_de_escalated', 'risk', id, details);
      const members = await this.notifier.membersOf(tx, committeeId);
      await this.notifier.send(tx, auth.tenant.id, risk, auth.user.id, [
        { kind: 'risk_de_escalated', to: [risk.ownerId, ...members], data: { committeeId } },
      ]);
      if (risk.currentBand) {
        await this.escalation.afterCurrentRating(
          tx,
          { tenantId: auth.tenant.id, actorId: auth.user.id },
          { ...risk, escalatedToCommitteeId: null },
          // Its standing did not change: no new tolerance notice.
          { before: 'within', after: 'within' },
          risk.currentBand,
          matrix,
        );
      }
      // A member who reads it only as a member no longer reads it: told it
      // is done, and nothing more of it.
      try {
        return await this.register.view(tx, auth, viewer, id);
      } catch (e) {
        if (!(e instanceof NotFoundException)) throw e;
        return { access: 'none' as const, id, reference: risk.reference, escalatedToCommitteeId: null };
      }
    });
  }

  /** Whether the caller lowered the risk's current score today, in the client's time zone. */
  private async loweredToday(tx: Transaction, auth: AuthContext, riskId: string) {
    const since = startOfDay(todayOf(auth), auth.tenant.timeZone);
    const [row] = await tx
      .select({ id: riskRatings.id })
      .from(riskRatings)
      .where(
        and(
          eq(riskRatings.riskId, riskId),
          eq(riskRatings.kind, 'current'),
          eq(riskRatings.ratedBy, auth.user.id),
          sql`${riskRatings.ratedAt} >= ${since}`,
          sql`${riskRatings.score} < (select p.score from ${riskRatings} p
            where p.risk_id = ${riskRatings.riskId} and p.kind = 'current'
              and (p.rated_at, p.id) < (${riskRatings.ratedAt}, ${riskRatings.id})
            order by p.rated_at desc, p.id desc limit 1)`,
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * The risks escalated to one committee, for its members and for readers
   * for the whole organization (403 otherwise; 404 for a committee the
   * client does not have): each with its ratings, standing, actions and
   * last review.
   */
  committeeRisks(auth: AuthContext, committeeId: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const [committee] = await tx
        .select({ id: riskCommittees.id, name: riskCommittees.name, active: riskCommittees.active })
        .from(riskCommittees)
        .where(eq(riskCommittees.id, committeeId));
      if (!committee) throw new NotFoundException();
      if (!viewer.committeeIds.includes(committeeId) && viewer.readReach !== 'all') {
        throw new ForbiddenException({ code: 'missing_permission', permission: 'risks.view' });
      }
      const today = todayOf(auth);
      const rows = await this.register.rows(
        tx,
        today,
        and(visible(viewer), eq(risks.status, 'open'), eq(risks.escalatedToCommitteeId, committeeId))!,
        [sql`${risks.currentScore} desc nulls last`, asc(risks.reference)],
        500,
      );
      const inUse = await matrixInUseId(tx);
      const lastReviews = rows.length
        ? await tx
            .selectDistinctOn([riskReviews.riskId], {
              riskId: riskReviews.riskId,
              reviewedOn: riskReviews.reviewedOn,
              committeeId: riskReviews.committeeId,
            })
            .from(riskReviews)
            .where(inArray(riskReviews.riskId, rows.map((r) => r.id)))
            .orderBy(riskReviews.riskId, sql`${riskReviews.createdAt} desc`)
        : [];
      const last = new Map(lastReviews.map((r) => [r.riskId, r]));
      return {
        committee,
        items: rows.map((r) => ({
          ...summaryOf(r, today, inUse),
          lastReview: last.get(r.id) ? { reviewedOn: last.get(r.id)!.reviewedOn, committeeId: last.get(r.id)!.committeeId } : null,
        })),
        total: rows.length,
        ...(await namesOf(tx, {
          people: rows.map((r) => r.ownerId),
          units: rows.map((r) => r.orgUnitId),
          categories: rows.map((r) => r.categoryId),
          committees: [committeeId],
        })),
      };
    });
  }

  // The answers that gather work.

  /**
   * "My risks and actions": the risks the caller owns on the register,
   * review overdue and due first; the actions they own that are open or in
   * progress, overdue and due first, each with the reference, title and
   * current band of its risk, nothing more; the committees they sit on with
   * how many risks are before each; the acceptance and closure steps
   * waiting for their signature.
   */
  mine(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const today = todayOf(auth);
      const inUse = await matrixInUseId(tx);
      const owned = await this.register.rows(
        tx,
        today,
        and(visible(viewer), eq(risks.status, 'open'), eq(risks.ownerId, auth.user.id))!,
        [sql`${risks.nextReviewOn} asc nulls last`, asc(risks.reference)],
        200,
      );
      const myActions = await this.engine.mine(tx, auth.user.id);
      const riskIds = [...new Set(myActions.map((a) => a.riskId).filter((r): r is string => !!r))];
      const served = riskIds.length
        ? await tx
            .select(riskColumns)
            .from(risks)
            .where(inArray(risks.id, riskIds))
        : [];
      const byId = new Map(served.map((r) => [r.id, r]));
      const committees = viewer.committeeIds.length
        ? await tx
            .select({
              id: riskCommittees.id,
              name: riskCommittees.name,
              risks: sql<number>`(select count(*) from ${risks} r where r.escalated_to_committee_id = ${riskCommittees.id} and r.status = 'open')`.mapWith(Number),
            })
            .from(riskCommittees)
            .where(inArray(riskCommittees.id, viewer.committeeIds))
            .orderBy(asc(riskCommittees.position))
        : [];
      return {
        risks: owned.map((r) => summaryOf(r, today, inUse)),
        actions: myActions.map((a) => {
          const risk = byId.get(a.riskId!)!;
          return {
            ...this.engine.view(a, this.register.callerFor(auth, viewer, risk)),
            risk: { id: risk.id, reference: risk.reference, title: risk.title, current: short(copyOf(risk, 'current')) },
          };
        }),
        committees,
        steps: await this.approvals.stepsFor(tx, auth, viewer),
      };
    });
  }

  /**
   * "Reviews due", for those who manage risks: the open risks they manage
   * whose next review is within 30 days (`due`) or has passed
   * (`overdue`), soonest first, under a unit if asked.
   */
  reviewsDue(auth: AuthContext, input: { state?: 'due' | 'overdue'; unitId?: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const today = todayOf(auth);
      const where = and(
        visible(viewer),
        manages(viewer),
        eq(risks.status, 'open'),
        input.state === 'overdue'
          ? sql`${risks.nextReviewOn} < ${today}`
          : input.state === 'due'
            ? sql`${risks.nextReviewOn} between ${today} and ${shiftDay(today, REVIEWS_LIST_DAYS)}`
            : sql`${risks.nextReviewOn} <= ${shiftDay(today, REVIEWS_LIST_DAYS)}`,
        input.unitId ? unitAndBelow(input.unitId) : undefined,
      )!;
      const [{ total }] = await tx
        .select({ total: count() })
        .from(risks)
        .innerJoin(riskCategories, eq(riskCategories.id, risks.categoryId))
        .where(where);
      const rows = await this.register.rows(tx, today, where, [asc(risks.nextReviewOn), asc(risks.reference)], 500);
      const inUse = await matrixInUseId(tx);
      return {
        items: rows.map((r) => summaryOf(r, today, inUse)),
        total,
        ...(await namesOf(tx, { people: rows.map((r) => r.ownerId), units: rows.map((r) => r.orgUnitId) })),
      };
    });
  }

  /**
   * The counts of the dashboard's tiles, over the risks the caller reads in
   * full: high and extreme risks, risks above tolerance not addressed,
   * reviews overdue, and `actions.overdue` over the actions of those risks.
   */
  summary(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const today = todayOf(auth);
      const [row] = await tx
        .select({
          open: count(),
          highAndExtreme: sql<number>`count(*) filter (where ${risks.currentBand} in ('high', 'extreme'))`.mapWith(Number),
          notAddressed: sql<number>`count(*) filter (where ${aboveTolerance} and not ${beingTreated})`.mapWith(Number),
          reviewsOverdue: sql<number>`count(*) filter (where ${risks.nextReviewOn} < ${today})`.mapWith(Number),
        })
        .from(risks)
        .innerJoin(riskCategories, eq(riskCategories.id, risks.categoryId))
        .where(and(visible(viewer), eq(risks.status, 'open')));
      return {
        openRisks: row.open,
        highAndExtreme: row.highAndExtreme,
        aboveToleranceNotAddressed: row.notAddressed,
        reviewsOverdue: row.reviewsOverdue,
        overdueActions: await overdueActions(
          tx,
          today,
          sql`exists (select from ${risks} where ${risks.id} = ${actions.riskId} and ${visible(viewer)})`,
        ),
      };
    });
  }

  /**
   * What waits for a person, for their morning digest: the same lists their
   * screens show them. Risks they own with a review within 14 days or past;
   * actions they own due within 7 days or past; for managers, risks
   * proposed for the register; acceptance and closure steps to sign.
   */
  digestFor(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const today = todayOf(auth);
      const reviews = await tx
        .select({ id: risks.id, reference: risks.reference, nextReviewOn: risks.nextReviewOn })
        .from(risks)
        .where(
          and(
            visible(viewer),
            eq(risks.status, 'open'),
            eq(risks.ownerId, auth.user.id),
            sql`${risks.nextReviewOn} <= ${shiftDay(today, REVIEW_DUE_DAYS)}`,
          ),
        )
        .orderBy(asc(risks.nextReviewOn), asc(risks.reference));
      const due = (await this.engine.mine(tx, auth.user.id)).filter((a) => a.dueOn <= shiftDay(today, ACTION_DUE_DAYS));
      const proposals =
        viewer.manageReach === 'all' || viewer.manageReach.length > 0
          ? await tx
              .select({ id: risks.id, reference: risks.reference })
              .from(risks)
              .where(and(visible(viewer), manages(viewer), eq(risks.status, 'proposed')))
              .orderBy(asc(risks.reference))
          : [];
      return {
        reviews: reviews.map((r) => ({ id: r.id, reference: r.reference, overdue: !!r.nextReviewOn && r.nextReviewOn < today })),
        actions: due.map((a) => ({ id: a.id, reference: a.reference, riskId: a.riskId!, overdue: a.dueOn < today })),
        proposals,
        steps: await this.approvals.stepsFor(tx, auth, viewer),
      };
    });
  }

  // Actions on risks (step 4), through the shared engine.

  /** A risk's actions, for its readers in full; its owner's own for an action's owner. */
  listActions(auth: AuthContext, riskId: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const view = await this.register.view(tx, auth, await riskViewerOf(tx, auth), riskId);
      return { items: view.actions, ...('actionSummary' in view ? { summary: view.actionSummary } : {}) };
    });
  }

  /**
   * Adds an action to a risk on the register, for its owner or a manager,
   * given the risk's revision. Its unit is the risk's unless given.
   */
  addAction(auth: AuthContext, riskId: string, input: CreateActionInput) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.register.lock(tx, viewer, riskId);
      const caller = this.register.callerFor(auth, viewer, risk);
      if (!caller.manages && !caller.ownsSource) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'open') throw new ConflictException({ code: 'not_on_register' });
      await assertNotInApproval(tx, risk, { acceptance: false });
      const { revision: _revision, ...fields } = input;
      const record = { id: risk.id, reference: risk.reference, orgUnitId: risk.orgUnitId, ownerId: risk.ownerId, serious: isSerious(risk.currentBand) };
      const created = await this.engine.create(tx, caller, { type: 'risk', record }, fields);
      const riskRevision = await this.register.touch(tx, risk.id);
      return { ...this.engine.view(created, caller), riskRevision };
    });
  }

  /**
   * Finds an action, locked, with its risk, for someone who reads the risk
   * in full or owns the action (404 otherwise), and what the engine needs
   * to know of them.
   */
  private async actionFor(tx: Transaction, auth: AuthContext, actionId: string) {
    const viewer = await riskViewerOf(tx, auth);
    const action = await this.engine.lock(tx, actionId);
    if (!action || action.sourceType !== 'risk') throw new NotFoundException();
    const { risk } = await this.register.actionContext(tx, auth, viewer, action);
    const caller = this.register.callerFor(auth, viewer, risk);
    const record = { id: risk.id, reference: risk.reference, orgUnitId: risk.orgUnitId, ownerId: risk.ownerId, serious: isSerious(risk.currentBand) };
    return { action, caller, record, riskId: risk.id };
  }

  /** Runs a change of an action in one transaction, and answers the action as the caller sees it. */
  private changeAction(
    auth: AuthContext,
    actionId: string,
    change: (tx: Transaction, found: Awaited<ReturnType<RiskWorkService['actionFor']>>) => Promise<ActionRow>,
  ) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const found = await this.actionFor(tx, auth, actionId);
      const after = await change(tx, found);
      // The risk's page shows its actions: its revision moves with them.
      const riskRevision = await this.register.touch(tx, found.riskId);
      return { ...this.engine.view(after, found.caller), riskRevision };
    });
  }

  updateAction(auth: AuthContext, actionId: string, input: UpdateActionInput) {
    return this.changeAction(auth, actionId, (tx, f) => this.engine.update(tx, f.caller, f.action, f.record, input));
  }

  /** Open while the subscription is suspended: safety work (business decision 16). */
  completeAction(auth: AuthContext, actionId: string, input: { revision: number; note: string }) {
    return this.changeAction(auth, actionId, (tx, f) => this.engine.complete(tx, f.caller, f.action, f.record, input));
  }

  verifyAction(auth: AuthContext, actionId: string, input: { revision: number; outcome: 'effective' | 'not_effective'; note?: string }) {
    return this.changeAction(auth, actionId, (tx, f) => this.engine.verify(tx, f.caller, f.action, input));
  }

  cancelAction(auth: AuthContext, actionId: string, input: { revision: number; reason: string }) {
    return this.changeAction(auth, actionId, (tx, f) => this.engine.cancel(tx, f.caller, f.action, input));
  }

  reopenAction(auth: AuthContext, actionId: string, input: { revision: number; reason: string }) {
    return this.changeAction(auth, actionId, (tx, f) => this.engine.reopen(tx, f.caller, f.action, input));
  }

  correctAction(
    auth: AuthContext,
    actionId: string,
    input: ActionCorrectionInput,
  ) {
    return this.changeAction(auth, actionId, (tx, f) => this.engine.correct(tx, f.caller, f.action, input));
  }

  /** An action with its timeline, for whoever may see it. */
  action(auth: AuthContext, actionId: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const [action] = await tx.select().from(actions).where(eq(actions.id, actionId));
      if (!action || action.sourceType !== 'risk') throw new NotFoundException();
      const { risk, full } = await this.register.actionContext(tx, auth, viewer, action);
      const caller = this.register.callerFor(auth, viewer, risk);
      const events = await this.engine.eventsOf(tx, actionId);
      return {
        ...this.engine.view(action, caller),
        risk: { id: risk.id, reference: risk.reference, title: risk.title, current: short(copyOf(risk, 'current')), access: full ? 'full' : 'summary' },
        events,
        ...(await namesOf(tx, {
          people: [action.ownerId, action.createdBy, action.completedBy, action.verifiedBy, ...events.map((e) => e.actorId)],
          units: [action.orgUnitId],
        })),
      };
    });
  }
}
