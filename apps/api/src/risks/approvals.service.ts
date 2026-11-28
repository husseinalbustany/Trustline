import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { ApprovalEngine, type Run, type RunStep } from '../approvals/approval-engine.service.js';
import { SignatureService } from '../approvals/signatures.js';
import type { Transaction } from '../database/client.js';
import { pgErrorCode } from '../database/errors.js';
import {
  approvalRoutes,
  approvalRouteSteps,
  riskAcceptances,
  riskRatings,
  risks,
  roleAssignments,
  roles,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { AuthService, type AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { fitsLanguages, type Localized } from '../i18n/locales.js';
import { addMonths, shiftDay } from '../i18n/time-zones.js';
import { acceptanceColumns, assertNotInApproval, openAcceptance, type AcceptanceRow } from './acceptance.js';
import {
  addEvent,
  assertLanguages,
  copyOf,
  copyValues,
  matrixInUse,
  namesOf,
  notYours,
  short,
  stale,
  todayOf,
  writeNote,
  writeRatings,
  type RiskRow,
} from './common.js';
import type { BandCode } from './defaults.js';
import type { AcceptanceRequestInput, RatingInput, RiskRouteCreateInput, RiskRouteUpdateInput } from './input.js';
import { bandOf, rankOf } from './matrix.js';
import { RiskRegisterService } from './register.service.js';
import { RiskNotifier } from './risk-notifier.js';
import { changesOf, riskSettingsOf } from './settings.service.js';
import { riskViewerOf, roleOf, visible, type RiskViewer } from './visibility.js';

/** What an assignee of a risk's step must hold. */
const SIGNER = 'risks.approve' as const;

type Subject = 'acceptance' | 'closure';

/**
 * What an acceptance's signers sign (spec, "Acceptance above tolerance"):
 * the risk as it was put to them, which a database rule keeps from
 * changing while the request is in approval. Anyone holding the same
 * values can recompute the hash.
 */
export function acceptanceContent(
  risk: Pick<RiskRow, 'id' | 'reference' | 'title' | 'categoryId' | 'orgUnitId'> & Parameters<typeof copyOf>[0],
  acceptance: Pick<AcceptanceRow, 'toleranceBand' | 'rationale' | 'conditions' | 'untilOn'>,
) {
  const current = copyOf(risk, 'current');
  return {
    riskId: risk.id,
    reference: risk.reference,
    title: risk.title,
    categoryId: risk.categoryId,
    orgUnitId: risk.orgUnitId,
    current: current
      ? { likelihood: current.likelihood, impact: current.impact, score: current.score, band: current.band, matrixId: current.matrixId }
      : null,
    tolerance: acceptance.toleranceBand,
    rationale: acceptance.rationale,
    conditions: acceptance.conditions,
    until: acceptance.untilOn,
  };
}

/** What a closure's signer signs: the risk, the reason and where it goes. */
export function closureContent(
  risk: Pick<RiskRow, 'id' | 'reference' | 'title' | 'closeReason' | 'mergedIntoId' | 'highestBand' | 'closureRequestedBy'>,
) {
  return {
    riskId: risk.id,
    reference: risk.reference,
    title: risk.title,
    closeReason: risk.closeReason,
    mergedIntoId: risk.mergedIntoId,
    highestBand: risk.highestBand,
    requestedBy: risk.closureRequestedBy,
  };
}

/**
 * Acceptance above tolerance, closure and reopening (step 6 of
 * docs/specs/risk-management.md), through the approval engine as
 * documents go through it: routes chosen by band (an acceptance) or one
 * route (a closure), steps in order, each decided by a different person,
 * never by the requester or the risk's owner, each approval a signature
 * with the password or the signing PIN again in the request. And the
 * client's routes for both, in the risk settings.
 *
 * Every decision is checked before the password, so that a refusal for
 * another reason neither asks for it nor counts it, and again under the
 * lock after. Text people write (a rationale, a comment, a reason) is never
 * copied into the audit trail or the timeline.
 */
@Injectable()
export class RiskApprovalsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly register: RiskRegisterService,
    private readonly engine: ApprovalEngine,
    private readonly signatures: SignatureService,
    private readonly auth: AuthService,
    private readonly notifier: RiskNotifier,
  ) {}

  private contextOf(risk: Pick<RiskRow, 'orgUnitId'>) {
    return { unitId: risk.orgUnitId, permission: SIGNER };
  }

  /** The risk as its page shows it, or that the caller no longer reads it. */
  private async answer(tx: Transaction, auth: AuthContext, risk: Pick<RiskRow, 'id' | 'reference'>) {
    try {
      return await this.register.view(tx, auth, await riskViewerOf(tx, auth), risk.id);
    } catch (e) {
      if (!(e instanceof NotFoundException)) throw e;
      // An assignee reads the risk while their step is in progress only.
      return { access: 'none' as const, id: risk.id, reference: risk.reference };
    }
  }

  /** Tells the assignees of a step that it is theirs; never its requester. */
  private async stepAssigned(
    tx: Transaction,
    auth: AuthContext,
    risk: Pick<RiskRow, 'id' | 'reference' | 'currentBand'>,
    subject: Subject,
    step: Pick<RunStep, 'position' | 'kind'>,
    to: string[],
  ) {
    await this.notifier.send(tx, auth.tenant.id, risk, auth.user.id, [
      { kind: 'risk_step_assigned', to, data: { subject, position: step.position, step: step.kind } },
    ]);
  }

  // Acceptance.

  /**
   * Asks for a risk on the register above its tolerance to be accepted, for
   * its owner or a manager, given its revision: a rationale, any
   * conditions, and the last day (after today, at most the client's
   * longest acceptance ahead: 400 `acceptance_too_long`). 409
   * `within_tolerance` for a risk not above it; `rerate_needed` for a
   * current rating on an older version of the matrix; `already_accepted`;
   * `acceptance_in_progress` and `closure_in_progress`. A band whose
   * acceptance needs no signature is accepted at once; any other goes
   * through the route of its band (409 `no_route` without one, `no_assignee`
   * when its steps cannot be covered by different people).
   */
  requestAcceptance(auth: AuthContext, id: string, input: AcceptanceRequestInput) {
    assertLanguages(auth, [], [input.rationale, input.conditions]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const matrix = await matrixInUse(tx);
      const risk = await this.register.lock(tx, viewer, id);
      const role = roleOf(viewer, risk);
      if (!role.manager && !role.owner) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'open') throw new ConflictException({ code: 'not_on_register' });
      await assertNotInApproval(tx, risk);
      if (risk.acceptanceId) throw new ConflictException({ code: 'already_accepted' });
      const current = copyOf(risk, 'current');
      const tolerance = await this.register.toleranceOf(tx, risk.categoryId);
      if (!current || rankOf(current.band) <= rankOf(tolerance)) {
        throw new ConflictException({ code: 'within_tolerance' });
      }
      if (current.matrixId !== matrix.id) throw new ConflictException({ code: 'rerate_needed' });
      const today = todayOf(auth);
      const { acceptanceMaxMonths } = await riskSettingsOf(tx);
      const latest = addMonths(today, acceptanceMaxMonths);
      if (input.until <= today) throw new BadRequestException({ code: 'until_past' });
      if (input.until > latest) throw new BadRequestException({ code: 'acceptance_too_long', latest });
      const [rating] = await tx
        .select({ id: riskRatings.id })
        .from(riskRatings)
        .where(and(eq(riskRatings.riskId, id), eq(riskRatings.kind, 'current')))
        .orderBy(desc(riskRatings.ratedAt), desc(riskRatings.id))
        .limit(1);
      const signatureRequired = bandOf(matrix, current.band).acceptanceNeedsSignature;
      const route = signatureRequired ? await this.engine.routeFor(tx, 'risk_acceptance', null, current.band) : null;
      if (signatureRequired && !route) throw new ConflictException({ code: 'no_route' });
      const now = new Date();
      const [acceptance] = await tx
        .insert(riskAcceptances)
        .values({
          tenantId: auth.tenant.id,
          riskId: id,
          requestedBy: auth.user.id,
          requestedAt: now,
          rationale: input.rationale,
          conditions: input.conditions ?? null,
          untilOn: input.until,
          ratingId: rating.id,
          score: current.score,
          bandCode: current.band,
          toleranceBand: tolerance,
          categoryId: risk.categoryId,
          status: signatureRequired ? 'in_approval' : 'accepted',
          decidedAt: signatureRequired ? null : now,
        })
        .returning(acceptanceColumns);
      let runId: string | null = null;
      if (route) {
        const { run, assignees } = await this.engine.start(tx, auth.tenant.id, {
          routeId: route.id,
          subjectType: 'risk_acceptance',
          subjectId: acceptance.id,
          startedBy: auth.user.id,
          ctx: this.contextOf(risk),
          excluded: [auth.user.id, risk.ownerId],
          now,
          timeZone: auth.tenant.timeZone,
        });
        runId = run.id;
        await tx.update(riskAcceptances).set({ approvalRunId: run.id }).where(eq(riskAcceptances.id, acceptance.id));
        await this.stepAssigned(tx, auth, risk, 'acceptance', run.steps[0], assignees);
      }
      const details = {
        acceptanceId: acceptance.id,
        runId,
        routeId: route?.id ?? null,
        band: current.band,
        score: current.score,
        tolerance,
        untilOn: input.until,
        signatureRequired,
      };
      await addEvent(tx, auth, id, 'acceptance_requested', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_acceptance_requested', 'risk', id, details);
      if (!signatureRequired) await this.accepted(tx, auth, risk, acceptance, null);
      await this.register.touch(tx, id);
      return this.register.view(tx, auth, viewer, id);
    });
  }

  /** An acceptance comes into force: the risk is accepted until its last day. */
  private async accepted(
    tx: Transaction,
    auth: AuthContext,
    risk: RiskRow,
    acceptance: Pick<AcceptanceRow, 'id' | 'untilOn' | 'bandCode' | 'score' | 'requestedBy'>,
    runId: string | null,
  ) {
    const now = new Date();
    await tx
      .update(riskAcceptances)
      .set({ status: 'accepted', decidedAt: now })
      .where(eq(riskAcceptances.id, acceptance.id));
    await tx
      .update(risks)
      .set({ acceptanceId: acceptance.id, treatment: 'accept', updatedAt: now })
      .where(eq(risks.id, risk.id));
    const details = {
      acceptanceId: acceptance.id,
      untilOn: acceptance.untilOn,
      band: acceptance.bandCode,
      score: acceptance.score,
      signatureRequired: runId !== null,
      runId,
    };
    await addEvent(tx, auth, risk.id, 'accepted', details);
    await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_accepted', 'risk', risk.id, details);
    await this.notifier.send(tx, auth.tenant.id, risk, auth.user.id, [
      { kind: 'risk_acceptance_decided', to: [acceptance.requestedBy, risk.ownerId], data: { outcome: 'accepted', until: acceptance.untilOn } },
    ]);
  }

  /**
   * The step of a run in progress that the caller would decide, checked:
   * 409 `not_in_approval` without one; `not_current_step` for an assignee
   * of a later step; 403 `not_assignee`; 403 `same_person` for the
   * requester, the risk's owner, or whoever decided an earlier step.
   */
  private async decision(tx: Transaction, auth: AuthContext, id: string, subject: Subject, revision: number, lock: boolean) {
    const viewer = await riskViewerOf(tx, auth);
    const [risk] = lock
      ? [await this.register.lock(tx, viewer, id)]
      : await tx
          .select()
          .from(risks)
          .where(and(eq(risks.id, id), visible(viewer)));
    if (!risk) throw new NotFoundException();
    if (risk.revision !== revision) throw stale();
    let acceptance: AcceptanceRow | null = null;
    let run: Run | null = null;
    let requester: string | null = null;
    if (subject === 'acceptance') {
      acceptance = await openAcceptance(tx, id, lock);
      if (acceptance?.status === 'in_approval') {
        run = await this.engine.current(tx, 'risk_acceptance', acceptance.id, { lock });
        requester = acceptance.requestedBy;
      }
    } else if (risk.status === 'open' && risk.closureRequestedAt) {
      run = await this.engine.current(tx, 'risk', id, { lock });
      requester = risk.closureRequestedBy;
    }
    const step = run ? this.engine.pendingStep(run) : null;
    if (!run || !step) throw new ConflictException({ code: 'not_in_approval' });
    const mine = (s: RunStep) => this.engine.isAssignee(viewer.assignment, s, risk.orgUnitId);
    if (!mine(step)) {
      if (run.steps.some((s) => s.status === 'waiting' && mine(s))) {
        throw new ConflictException({ code: 'not_current_step' });
      }
      throw new ForbiddenException({ code: 'not_assignee' });
    }
    if (requester === auth.user.id) throw new ForbiddenException({ code: 'same_person', reason: 'requested' });
    if (risk.ownerId === auth.user.id) throw new ForbiddenException({ code: 'same_person', reason: 'owner' });
    if (this.engine.decidersOf(run).includes(auth.user.id)) {
      throw new ForbiddenException({ code: 'same_person', reason: 'decided_earlier_step' });
    }
    return { viewer, risk: risk as RiskRow, acceptance, run, step, excluded: [requester!, risk.ownerId] };
  }

  /**
   * Approves the current step of an acceptance with the signer's
   * signature (meaning `risk_accepted`, or `reviewed` for a review step),
   * over the content put to them. After the last step, the risk is accepted.
   */
  async approveAcceptance(auth: AuthContext, id: string, input: { revision: number; password: string; comment?: string }, ip: string | null) {
    await this.tenantDb.withTenant(auth.tenant.id, (tx) => this.decision(tx, auth, id, 'acceptance', input.revision, false));
    await this.auth.confirmPassword(auth, input.password, 'risk_acceptance', ip);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { risk, acceptance, run, step, excluded } = await this.decision(tx, auth, id, 'acceptance', input.revision, true);
      const now = new Date();
      const signature = await this.signatures.sign(tx, auth.tenant.id, {
        userId: auth.user.id,
        meaning: step.kind === 'review' ? 'reviewed' : 'risk_accepted',
        subjectType: 'risk_acceptance',
        subjectId: acceptance!.id,
        content: acceptanceContent(risk, acceptance!),
      });
      const outcome = await this.engine.decide(tx, run, {
        userId: auth.user.id,
        outcome: 'approved',
        comment: input.comment ?? null,
        signatureId: signature.id,
        ctx: this.contextOf(risk),
        excluded,
        now,
        timeZone: auth.tenant.timeZone,
      });
      const details = {
        acceptanceId: acceptance!.id,
        runId: run.id,
        position: step.position,
        kind: step.kind,
        signatureId: signature.id,
        contentHash: signature.contentHash,
        commentGiven: !!input.comment,
      };
      await addEvent(tx, auth, id, 'acceptance_step_approved', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_acceptance_step_approved', 'risk', id, details);
      if (outcome.status === 'approved') {
        await this.accepted(tx, auth, risk, acceptance!, run.id);
      } else if (outcome.next) {
        await this.stepAssigned(tx, auth, risk, 'acceptance', outcome.next, outcome.nextAssignees);
      }
      await this.register.touch(tx, id);
      return this.answer(tx, auth, risk);
    });
  }

  /** Returns an acceptance from its current step, with a comment: the run ends. */
  returnAcceptance(auth: AuthContext, id: string, input: { revision: number; comment: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { risk, acceptance, run, step, excluded } = await this.decision(tx, auth, id, 'acceptance', input.revision, true);
      const now = new Date();
      await this.engine.decide(tx, run, {
        userId: auth.user.id,
        outcome: 'returned',
        comment: input.comment,
        signatureId: null,
        ctx: this.contextOf(risk),
        excluded,
        now,
        timeZone: auth.tenant.timeZone,
      });
      await tx
        .update(riskAcceptances)
        .set({ status: 'returned', decidedAt: now })
        .where(eq(riskAcceptances.id, acceptance!.id));
      const details = { acceptanceId: acceptance!.id, runId: run.id, position: step.position, commentGiven: true };
      await addEvent(tx, auth, id, 'acceptance_returned', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_acceptance_returned', 'risk', id, details);
      await this.notifier.send(tx, auth.tenant.id, risk, auth.user.id, [
        { kind: 'risk_acceptance_decided', to: [acceptance!.requestedBy, risk.ownerId], data: { outcome: 'returned' } },
      ]);
      await this.register.touch(tx, id);
      return this.answer(tx, auth, risk);
    });
  }

  /**
   * Withdraws an acceptance in approval, for its requester or a manager of
   * the risk, with a reason kept as a correctable note: the run ends.
   */
  withdrawAcceptance(auth: AuthContext, id: string, input: { revision: number; reason: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.register.lock(tx, viewer, id);
      if (risk.revision !== input.revision) throw stale();
      const acceptance = await openAcceptance(tx, id, true);
      if (acceptance?.status !== 'in_approval') throw new ConflictException({ code: 'not_in_approval' });
      if (acceptance.requestedBy !== auth.user.id && !roleOf(viewer, risk).manager) throw notYours();
      const now = new Date();
      const run = acceptance.approvalRunId ? await this.engine.current(tx, 'risk_acceptance', acceptance.id, { lock: true }) : null;
      if (run) await this.engine.cancel(tx, run, now);
      await tx
        .update(riskAcceptances)
        .set({ status: 'withdrawn', decidedAt: now })
        .where(eq(riskAcceptances.id, acceptance.id));
      const noteId = await writeNote(tx, { tenantId: auth.tenant.id, userId: auth.user.id }, id, 'withdraw_reason', input.reason);
      const details = { acceptanceId: acceptance.id, runId: run?.id ?? null, noteId };
      await addEvent(tx, auth, id, 'acceptance_withdrawn', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_acceptance_withdrawn', 'risk', id, details);
      await this.register.touch(tx, id);
      return this.register.view(tx, auth, viewer, id);
    });
  }

  // Closure and reopening.

  /**
   * Closes a risk on the register, for a manager of it, with a reason, and
   * the risk it is merged into if any (another open risk the caller reads:
   * 400 `unknown_risk`). Its open actions are completed or cancelled first
   * (409 `actions_open`). A risk whose closure needs a second signature
   * (`closureSignOffNeeded`) goes through the closure route (409 `no_route`,
   * `no_assignee`); any other is closed at once.
   */
  close(auth: AuthContext, id: string, input: { revision: number; reason: string; mergedIntoId?: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.register.lock(tx, viewer, id);
      if (!roleOf(viewer, risk).manager) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'open') throw new ConflictException({ code: 'not_on_register' });
      await assertNotInApproval(tx, risk);
      const mergedIntoId = input.mergedIntoId ?? null;
      if (mergedIntoId) {
        const [into] =
          mergedIntoId === id
            ? []
            : await tx
                .select({ id: risks.id })
                .from(risks)
                .where(and(eq(risks.id, mergedIntoId), eq(risks.status, 'open'), visible(viewer)));
        if (!into) throw new BadRequestException({ code: 'unknown_risk' });
      }
      if ((await this.register.openActions(tx, id)) > 0) throw new ConflictException({ code: 'actions_open' });
      const now = new Date();
      if (!risk.closureSignOffNeeded) {
        await tx
          .update(risks)
          .set({ closeReason: input.reason, mergedIntoId, updatedAt: now })
          .where(eq(risks.id, id));
        await this.closed(tx, auth, { ...risk, closeReason: input.reason, mergedIntoId }, null);
        await this.register.touch(tx, id);
        return this.register.view(tx, auth, viewer, id);
      }
      const route = await this.engine.routeFor(tx, 'risk_closure', null, null);
      if (!route) throw new ConflictException({ code: 'no_route' });
      const { run, assignees } = await this.engine.start(tx, auth.tenant.id, {
        routeId: route.id,
        subjectType: 'risk',
        subjectId: id,
        startedBy: auth.user.id,
        ctx: this.contextOf(risk),
        excluded: [auth.user.id, risk.ownerId],
        now,
        timeZone: auth.tenant.timeZone,
      });
      await tx
        .update(risks)
        .set({ closeReason: input.reason, mergedIntoId, closureRequestedBy: auth.user.id, closureRequestedAt: now, updatedAt: now })
        .where(eq(risks.id, id));
      const details = { runId: run.id, routeId: route.id, mergedIntoId, reasonGiven: true };
      await addEvent(tx, auth, id, 'closure_requested', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_closure_requested', 'risk', id, details);
      await this.stepAssigned(tx, auth, risk, 'closure', run.steps[0], assignees);
      await this.register.touch(tx, id);
      return this.register.view(tx, auth, viewer, id);
    });
  }

  /** A risk leaves the register: its owner and its committee are told. */
  private async closed(tx: Transaction, auth: AuthContext, risk: RiskRow, runId: string | null) {
    const now = new Date();
    await tx
      .update(risks)
      .set({ status: 'closed', closedBy: auth.user.id, closedAt: now, nextReviewOn: null, updatedAt: now })
      .where(eq(risks.id, risk.id));
    const details = { mergedIntoId: risk.mergedIntoId, reasonGiven: true, signedOff: runId !== null, runId };
    await addEvent(tx, auth, risk.id, 'closed', details);
    await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_closed', 'risk', risk.id, details);
    const members = risk.escalatedToCommitteeId ? await this.notifier.membersOf(tx, risk.escalatedToCommitteeId) : [];
    await this.notifier.send(tx, auth.tenant.id, risk, auth.user.id, [
      { kind: 'risk_closed', to: [risk.ownerId, risk.closureRequestedBy, ...members] },
    ]);
  }

  /**
   * Approves the current step of a closure with the signer's signature
   * (meaning `risk_closure_approved`, or `reviewed` for a review step).
   * After the last step, the risk is closed.
   */
  async approveClosure(auth: AuthContext, id: string, input: { revision: number; password: string; comment?: string }, ip: string | null) {
    await this.tenantDb.withTenant(auth.tenant.id, (tx) => this.decision(tx, auth, id, 'closure', input.revision, false));
    await this.auth.confirmPassword(auth, input.password, 'risk_closure', ip);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { risk, run, step, excluded } = await this.decision(tx, auth, id, 'closure', input.revision, true);
      // Nothing may have been left open since it was asked for.
      if ((await this.register.openActions(tx, id)) > 0) throw new ConflictException({ code: 'actions_open' });
      const now = new Date();
      const signature = await this.signatures.sign(tx, auth.tenant.id, {
        userId: auth.user.id,
        meaning: step.kind === 'review' ? 'reviewed' : 'risk_closure_approved',
        subjectType: 'risk',
        subjectId: id,
        content: closureContent(risk),
      });
      const outcome = await this.engine.decide(tx, run, {
        userId: auth.user.id,
        outcome: 'approved',
        comment: input.comment ?? null,
        signatureId: signature.id,
        ctx: this.contextOf(risk),
        excluded,
        now,
        timeZone: auth.tenant.timeZone,
      });
      const details = {
        runId: run.id,
        position: step.position,
        kind: step.kind,
        signatureId: signature.id,
        contentHash: signature.contentHash,
        commentGiven: !!input.comment,
      };
      await addEvent(tx, auth, id, 'closure_step_approved', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_closure_step_approved', 'risk', id, details);
      if (outcome.status === 'approved') {
        await this.closed(tx, auth, risk, run.id);
      } else if (outcome.next) {
        await this.stepAssigned(tx, auth, risk, 'closure', outcome.next, outcome.nextAssignees);
      }
      await this.register.touch(tx, id);
      return this.answer(tx, auth, risk);
    });
  }

  /** Returns a closure from its current step, with a comment: the risk stays open. */
  returnClosure(auth: AuthContext, id: string, input: { revision: number; comment: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { risk, run, step, excluded } = await this.decision(tx, auth, id, 'closure', input.revision, true);
      const now = new Date();
      await this.engine.decide(tx, run, {
        userId: auth.user.id,
        outcome: 'returned',
        comment: input.comment,
        signatureId: null,
        ctx: this.contextOf(risk),
        excluded,
        now,
        timeZone: auth.tenant.timeZone,
      });
      await tx
        .update(risks)
        .set({ closureRequestedBy: null, closureRequestedAt: null, updatedAt: now })
        .where(eq(risks.id, id));
      const details = { runId: run.id, position: step.position, commentGiven: true };
      await addEvent(tx, auth, id, 'closure_returned', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_closure_returned', 'risk', id, details);
      await this.register.touch(tx, id);
      return this.answer(tx, auth, risk);
    });
  }

  /**
   * Reopens a closed risk, for a manager of it, with a reason kept as a
   * correctable note and a new current rating, on the matrix in use: a new
   * review day is set, and what follows a current rating follows.
   */
  reopen(auth: AuthContext, id: string, input: { revision: number; reason: string; current: RatingInput }) {
    assertLanguages(auth, [], [input.current.rationale]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const matrix = await matrixInUse(tx);
      const risk = await this.register.lock(tx, viewer, id);
      if (!roleOf(viewer, risk).manager) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'closed') throw new ConflictException({ code: 'not_closed' });
      const target = copyOf(risk, 'target');
      const keptTarget = target && target.matrixId === matrix.id ? target : null;
      const rated = this.register.rateAll(matrix, { current: input.current }, { current: null, target: keptTarget });
      const current = rated.current!;
      const tolerance = await this.register.toleranceOf(tx, risk.categoryId);
      if (rankOf(current.band) > rankOf(tolerance) && !keptTarget) {
        throw new BadRequestException({ code: 'target_required' });
      }
      const nextReviewOn = shiftDay(todayOf(auth), bandOf(matrix, current.band).reviewIntervalDays);
      await writeRatings(tx, auth, id, rated);
      const now = new Date();
      await tx
        .update(risks)
        .set({
          ...copyValues('current', current),
          status: 'open',
          nextReviewOn,
          closureRequestedBy: null,
          closureRequestedAt: null,
          updatedAt: now,
        })
        .where(eq(risks.id, id));
      const noteId = await writeNote(tx, { tenantId: auth.tenant.id, userId: auth.user.id }, id, 'reopen_reason', input.reason);
      const details = { noteId, current: short(current), nextReviewOn };
      await addEvent(tx, auth, id, 'reopened', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_reopened', 'risk', id, details);
      const reopened = { ...risk, status: 'open' as const, currentBand: current.band };
      const lapsed = await this.register.lapseIfRisen(tx, auth, reopened, current.score, current.band);
      await this.register.afterCurrent(
        tx,
        auth,
        risk,
        {
          band: current.band,
          targetBand: keptTarget?.band ?? null,
          treatment: risk.treatment,
          status: 'open',
          acceptanceId: lapsed ? null : risk.acceptanceId,
        },
        matrix,
      );
      await this.register.touch(tx, id);
      return this.register.view(tx, auth, viewer, id);
    });
  }

  // What waits for a signer.

  /**
   * The steps of acceptances and closures waiting for the caller now: those
   * they are an assignee of, that they may decide (not the requester, not
   * the risk's owner, not a decider of an earlier step), oldest first.
   */
  async stepsFor(tx: Transaction, auth: AuthContext, viewer: RiskViewer) {
    const me = auth.user.id;
    const { rows } = await tx.execute<{
      run_id: string;
      subject_type: string;
      acceptance_id: string | null;
      risk_id: string;
      reference: string;
      title: Localized;
      current_band: BandCode | null;
      position: number;
      kind: string;
      due_at: Date | null;
      requested_by: string;
      started_at: Date;
    }>(sql`
      select r.id as run_id, r.subject_type, a.id as acceptance_id, k.id as risk_id, k.reference, k.title,
        k.current_band, s.position, s.kind, s.due_at, r.started_by as requested_by, r.started_at
      from approval_run_steps s
      join approval_runs r on r.id = s.run_id
      left join ${riskAcceptances} a on r.subject_type = 'risk_acceptance' and a.id = r.subject_id
      join ${risks} k on k.id = case when r.subject_type = 'risk' then r.subject_id else a.risk_id end
      where r.status = 'in_progress' and s.status = 'pending'
        and r.subject_type in ('risk_acceptance', 'risk')
        and ${this.engine.assignedTo(viewer.assignment, sql`k.org_unit_id`, { assigneeUserId: sql`s.assignee_user_id`, assigneeRoleId: sql`s.assignee_role_id` })}
        and k.owner_id <> ${me} and r.started_by <> ${me}
        and not exists (select from approval_run_steps d where d.run_id = r.id and d.decided_by = ${me})
      order by s.due_at asc nulls last, r.started_at asc`);
    const now = Date.now();
    return rows.map((r) => ({
      subject: r.subject_type === 'risk' ? ('closure' as const) : ('acceptance' as const),
      runId: r.run_id,
      acceptanceId: r.acceptance_id,
      riskId: r.risk_id,
      reference: r.reference,
      title: r.title,
      currentBand: r.current_band,
      position: r.position,
      step: r.kind,
      dueAt: r.due_at ? new Date(r.due_at) : null,
      overdue: !!r.due_at && new Date(r.due_at).getTime() < now,
      requestedBy: r.requested_by,
      requestedAt: new Date(r.started_at),
    }));
  }

  /** "My approvals" (`GET /risks/approvals`), with the names of the requesters. */
  myApprovals(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const items = await this.stepsFor(tx, auth, viewer);
      return { items, ...(await namesOf(tx, { people: items.map((i) => i.requestedBy) })) };
    });
  }

  // The client's routes (risk settings).

  private routeFields = {
    id: approvalRoutes.id,
    name: approvalRoutes.name,
    subject: approvalRoutes.subject,
    variant: approvalRoutes.variant,
    active: approvalRoutes.active,
    revision: approvalRoutes.revision,
  };

  private async withSteps<T extends { id: string }>(tx: Transaction, list: T[]) {
    const ids = list.map((r) => r.id);
    const steps = ids.length
      ? await tx
          .select({
            routeId: approvalRouteSteps.routeId,
            position: approvalRouteSteps.position,
            kind: approvalRouteSteps.kind,
            userId: approvalRouteSteps.assigneeUserId,
            roleId: approvalRouteSteps.assigneeRoleId,
            dueInDays: approvalRouteSteps.dueInDays,
            userName: users.name,
            roleName: roles.name,
          })
          .from(approvalRouteSteps)
          .leftJoin(users, eq(users.id, approvalRouteSteps.assigneeUserId))
          .leftJoin(roles, eq(roles.id, approvalRouteSteps.assigneeRoleId))
          .where(inArray(approvalRouteSteps.routeId, ids))
          .orderBy(asc(approvalRouteSteps.position))
      : [];
    return list.map((route) => ({
      ...route,
      steps: steps.filter((s) => s.routeId === route.id).map(({ routeId: _r, ...s }) => s),
    }));
  }

  /** The acceptance and closure routes, for the risk settings. */
  routes(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const list = await tx
        .select(this.routeFields)
        .from(approvalRoutes)
        .where(inArray(approvalRoutes.subject, ['risk_acceptance', 'risk_closure']))
        .orderBy(asc(approvalRoutes.subject), asc(approvalRoutes.variant), asc(approvalRoutes.createdAt));
      return { items: await this.withSteps(tx, list) };
    });
  }

  private async route(tx: Transaction, id: string) {
    const list = await tx
      .select(this.routeFields)
      .from(approvalRoutes)
      .where(and(eq(approvalRoutes.id, id), inArray(approvalRoutes.subject, ['risk_acceptance', 'risk_closure'])));
    return (await this.withSteps(tx, list))[0];
  }

  /**
   * A route's steps: the last an approval (400 `last_step_must_approve`);
   * no person named twice (400 `same_person_in_two_steps`); a role only if
   * it includes `risks.approve` (400 `role_cannot_approve`), a person only
   * if active and holding it (400 `user_cannot_approve`).
   */
  private async assertSteps(tx: Transaction, steps: RiskRouteCreateInput['steps']) {
    if (steps[steps.length - 1].kind !== 'approve') throw new BadRequestException({ code: 'last_step_must_approve' });
    const named = steps.map((s) => s.userId).filter((u): u is string => !!u);
    const twice = named.find((u, i) => named.indexOf(u) !== i);
    if (twice) throw new BadRequestException({ code: 'same_person_in_two_steps', userId: twice });
    const roleIds = [...new Set(steps.map((s) => s.roleId).filter((r): r is string => !!r))];
    if (roleIds.length) {
      const found = await tx
        .select({ id: roles.id, permissions: roles.permissions })
        .from(roles)
        .where(inArray(roles.id, roleIds))
        .for('share');
      for (const id of roleIds) {
        const role = found.find((r) => r.id === id);
        if (!role) throw new BadRequestException({ code: 'unknown_role' });
        if (!role.permissions.includes(SIGNER)) throw new BadRequestException({ code: 'role_cannot_approve', roleId: id });
      }
    }
    for (const id of new Set(named)) {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, id),
            eq(users.status, 'active'),
            sql`exists (select from ${roleAssignments} ra join ${roles} r on r.id = ra.role_id
              where ra.user_id = ${users.id} and ${SIGNER} = any(r.permissions))`,
          ),
        );
      if (!user) throw new BadRequestException({ code: 'user_cannot_approve', userId: id });
    }
  }

  private async writeSteps(tx: Transaction, tenantId: string, routeId: string, steps: RiskRouteCreateInput['steps']) {
    await tx.delete(approvalRouteSteps).where(eq(approvalRouteSteps.routeId, routeId));
    await tx.insert(approvalRouteSteps).values(
      steps.map((s, i) => ({
        tenantId,
        routeId,
        position: i + 1,
        kind: s.kind,
        assigneeUserId: s.userId ?? null,
        assigneeRoleId: s.roleId ?? null,
        dueInDays: s.dueInDays,
      })),
    );
  }

  private assertName(auth: AuthContext, name: Localized | undefined) {
    if (name !== undefined && !fitsLanguages(name, auth.tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
  }

  /**
   * A route for acceptances of one band, or for closures. One active route
   * per band and per closure (409 `route_exists`).
   */
  async createRoute(auth: AuthContext, input: RiskRouteCreateInput) {
    this.assertName(auth, input.name);
    try {
      return await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
        await this.assertSteps(tx, input.steps);
        const [route] = await tx
          .insert(approvalRoutes)
          .values({ tenantId: auth.tenant.id, name: input.name, subject: input.subject, variant: input.variant, active: true })
          .returning({ id: approvalRoutes.id });
        await this.writeSteps(tx, auth.tenant.id, route.id, input.steps);
        await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_approval_route_created', 'approval_route', route.id, {
          subject: input.subject,
          variant: input.variant,
          name: input.name,
          steps: input.steps,
        });
        return this.route(tx, route.id);
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw new ConflictException({ code: 'route_exists' });
      throw e;
    }
  }

  /**
   * Changes a route, given its revision (409 `stale_route`). Runs in
   * progress keep the steps they copied; the change counts for requests
   * from now on.
   */
  async updateRoute(auth: AuthContext, id: string, input: RiskRouteUpdateInput) {
    this.assertName(auth, input.name);
    try {
      return await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
        const [before] = await tx
          .select({ name: approvalRoutes.name, active: approvalRoutes.active, revision: approvalRoutes.revision })
          .from(approvalRoutes)
          .where(and(eq(approvalRoutes.id, id), inArray(approvalRoutes.subject, ['risk_acceptance', 'risk_closure'])))
          .for('update');
        if (!before) throw new NotFoundException();
        if (before.revision !== input.revision) throw new ConflictException({ code: 'stale_route' });
        const { steps, revision: _revision, ...fields } = input;
        const changes: Record<string, unknown> = changesOf(before, fields);
        if (steps) {
          await this.assertSteps(tx, steps);
          const old = (await this.route(tx, id)).steps.map(({ userName: _u, roleName: _n, ...s }) => s);
          await this.writeSteps(tx, auth.tenant.id, id, steps);
          changes.steps = { from: old, to: steps };
        }
        if (Object.keys(changes).length > 0) {
          await tx
            .update(approvalRoutes)
            .set({ ...fields, revision: sql`${approvalRoutes.revision} + 1`, updatedAt: new Date() })
            .where(eq(approvalRoutes.id, id));
          await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_approval_route_updated', 'approval_route', id, changes);
        }
        return this.route(tx, id);
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw new ConflictException({ code: 'route_exists' });
      throw e;
    }
  }
}
