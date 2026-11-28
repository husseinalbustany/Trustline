import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNull, not, sql, type SQL } from 'drizzle-orm';
import { ActionsService, type ActionCaller, type ActionRow } from '../actions/actions.service.js';
import { ApprovalEngine, type Run } from '../approvals/approval-engine.service.js';
import { SignatureService } from '../approvals/signatures.js';
import type { Transaction } from '../database/client.js';
import {
  orgUnits,
  riskAcceptances,
  riskCategories,
  riskControls,
  riskEvents,
  riskIncidentLinks,
  riskNotes,
  riskRatings,
  riskReviews,
  risks,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import { shiftDay } from '../i18n/time-zones.js';
import { LinkedIncidents } from '../incidents/linked-incidents.js';
import { nextReference } from '../incidents/reference.js';
import { LinkedDocuments } from '../policies/linked-documents.js';
import { acceptanceColumns, assertNotInApproval, lapse, openAcceptance } from './acceptance.js';
import {
  aboveTolerance,
  addEvent,
  assertLanguages,
  beingTreated,
  copyOf,
  copyValues,
  isAbove,
  KINDS,
  listExtras,
  matrixInUse,
  namesOf,
  notesOf,
  notYours,
  patternOf,
  redacted,
  riskColumns,
  short,
  stale,
  standingOf,
  summaryOf,
  todayOf,
  writeNote,
  writeRatings,
  type Kind,
  type RatedWithRationale,
  type RiskRow,
} from './common.js';
import type { BandCode } from './defaults.js';
import { RiskEscalation } from './escalation.js';
import type {
  AcceptProposalInput,
  ControlCreateInput,
  ControlUpdateInput,
  CorrectionInput,
  CreateInput,
  ListInput,
  RateInput,
  RatingInput,
  UpdateInput,
} from './input.js';
import { bandOf, loadMatrix, matrixInUseId, rankOf, rate, type Matrix } from './matrix.js';
import { movesFor, type ApprovalMoves } from './moves.js';
import { isSerious, RiskNotifier } from './risk-notifier.js';
import { changesOf, riskSettingsOf } from './settings.service.js';
import { reaches, riskViewerOf, roleOf, visible, type RiskViewer } from './visibility.js';

const controlColumns = {
  id: riskControls.id,
  description: riskControls.description,
  kind: riskControls.kind,
  hierarchy: riskControls.hierarchy,
  ownerId: riskControls.ownerId,
  effectiveness: riskControls.effectiveness,
  assessedOn: riskControls.assessedOn,
  documentId: riskControls.documentId,
  active: riskControls.active,
  inactiveReason: riskControls.inactiveReason,
  createdBy: riskControls.createdBy,
  createdAt: riskControls.createdAt,
  updatedAt: riskControls.updatedAt,
  revision: riskControls.revision,
};

/** The statuses of an action whose owner reads its risk's summary (as visibility.ts). */
const READING_ACTION = ['open', 'in_progress', 'completed'];

/** The incident harm level offered as a starting impact (spec, "Ratings"). */
export const IMPACT_OF_HARM: Record<string, number | null> = {
  none: null,
  mild: 2,
  moderate: 3,
  severe: 4,
  death: 5,
};

/** A run as a risk's page shows it: its steps, with who decided and when. */
const runView = (run: Run | undefined) =>
  run
    ? {
        id: run.id,
        status: run.status,
        startedBy: run.startedBy,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        steps: run.steps.map((s) => ({
          position: s.position,
          kind: s.kind,
          assigneeUserId: s.assigneeUserId,
          assigneeRoleId: s.assigneeRoleId,
          status: s.status,
          dueAt: s.dueAt,
          decidedBy: s.decidedBy,
          decidedAt: s.decidedAt,
          comment: s.comment,
          signatureId: s.signatureId,
        })),
      }
    : null;

/**
 * The risk register (docs/specs/risk-management.md): risks, their ratings,
 * controls, reviews, actions, acceptances, closure, links and timeline. Who
 * sees and manages what is `visibility.ts`'s; every change is audited in
 * its transaction, written to the risk's timeline, and raises its revision.
 * Text people write is never copied into the trail or the timeline: a
 * reason is kept as a correctable note, named by its id (security reviews
 * 15 and 17).
 */
@Injectable()
export class RiskRegisterService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly documents: LinkedDocuments,
    private readonly engine: ActionsService,
    private readonly escalation: RiskEscalation,
    private readonly notifier: RiskNotifier,
    private readonly approvals: ApprovalEngine,
    private readonly signatures: SignatureService,
    private readonly incidents: LinkedIncidents,
  ) {}

  // Checks on what a body names, each 400 with a code.

  async assertUnit(tx: Transaction, unitId: string | null) {
    if (unitId === null) return;
    const [unit] = await tx
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(and(eq(orgUnits.id, unitId), eq(orgUnits.active, true)));
    if (!unit) throw new BadRequestException({ code: 'unknown_unit' });
  }

  private async categoryOf(tx: Transaction, categoryId: string) {
    const [category] = await tx
      .select({ id: riskCategories.id, toleranceBand: riskCategories.toleranceBand })
      .from(riskCategories)
      .where(and(eq(riskCategories.id, categoryId), eq(riskCategories.active, true)));
    if (!category) throw new BadRequestException({ code: 'unknown_category' });
    return category;
  }

  /** The tolerance of a risk's category, switched off or not. */
  async toleranceOf(tx: Transaction, categoryId: string) {
    const [category] = await tx
      .select({ toleranceBand: riskCategories.toleranceBand })
      .from(riskCategories)
      .where(eq(riskCategories.id, categoryId));
    return category.toleranceBand;
  }

  /** An owner is an active member of staff. */
  private async assertPerson(tx: Transaction, userId: string) {
    const [person] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, 'active')));
    if (!person) throw new BadRequestException({ code: 'unknown_owner' });
  }

  /**
   * A document linked as a control is one in force that the person linking
   * may read, while the policies module is on (security review 15, L1).
   */
  private async assertDocument(tx: Transaction, auth: AuthContext, id: string | null | undefined) {
    if (!id) return;
    const ok = auth.tenant.modules.includes('policies') && (await this.documents.linkable(tx, auth, id));
    if (!ok) throw new BadRequestException({ code: 'unknown_document' });
  }

  /**
   * "Accept" above tolerance comes only from a signed acceptance (security
   * review 17, L1): as a treatment chosen by hand it is for a risk within
   * tolerance (400 `acceptance_required`).
   */
  assertTreatment(treatment: string | null | undefined, current: BandCode | null, tolerance: BandCode) {
    if (treatment === 'accept' && current && rankOf(current) > rankOf(tolerance)) {
      throw new BadRequestException({ code: 'acceptance_required' });
    }
  }

  /**
   * The ratings a body gives, on the matrix in use: each within it (400
   * `level_out_of_range`); a target never above the current rating, nor a
   * current rating below the target, by score or by band, when either of
   * the two is being given (400 `target_above_current`). An inherent rating
   * alone is not held to it (security review 17).
   */
  rateAll(
    matrix: Matrix,
    given: Partial<Record<Kind, RatingInput | undefined>>,
    stored: { current: { score: number; band: BandCode } | null; target: { score: number; band: BandCode } | null } = {
      current: null,
      target: null,
    },
  ) {
    const rated: Partial<Record<Kind, RatedWithRationale>> = {};
    for (const kind of KINDS) {
      const r = given[kind];
      if (r) rated[kind] = { ...rate(matrix, r.likelihood, r.impact), rationale: r.rationale };
    }
    if ((rated.current || rated.target) && isAbove(rated.target ?? stored.target, rated.current ?? stored.current)) {
      throw new BadRequestException({ code: 'target_above_current' });
    }
    return rated;
  }

  /**
   * What opening a risk needs (spec, "Ratings"): a current rating; an
   * inherent one where the client requires it (400 `inherent_required`); a
   * target whenever the current rating is above tolerance (400
   * `target_required`).
   */
  private assertOpenable(
    rated: Partial<Record<Kind, RatedWithRationale>>,
    has: { inherent: boolean; target: boolean },
    inherentRequired: boolean,
    tolerance: BandCode,
  ) {
    if (inherentRequired && !rated.inherent && !has.inherent) {
      throw new BadRequestException({ code: 'inherent_required' });
    }
    if (rankOf(rated.current!.band) > rankOf(tolerance) && !rated.target && !has.target) {
      throw new BadRequestException({ code: 'target_required' });
    }
  }

  /**
   * Locks a risk the caller sees in full, for a change to it; 404 if they
   * may not. Whether they may make the change is the caller's to check, on
   * what is read here under the lock.
   */
  async lock(tx: Transaction, viewer: RiskViewer, id: string) {
    const [risk] = await tx
      .select(riskColumns)
      .from(risks)
      .where(and(eq(risks.id, id), visible(viewer)))
      .for('update');
    if (!risk) throw new NotFoundException();
    return risk;
  }

  /** What the actions engine needs to know of the caller, for this risk. */
  callerFor(auth: AuthContext, viewer: RiskViewer, risk: Pick<RiskRow, 'orgUnitId' | 'ownerId' | 'status'>): ActionCaller {
    const role = roleOf(viewer, risk);
    return {
      tenant: auth.tenant,
      userId: auth.user.id,
      manages: role.manager,
      ownsSource: risk.ownerId === auth.user.id,
      suspended: auth.tenant.subscription.status === 'suspended',
    };
  }

  /** How many open actions a risk has. */
  async openActions(tx: Transaction, riskId: string) {
    const list = await this.engine.listOf(tx, 'risk', riskId);
    return list.filter((a) => a.status === 'open' || a.status === 'in_progress').length;
  }

  // Reading.

  /**
   * The register as the caller sees it: open and proposed risks unless a
   * status is asked for, filtered and sorted, a page at a time, with the
   * names of the people, units, categories and committees they name.
   */
  list(auth: AuthContext, input: ListInput) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const today = todayOf(auth);
      const where = this.filters(viewer, input, today);
      const [{ total }] = await tx
        .select({ total: count() })
        .from(risks)
        .innerJoin(riskCategories, eq(riskCategories.id, risks.categoryId))
        .where(where);
      const order: SQL[] =
        input.sort === 'next_review'
          ? [sql`${risks.nextReviewOn} asc nulls last`, asc(risks.reference)]
          : input.sort === 'reference'
            ? [asc(risks.reference)]
            : input.sort === 'updated'
              ? [desc(risks.updatedAt), asc(risks.reference)]
              : [sql`${risks.currentScore} desc nulls last`, asc(risks.reference)];
      const rows = await this.rows(tx, today, where, order, input.pageSize, (input.page - 1) * input.pageSize);
      const inUse = await matrixInUseId(tx);
      return {
        items: rows.map((r) => summaryOf(r, today, inUse)),
        total,
        ...(await namesOf(tx, {
          people: rows.map((r) => r.ownerId),
          units: rows.map((r) => r.orgUnitId),
          categories: rows.map((r) => r.categoryId),
          committees: rows.map((r) => r.escalatedToCommitteeId),
        })),
      };
    });
  }

  /** Rows of `risks` with what a list row needs, under `where`. */
  rows(tx: Transaction, today: string, where: SQL, order: SQL[], limit: number, offset = 0) {
    return tx
      .select({ ...riskColumns, ...listExtras(today) })
      .from(risks)
      .innerJoin(riskCategories, eq(riskCategories.id, risks.categoryId))
      .where(where)
      .orderBy(...order)
      .limit(limit)
      .offset(offset);
  }

  private filters(v: RiskViewer, input: ListInput, today: string): SQL {
    const conditions: (SQL | undefined)[] = [visible(v)];
    conditions.push(input.status ? eq(risks.status, input.status) : inArray(risks.status, ['open', 'proposed']));
    if (input.unitId === 'whole') conditions.push(isNull(risks.orgUnitId));
    else if (input.unitId) conditions.push(unitAndBelow(input.unitId));
    if (input.categoryId) conditions.push(eq(risks.categoryId, input.categoryId));
    if (input.band) conditions.push(eq(risks.currentBand, input.band));
    if (input.ownerId) conditions.push(eq(risks.ownerId, input.ownerId));
    if (input.mine) conditions.push(eq(risks.ownerId, v.userId));
    if (input.committeeId) conditions.push(eq(risks.escalatedToCommitteeId, input.committeeId));
    if (input.aboveTolerance) conditions.push(aboveTolerance);
    if (input.notAddressed) conditions.push(and(aboveTolerance, not(beingTreated)));
    if (input.review === 'overdue') {
      conditions.push(sql`${risks.status} = 'open' and ${risks.nextReviewOn} < ${today}`);
    } else if (input.review === 'due') {
      conditions.push(sql`${risks.status} = 'open' and ${risks.nextReviewOn} between ${today} and ${shiftDay(today, 30)}`);
    }
    if (input.incidentId) {
      conditions.push(sql`exists (select from ${riskIncidentLinks} l
        where l.risk_id = ${risks.id} and l.incident_id = ${input.incidentId} and l.removed_at is null)`);
    }
    if (input.q) {
      const pattern = patternOf(input.q);
      conditions.push(sql`(
        ${risks.reference} ilike ${pattern}
        or exists (select from jsonb_each_text(${risks.title}) t where t.value ilike ${pattern})
        or exists (select from jsonb_each_text(${risks.cause}) t where t.value ilike ${pattern})
        or exists (select from jsonb_each_text(${risks.event}) t where t.value ilike ${pattern})
        or exists (select from jsonb_each_text(${risks.consequence}) t where t.value ilike ${pattern})
        or exists (select from unnest(${risks.keywords}) k where k ilike ${pattern}))`);
    }
    return and(...conditions)!;
  }

  detail(auth: AuthContext, id: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      return this.view(tx, auth, viewer, id);
    });
  }

  /**
   * The acceptances of a risk, newest first, each with its run and
   * signatures; its closure runs; and what the reader may do about them.
   */
  private async approvalsOf(tx: Transaction, auth: AuthContext, viewer: RiskViewer, r: RiskRow) {
    const acceptances = await tx
      .select(acceptanceColumns)
      .from(riskAcceptances)
      .where(eq(riskAcceptances.riskId, r.id))
      .orderBy(desc(riskAcceptances.requestedAt), desc(riskAcceptances.id));
    const runIds = acceptances.map((a) => a.approvalRunId).filter((x): x is string => !!x);
    const acceptanceRuns = new Map((await this.approvals.runs(tx, runIds)).map((run) => [run.id, run]));
    const closureRuns = await this.approvals.runsOf(tx, 'risk', [r.id]);
    const signed = [
      ...(await this.signatures.of(tx, 'risk_acceptance', acceptances.map((a) => a.id))),
      ...(await this.signatures.of(tx, 'risk', [r.id])),
    ];
    const me = auth.user.id;
    const role = roleOf(viewer, r);
    const inApproval = acceptances.find((a) => a.status === 'in_approval');
    const may = (run: Run | undefined, excluded: string[]) => {
      if (!run || run.status !== 'in_progress') return false;
      const step = this.approvals.pendingStep(run);
      return (
        !!step &&
        this.approvals.isAssignee(viewer.assignment, step, r.orgUnitId) &&
        !excluded.includes(me) &&
        !this.approvals.decidersOf(run).includes(me)
      );
    };
    const closureRun = closureRuns.find((x) => x.status === 'in_progress');
    const tolerance = await this.toleranceOf(tx, r.categoryId);
    const current = copyOf(r, 'current');
    const open = r.status === 'open';
    const moves: ApprovalMoves = {
      requestAcceptance:
        open &&
        (role.manager || role.owner) &&
        !!current &&
        rankOf(current.band) > rankOf(tolerance) &&
        !r.acceptanceId &&
        !inApproval &&
        !r.closureRequestedAt,
      withdrawAcceptance: !!inApproval && (inApproval.requestedBy === me || role.manager),
      decideAcceptance: !!inApproval && may(acceptanceRuns.get(inApproval.approvalRunId ?? ''), [inApproval.requestedBy, r.ownerId]),
      close: open && role.manager && !r.closureRequestedAt && !inApproval ? (r.closureSignOffNeeded ? 'request_closure' : 'close') : null,
      decideClosure: may(closureRun, [r.closureRequestedBy ?? '', r.ownerId]),
      closureRequested: open && r.closureRequestedAt !== null,
      reopen: r.status === 'closed' && role.manager,
      linkIncident: open && role.manager && auth.tenant.modules.includes('incidents'),
      acceptancePending: !!inApproval,
    };
    return {
      moves,
      acceptances: acceptances.map((a) => ({
        ...a,
        run: runView(a.approvalRunId ? acceptanceRuns.get(a.approvalRunId) : undefined),
        signatures: signed.filter((s) => s.subjectId === a.id),
      })),
      closure:
        r.closureRequestedAt || closureRuns.length || r.status === 'closed'
          ? {
              requestedBy: r.closureRequestedBy,
              requestedAt: r.closureRequestedAt,
              closeReason: r.closeReason,
              mergedIntoId: r.mergedIntoId,
              closedBy: r.closedBy,
              closedAt: r.closedAt,
              runs: closureRuns.map((x) => runView(x)),
              signatures: signed.filter((s) => s.subjectId === r.id),
            }
          : null,
    };
  }

  /**
   * The incidents linked to a risk, while the incidents module is on (else
   * null): those the reader sees in full, with the kind of link; how many
   * others there are, with nothing else; and how many happened in the last
   * 12 months. Never who reported one, how, or whether anonymously.
   */
  private async incidentsOf(tx: Transaction, auth: AuthContext, riskId: string) {
    if (!auth.tenant.modules.includes('incidents')) return null;
    const links = await tx
      .select({
        id: riskIncidentLinks.id,
        incidentId: riskIncidentLinks.incidentId,
        kind: riskIncidentLinks.kind,
        note: riskIncidentLinks.note,
        linkedBy: riskIncidentLinks.linkedBy,
        linkedAt: riskIncidentLinks.linkedAt,
      })
      .from(riskIncidentLinks)
      .where(and(eq(riskIncidentLinks.riskId, riskId), isNull(riskIncidentLinks.removedAt)))
      .orderBy(asc(riskIncidentLinks.linkedAt));
    const described = await this.incidents.describe(tx, auth, links.map((l) => l.incidentId));
    const shown = new Map(described.items.map((i) => [i.id, i]));
    const yearAgo = new Date(Date.now() - 365 * 86_400_000);
    return {
      items: links
        .filter((l) => shown.has(l.incidentId))
        .map((l) => ({ linkId: l.id, kind: l.kind, note: l.note, linkedBy: l.linkedBy, linkedAt: l.linkedAt, incident: shown.get(l.incidentId)! })),
      hidden: described.hidden,
      last12Months: await this.incidents.since(tx, links.map((l) => l.incidentId), yearAgo),
      categories: described.categories,
    };
  }

  /**
   * Everything about a risk its reader may see, with what they may do next
   * (`moves`), in the caller's transaction. An owner of one of its actions
   * who reads it no other way gets its summary only (`access: 'summary'`):
   * reference, title, status, current band and their own actions. 404 for
   * anyone else.
   */
  async view(tx: Transaction, auth: AuthContext, viewer: RiskViewer, id: string) {
    const today = todayOf(auth);
    const [r] = await this.rows(tx, today, and(eq(risks.id, id), visible(viewer))!, [], 1);
    if (!r) return this.summaryView(tx, auth, viewer, id);
    const ratings = await tx
      .select({
        id: riskRatings.id,
        kind: riskRatings.kind,
        likelihood: riskRatings.likelihood,
        impact: riskRatings.impact,
        score: riskRatings.score,
        band: riskRatings.bandCode,
        matrixId: riskRatings.matrixId,
        rationale: riskRatings.rationale,
        ratedBy: riskRatings.ratedBy,
        ratedAt: riskRatings.ratedAt,
        reviewId: riskRatings.reviewId,
      })
      .from(riskRatings)
      .where(eq(riskRatings.riskId, id))
      .orderBy(desc(riskRatings.ratedAt), desc(riskRatings.id));
    const controls = await tx
      .select(controlColumns)
      .from(riskControls)
      .where(eq(riskControls.riskId, id))
      .orderBy(desc(riskControls.active), asc(riskControls.createdAt));
    const reviews = await tx
      .select({
        id: riskReviews.id,
        dueOn: riskReviews.dueOn,
        reviewedOn: riskReviews.reviewedOn,
        reviewedBy: riskReviews.reviewedBy,
        committeeId: riskReviews.committeeId,
        outcome: riskReviews.outcome,
        comment: riskReviews.comment,
        nextReviewOn: riskReviews.nextReviewOn,
        late: riskReviews.late,
        createdAt: riskReviews.createdAt,
      })
      .from(riskReviews)
      .where(eq(riskReviews.riskId, id))
      .orderBy(desc(riskReviews.createdAt), desc(riskReviews.id));
    const events = await tx
      .select({
        id: riskEvents.id,
        kind: riskEvents.kind,
        actorId: riskEvents.actorId,
        occurredAt: riskEvents.occurredAt,
        details: riskEvents.details,
      })
      .from(riskEvents)
      .where(eq(riskEvents.riskId, id))
      .orderBy(asc(riskEvents.occurredAt), asc(riskEvents.id));
    const notes = await notesOf(tx, id);
    const actionRows = await this.engine.listOf(tx, 'risk', id);
    const inUse = await loadMatrix(tx, { inUse: true });
    const role = roleOf(viewer, r);
    const suspended = auth.tenant.subscription.status === 'suspended';
    const caller = this.callerFor(auth, viewer, r);
    // A linked document is named only while the policies module is on, and
    // only as its reader may be told of it (security review 15, L1).
    const documents = auth.tenant.modules.includes('policies')
      ? await this.documents.describe(
          tx,
          auth,
          controls.map((c) => c.documentId).filter((d): d is string => !!d),
        )
      : {};
    let deEscalate = false;
    if (r.escalatedToCommitteeId && inUse && r.status === 'open') {
      const mayTake = role.member || covers(auth, 'risks.manage', null);
      const committees = await this.escalation.committees(tx);
      const threshold = this.escalation.thresholdRank(inUse, committees, r.escalatedToCommitteeId);
      const current = copyOf(r, 'current');
      deEscalate = mayTake && (threshold === null || !current || rankOf(current.band) < threshold);
    }
    const approvals = await this.approvalsOf(tx, auth, viewer, r);
    const incidentPanel = await this.incidentsOf(tx, auth, id);
    const mentioned = (key: string) =>
      events
        .flatMap((e) => {
          const value = e.details?.[key];
          if (value && typeof value === 'object') {
            const change = value as { from?: unknown; to?: unknown };
            return [change.from, change.to];
          }
          return [value];
        })
        .filter((v): v is string => typeof v === 'string');
    const inherent = copyOf(r, 'inherent');
    const current = copyOf(r, 'current');
    return {
      access: 'full' as const,
      ...summaryOf(r, today, inUse?.id ?? null),
      cause: r.cause,
      event: r.event,
      consequence: r.consequence,
      source: r.source,
      treatment: r.treatment,
      targetOn: r.targetOn,
      references: r.references,
      keywords: r.keywords,
      escalatedAt: r.escalatedAt,
      highestBand: r.highestBand,
      closureSignOffNeeded: r.closureSignOffNeeded,
      // Accepted with a warning: new facts can show the inherent rating was
      // too low (spec, "Ratings").
      currentAboveInherent: !!inherent && !!current && current.score > inherent.score,
      rejectedBy: r.rejectedBy,
      rejectedAt: r.rejectedAt,
      rejectReason: r.rejectReason,
      acceptanceId: r.acceptanceId,
      createdBy: r.createdBy,
      createdAt: r.createdAt,
      matrixId: inUse?.id ?? null,
      revision: r.revision,
      moves: movesFor(r, { ...role, userId: auth.user.id, deEscalate }, suspended, approvals.moves),
      ratings,
      controls: controls.map((c) => {
        const document = c.documentId ? (documents[c.documentId] ?? null) : null;
        return {
          ...c,
          document,
          // The procedure behind it retired, or past its review date (step 7);
          // nothing of a restricted document the reader may not open.
          flag:
            !c.active || !document || (document.restricted && document.number === null)
              ? null
              : document.status === 'retired'
                ? ('document_retired' as const)
                : document.pastReview
                  ? ('document_past_review' as const)
                  : null,
        };
      }),
      reviews,
      actions: actionRows.map((a) => this.engine.view(a, caller)),
      actionSummary: ActionsService.summaryOf(actionRows, today),
      acceptances: approvals.acceptances,
      closure: approvals.closure,
      incidents: incidentPanel,
      notes,
      events,
      ...(await namesOf(tx, {
        people: [
          r.ownerId,
          r.createdBy,
          r.rejectedBy,
          r.closureRequestedBy,
          r.closedBy,
          ...ratings.map((x) => x.ratedBy),
          ...controls.map((c) => c.ownerId),
          ...reviews.map((x) => x.reviewedBy),
          ...notes.map((n) => n.writtenBy),
          ...approvals.acceptances.flatMap((a) => [a.requestedBy, ...(a.run?.steps.map((s) => s.decidedBy) ?? [])]),
          ...(approvals.closure?.runs.flatMap((x) => x?.steps.map((s) => s.decidedBy) ?? []) ?? []),
          ...(incidentPanel?.items.map((i) => i.linkedBy) ?? []),
          ...actionRows.flatMap((a) => [a.ownerId, a.completedBy, a.verifiedBy]),
          ...events.map((e) => e.actorId),
          ...mentioned('ownerId'),
        ],
        units: [r.orgUnitId, ...actionRows.map((a) => a.orgUnitId), ...(incidentPanel?.items.map((i) => i.incident.orgUnitId) ?? []), ...mentioned('orgUnitId')],
        categories: [r.categoryId, ...mentioned('categoryId')],
        committees: [
          r.escalatedToCommitteeId,
          ...reviews.map((x) => x.committeeId),
          ...mentioned('committeeId'),
        ],
      })),
    };
  }

  /** The summary an action's owner reads of the risk it serves, or 404. */
  private async summaryView(tx: Transaction, auth: AuthContext, viewer: RiskViewer, id: string) {
    const [r] = await tx
      .select(riskColumns)
      .from(risks)
      .where(
        and(
          eq(risks.id, id),
          sql`exists (select from actions a where a.risk_id = ${risks.id} and a.owner_id = ${auth.user.id}
            and a.status in ('open', 'in_progress', 'completed'))`,
        ),
      );
    if (!r) throw new NotFoundException();
    const caller = this.callerFor(auth, viewer, r);
    const mine = (await this.engine.listOf(tx, 'risk', id)).filter(
      (a) => a.ownerId === auth.user.id && READING_ACTION.includes(a.status),
    );
    return {
      access: 'summary' as const,
      id: r.id,
      reference: r.reference,
      title: r.title,
      status: r.status,
      current: short(copyOf(r, 'current')),
      moves: [],
      actions: mine.map((a) => this.engine.view(a, caller)),
    };
  }

  // Writing.

  /**
   * What follows a current rating of an open risk: escalation and the
   * notice of a risk newly above tolerance with nothing addressing it.
   */
  async afterCurrent(
    tx: Transaction,
    auth: AuthContext,
    before: RiskRow,
    after: { band: BandCode; targetBand: BandCode | null; treatment: string | null; status: string; acceptanceId: string | null },
    matrix: Matrix,
  ) {
    const tolerance = await this.toleranceOf(tx, before.categoryId);
    const open = await this.openActions(tx, before.id);
    await this.escalation.afterCurrentRating(
      tx,
      { tenantId: auth.tenant.id, actorId: auth.user.id },
      { ...before, status: after.status },
      {
        before: before.status === 'open' ? standingOf(before, tolerance, open) : null,
        after: standingOf(
          { currentBand: after.band, targetBand: after.targetBand, treatment: after.treatment, acceptanceId: after.acceptanceId },
          tolerance,
          open,
        ),
      },
      after.band,
      matrix,
    );
  }

  /**
   * An acceptance in force ends when the current score rises above the
   * score it accepted. Returns whether it lapsed.
   */
  async lapseIfRisen(tx: Transaction, auth: AuthContext, risk: RiskRow, score: number, band: BandCode) {
    if (!risk.acceptanceId) return false;
    const accepted = await openAcceptance(tx, risk.id, true);
    if (!accepted || accepted.status !== 'accepted' || score <= accepted.score) return false;
    await lapse(tx, { provisioning: this.provisioning, notifier: this.notifier }, auth.tenant.id, accepted, { ...risk, currentBand: band }, 'score_risen');
    return true;
  }

  /**
   * Adds a risk to the register of a unit, or of the whole organization
   * (`orgUnitId` null), for someone who manages risks there (403
   * otherwise). With a current rating it is opened, and needs what opening
   * needs; without one it is proposed, for another manager to take onto
   * the register.
   *
   * Raised from an incident (`fromIncidentId`, step 7), by anyone who sees
   * the incident in full (400 `unknown_incident` otherwise, for one of
   * another client alike): it is opened if its author manages risks there
   * and gives a current rating, and is proposed otherwise; the managers of
   * the unit are told of a proposal. The link is made with it. While the
   * subscription is suspended, only that, as a proposal.
   */
  create(auth: AuthContext, input: CreateInput) {
    assertLanguages(
      auth,
      [input.title],
      [input.cause, input.event, input.consequence, input.current?.rationale, input.inherent?.rationale, input.target?.rationale],
    );
    const suspended = auth.tenant.subscription.status === 'suspended';
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      await this.assertUnit(tx, input.orgUnitId);
      const manager = reaches(viewer.manageReach, input.orgUnitId);
      let incident: { id: string; reference: string } | null = null;
      if (input.fromIncidentId) {
        incident = auth.tenant.modules.includes('incidents')
          ? await this.incidents.forLinking(tx, auth, input.fromIncidentId)
          : null;
        if (!incident) throw new BadRequestException({ code: 'unknown_incident' });
      } else if (!manager) {
        throw notYours();
      }
      if (suspended && (!incident || (manager && input.current))) {
        throw new ForbiddenException({ code: 'subscription_suspended' });
      }
      const category = await this.categoryOf(tx, input.categoryId);
      await this.assertPerson(tx, input.ownerId);
      const matrix = await matrixInUse(tx);
      const rated = this.rateAll(matrix, input);
      const status = rated.current && manager ? 'open' : 'proposed';
      this.assertTreatment(input.treatment, rated.current?.band ?? null, category.toleranceBand);
      if (status === 'open') {
        const { inherentRequired } = await riskSettingsOf(tx);
        this.assertOpenable(rated, { inherent: false, target: false }, inherentRequired, category.toleranceBand);
      }
      const today = todayOf(auth);
      const nextReviewOn =
        status === 'open' ? shiftDay(today, bandOf(matrix, rated.current!.band).reviewIntervalDays) : null;
      const reference = await nextReference(tx, auth.tenant.id, 'RSK', Number(today.slice(0, 4)));
      const source = incident ? 'incident' : 'manual';
      const [created] = await tx
        .insert(risks)
        .values({
          tenantId: auth.tenant.id,
          reference,
          orgUnitId: input.orgUnitId,
          categoryId: input.categoryId,
          title: input.title,
          cause: input.cause!,
          event: input.event!,
          consequence: input.consequence!,
          ownerId: input.ownerId,
          status,
          source,
          treatment: input.treatment,
          targetOn: input.targetOn,
          references: input.references,
          keywords: input.keywords,
          nextReviewOn,
          createdBy: auth.user.id,
          ...KINDS.reduce((all, k) => (rated[k] ? { ...all, ...copyValues(k, rated[k]) } : all), {}),
        })
        .returning(riskColumns);
      await writeRatings(tx, auth, created.id, rated);
      const ratings = Object.fromEntries(KINDS.filter((k) => rated[k]).map((k) => [k, short(rated[k]!)]));
      await addEvent(tx, auth, created.id, 'created', { status, source, ratings });
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_created', 'risk', created.id, {
        reference,
        source,
        status,
        orgUnitId: input.orgUnitId,
        categoryId: input.categoryId,
        ownerId: input.ownerId,
        treatment: input.treatment,
        targetOn: input.targetOn,
        ratings,
        nextReviewOn,
        ...(incident ? { incidentId: incident.id, incidentReference: incident.reference, linkKind: input.linkKind } : {}),
      });
      if (incident) {
        const [link] = await tx
          .insert(riskIncidentLinks)
          .values({ tenantId: auth.tenant.id, riskId: created.id, incidentId: incident.id, kind: input.linkKind, linkedBy: auth.user.id })
          .returning({ id: riskIncidentLinks.id });
        const details = { linkId: link.id, incidentId: incident.id, incidentReference: incident.reference, kind: input.linkKind, noteGiven: false };
        await addEvent(tx, auth, created.id, 'incident_linked', details);
        await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_incident_linked', 'risk', created.id, details);
      }
      const notified = { id: created.id, reference, currentBand: rated.current?.band ?? null };
      if (status === 'open') {
        await this.notifier.send(tx, auth.tenant.id, notified, auth.user.id, [
          { kind: 'risk_owner_assigned', to: [input.ownerId] },
        ]);
        await this.afterCurrent(
          tx,
          auth,
          { ...created, status: 'proposed' },
          { band: rated.current!.band, targetBand: rated.target?.band ?? null, treatment: input.treatment, status, acceptanceId: null },
          matrix,
        );
      } else if (incident) {
        // A proposal from an incident: the managers of its unit are told.
        const managers = await this.notifier.managersOf(tx, input.orgUnitId);
        await this.notifier.send(tx, auth.tenant.id, notified, auth.user.id, [
          { kind: 'risk_proposed', to: managers.filter((m) => m !== auth.user.id) },
        ]);
      }
      // A proposal raised by someone who does not manage risks there is
      // read by them (as its author) and by those managers.
      return this.view(tx, auth, viewer, created.id);
    });
  }

  /**
   * Changes a risk's details, for a manager of it, given the revision the
   * caller read (409 `stale_risk`). A change of owner, unit or category
   * needs a reason (400 `reason_required`), kept as a correctable note;
   * moving it to another unit needs `risks.manage` over both (403). Only a
   * risk on the register or proposed changes (409 `not_editable`); its
   * title, category and unit not while an acceptance is in approval, and
   * nothing while a closure is (409). A change of category ends an
   * acceptance in force.
   */
  update(auth: AuthContext, id: string, input: UpdateInput) {
    assertLanguages(auth, [input.title], [input.cause, input.event, input.consequence]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.lock(tx, viewer, id);
      if (!roleOf(viewer, risk).manager) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'open' && risk.status !== 'proposed') {
        throw new ConflictException({ code: 'not_editable' });
      }
      const { revision: _revision, reason, ...fields } = input;
      const changes = changesOf(risk, fields);
      if (Object.keys(changes).length === 0) return this.view(tx, auth, viewer, id);
      await assertNotInApproval(tx, risk, {
        acceptance: !!(changes.title || changes.categoryId || changes.orgUnitId),
      });
      if ((changes.ownerId || changes.orgUnitId || changes.categoryId) && !reason) {
        throw new BadRequestException({ code: 'reason_required' });
      }
      if (changes.orgUnitId) {
        await this.assertUnit(tx, fields.orgUnitId ?? null);
        if (!reaches(viewer.manageReach, fields.orgUnitId ?? null)) throw notYours();
      }
      const tolerance = changes.categoryId
        ? (await this.categoryOf(tx, fields.categoryId!)).toleranceBand
        : await this.toleranceOf(tx, risk.categoryId);
      if (changes.treatment) this.assertTreatment(fields.treatment, risk.currentBand, tolerance);
      if (changes.ownerId) await this.assertPerson(tx, fields.ownerId!);
      const set = Object.fromEntries(Object.keys(changes).map((k) => [k, fields[k as keyof typeof fields]]));
      await tx
        .update(risks)
        .set({ ...set, revision: sql`${risks.revision} + 1`, updatedAt: new Date() })
        .where(eq(risks.id, id));
      const noteId = reason
        ? await writeNote(tx, { tenantId: auth.tenant.id, userId: auth.user.id }, id, 'change_reason', reason)
        : null;
      const details = { ...redacted(changes), ...(noteId ? { noteId } : {}) };
      await addEvent(tx, auth, id, 'updated', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_updated', 'risk', id, details);
      if (changes.categoryId && risk.acceptanceId) {
        const accepted = await openAcceptance(tx, id, true);
        if (accepted?.status === 'accepted') {
          await lapse(tx, { provisioning: this.provisioning, notifier: this.notifier }, auth.tenant.id, accepted, risk, 'category_changed');
        }
      }
      if (changes.ownerId && risk.status === 'open') {
        await this.notifier.send(tx, auth.tenant.id, risk, auth.user.id, [
          { kind: 'risk_owner_assigned', to: [fields.ownerId!] },
        ]);
      }
      return this.view(tx, auth, viewer, id);
    });
  }

  /**
   * Records a rating, a new row every time, for the risk's owner (while it
   * is on the register) or a manager, given the revision read (409
   * `stale_risk`). On the matrix in use (400 `level_out_of_range`); a target
   * never above the current rating, nor a current rating below the target
   * (400 `target_above_current`). A current rating that puts the risk in a
   * band with a shorter review interval brings its next review forward; one
   * that puts it in a band with a committee escalates it; one above the
   * score an acceptance in force accepted ends it. The current rating is
   * fixed while an acceptance is in approval, and nothing is rated while a
   * closure is (409). While the subscription is suspended, only a current
   * rating of a risk on the register (403 `subscription_suspended`).
   */
  rate(auth: AuthContext, id: string, input: RateInput) {
    assertLanguages(auth, [], [input.rationale]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      // The matrix before the risk, in the order putting a version in use
      // takes them, so the two never wait on each other.
      const matrix = await matrixInUse(tx);
      const risk = await this.lock(tx, viewer, id);
      const role = roleOf(viewer, risk);
      if (!role.manager && !role.owner) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'open' && risk.status !== 'proposed') {
        throw new ConflictException({ code: 'not_editable' });
      }
      // What `moves` offers while suspended, nothing more (security review 15).
      if (auth.tenant.subscription.status === 'suspended' && (risk.status !== 'open' || input.kind !== 'current')) {
        throw new ForbiddenException({ code: 'subscription_suspended' });
      }
      await assertNotInApproval(tx, risk, { acceptance: input.kind === 'current' });
      const before = copyOf(risk, input.kind);
      const current = copyOf(risk, 'current');
      const rated = this.rateAll(matrix, { [input.kind]: input }, { current, target: copyOf(risk, 'target') })[input.kind]!;
      let nextReviewOn = risk.nextReviewOn;
      if (input.kind === 'current' && risk.status === 'open') {
        const interval = bandOf(matrix, rated.band).reviewIntervalDays;
        const was = current ? bandOf(matrix, current.band).reviewIntervalDays : Infinity;
        const latest = shiftDay(todayOf(auth), interval);
        if (interval < was && (!nextReviewOn || latest < nextReviewOn)) nextReviewOn = latest;
      }
      await writeRatings(tx, auth, id, { [input.kind]: rated });
      await tx
        .update(risks)
        .set({ ...copyValues(input.kind, rated), nextReviewOn, revision: sql`${risks.revision} + 1`, updatedAt: new Date() })
        .where(eq(risks.id, id));
      const details = {
        kind: input.kind,
        from: short(before),
        to: short(rated),
        matrixId: matrix.id,
        ...(nextReviewOn !== risk.nextReviewOn ? { nextReviewOn } : {}),
      };
      await addEvent(tx, auth, id, 'rated', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_rated', 'risk', id, details);
      if (input.kind === 'current') {
        const lapsed = await this.lapseIfRisen(tx, auth, risk, rated.score, rated.band);
        await this.afterCurrent(
          tx,
          auth,
          risk,
          {
            band: rated.band,
            targetBand: risk.targetBand,
            treatment: risk.treatment,
            status: risk.status,
            acceptanceId: lapsed ? null : risk.acceptanceId,
          },
          matrix,
        );
      }
      return this.view(tx, auth, viewer, id);
    });
  }

  /**
   * Takes a proposed risk onto the register, for a manager of it other than
   * the one who raised it (403 `same_person`): names its owner and gives its
   * current rating, with what opening needs.
   */
  acceptProposal(auth: AuthContext, id: string, input: AcceptProposalInput) {
    assertLanguages(auth, [], [input.current.rationale, input.inherent?.rationale, input.target?.rationale]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const matrix = await matrixInUse(tx);
      const risk = await this.lock(tx, viewer, id);
      if (!roleOf(viewer, risk).manager) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'proposed') throw new ConflictException({ code: 'not_proposed' });
      if (risk.createdBy === auth.user.id) throw new ForbiddenException({ code: 'same_person' });
      await this.assertPerson(tx, input.ownerId);
      const tolerance = await this.toleranceOf(tx, risk.categoryId);
      const target = copyOf(risk, 'target');
      // A target already given stands only on the matrix in use and not
      // above the new current rating.
      const keptTarget = !!target && target.matrixId === matrix.id;
      const rated = this.rateAll(matrix, input, { current: null, target: input.target || !keptTarget ? null : target });
      if (target && !rated.target && !keptTarget) {
        throw new BadRequestException({ code: 'target_above_current' });
      }
      this.assertTreatment(risk.treatment, rated.current!.band, tolerance);
      const { inherentRequired } = await riskSettingsOf(tx);
      this.assertOpenable(rated, { inherent: !!copyOf(risk, 'inherent'), target: keptTarget }, inherentRequired, tolerance);
      const nextReviewOn = shiftDay(todayOf(auth), bandOf(matrix, rated.current!.band).reviewIntervalDays);
      await writeRatings(tx, auth, id, rated);
      await tx
        .update(risks)
        .set({
          ...KINDS.reduce((all, k) => (rated[k] ? { ...all, ...copyValues(k, rated[k]) } : all), {}),
          ownerId: input.ownerId,
          status: 'open',
          nextReviewOn,
          revision: sql`${risks.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(risks.id, id));
      const details = {
        ownerId: risk.ownerId === input.ownerId ? input.ownerId : { from: risk.ownerId, to: input.ownerId },
        ratings: Object.fromEntries(KINDS.filter((k) => rated[k]).map((k) => [k, short(rated[k]!)])),
        nextReviewOn,
      };
      await addEvent(tx, auth, id, 'proposal_accepted', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_proposal_accepted', 'risk', id, details);
      await this.notifier.send(tx, auth.tenant.id, { ...risk, currentBand: rated.current!.band }, auth.user.id, [
        { kind: 'risk_owner_assigned', to: [input.ownerId] },
      ]);
      await this.afterCurrent(
        tx,
        auth,
        { ...risk, ownerId: input.ownerId },
        {
          band: rated.current!.band,
          targetBand: rated.target?.band ?? (keptTarget ? target.band : null),
          treatment: risk.treatment,
          status: 'open',
          acceptanceId: null,
        },
        matrix,
      );
      return this.view(tx, auth, viewer, id);
    });
  }

  /**
   * Does not take a proposed risk onto the register, with a reason, kept on
   * the risk (correctable) and recorded in the trail only as given.
   */
  rejectProposal(auth: AuthContext, id: string, input: { reason: string; revision: number }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.lock(tx, viewer, id);
      if (!roleOf(viewer, risk).manager) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'proposed') throw new ConflictException({ code: 'not_proposed' });
      await tx
        .update(risks)
        .set({
          status: 'rejected',
          rejectedBy: auth.user.id,
          rejectedAt: new Date(),
          rejectReason: input.reason,
          revision: sql`${risks.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(risks.id, id));
      await addEvent(tx, auth, id, 'proposal_rejected', { reasonGiven: true });
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_proposal_rejected', 'risk', id, {
        reasonGiven: true,
      });
      return this.view(tx, auth, viewer, id);
    });
  }

  // Controls.

  /** 400 `assessed_in_future` for a day after today. */
  private assessedOn(auth: AuthContext, effectiveness: string, given: string | null | undefined, before: string | null = null) {
    const today = todayOf(auth);
    if (given && given > today) throw new BadRequestException({ code: 'assessed_in_future' });
    if (effectiveness === 'not_assessed') return given ?? null;
    return given ?? before ?? today;
  }

  /** Raises a risk's revision for a change to what belongs to it. */
  async touch(tx: Transaction, id: string) {
    const [{ revision }] = await tx
      .update(risks)
      .set({ revision: sql`${risks.revision} + 1`, updatedAt: new Date() })
      .where(eq(risks.id, id))
      .returning({ revision: risks.revision });
    return revision;
  }

  /**
   * Adds a control to a risk, for its owner or a manager, given the risk's
   * revision. Its document, if any, is one in force of the client's library
   * that the person may read (400 `unknown_document`). Not while a closure
   * waits for its signature (409 `closure_in_progress`).
   */
  addControl(auth: AuthContext, id: string, input: ControlCreateInput) {
    assertLanguages(auth, [], [input.description]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.lock(tx, viewer, id);
      const role = roleOf(viewer, risk);
      if (!role.manager && !role.owner) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      if (risk.status !== 'open' && risk.status !== 'proposed') {
        throw new ConflictException({ code: 'not_editable' });
      }
      await assertNotInApproval(tx, risk, { acceptance: false });
      await this.assertPerson(tx, input.ownerId);
      await this.assertDocument(tx, auth, input.documentId);
      const { revision: _revision, ...fields } = input;
      const [control] = await tx
        .insert(riskControls)
        .values({
          ...fields,
          description: input.description!,
          assessedOn: this.assessedOn(auth, input.effectiveness, input.assessedOn),
          tenantId: auth.tenant.id,
          riskId: id,
          createdBy: auth.user.id,
        })
        .returning(controlColumns);
      const riskRevision = await this.touch(tx, id);
      const details = {
        controlId: control.id,
        kind: control.kind,
        hierarchy: control.hierarchy,
        ownerId: control.ownerId,
        effectiveness: control.effectiveness,
        assessedOn: control.assessedOn,
        documentId: control.documentId,
      };
      await addEvent(tx, auth, id, 'control_added', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_control_added', 'risk', id, details);
      return { ...control, riskRevision };
    });
  }

  /**
   * Changes a control, or switches it off with a reason (400
   * `reason_required`) kept on the control, for the risk's owner or a
   * manager, given the control's revision (409 `stale_control`). A new
   * effectiveness without a day is assessed today.
   */
  updateControl(auth: AuthContext, id: string, controlId: string, input: ControlUpdateInput) {
    assertLanguages(auth, [], [input.description]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.lock(tx, viewer, id);
      const role = roleOf(viewer, risk);
      if (!role.manager && !role.owner) throw notYours();
      const [before] = await tx
        .select(controlColumns)
        .from(riskControls)
        .where(and(eq(riskControls.id, controlId), eq(riskControls.riskId, id)))
        .for('update');
      if (!before) throw new NotFoundException();
      if (before.revision !== input.revision) throw new ConflictException({ code: 'stale_control' });
      if (risk.status !== 'open' && risk.status !== 'proposed') {
        throw new ConflictException({ code: 'not_editable' });
      }
      await assertNotInApproval(tx, risk, { acceptance: false });
      const { revision: _revision, reason, ...fields } = input;
      if (fields.active === false && before.active && !reason) {
        throw new BadRequestException({ code: 'reason_required' });
      }
      const effectiveness = fields.effectiveness ?? before.effectiveness;
      const assessedOn =
        fields.effectiveness !== undefined && fields.effectiveness !== before.effectiveness
          ? this.assessedOn(auth, effectiveness, fields.assessedOn)
          : fields.assessedOn !== undefined
            ? this.assessedOn(auth, effectiveness, fields.assessedOn, before.assessedOn)
            : before.assessedOn;
      const after = {
        ...fields,
        assessedOn,
        ...(fields.active === false && before.active ? { inactiveReason: reason } : {}),
        ...(fields.active === true && !before.active ? { inactiveReason: null } : {}),
      };
      const changes = changesOf(before, after);
      if (Object.keys(changes).length === 0) return { ...before, riskRevision: risk.revision };
      if (changes.ownerId) await this.assertPerson(tx, fields.ownerId!);
      if (changes.documentId) await this.assertDocument(tx, auth, fields.documentId);
      const [control] = await tx
        .update(riskControls)
        .set({ ...after, revision: sql`${riskControls.revision} + 1`, updatedAt: new Date() })
        .where(eq(riskControls.id, controlId))
        .returning(controlColumns);
      const riskRevision = await this.touch(tx, id);
      const { inactiveReason: _reason, ...kept } = redacted(changes);
      const details = { controlId, ...kept, ...(reason ? { reasonGiven: true } : {}) };
      await addEvent(tx, auth, id, 'control_updated', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_control_updated', 'risk', id, details);
      return { ...control, riskRevision };
    });
  }

  /**
   * Corrects text written once on a risk and kept, for a manager of it,
   * whatever its status, given its revision: a rating's rationale, a
   * review's comment, a reason kept as a note, the reason a proposal was
   * not taken, a closure was asked for or a control switched off, and the
   * title, cause, event and consequence of a risk that cannot otherwise be
   * edited (rejected, closed). So that a detail of a person typed by mistake
   * can be taken out (security reviews 15, M1, and 17, L4 and L5). Audited
   * and written to the timeline as what was corrected, never the text. 404
   * for what is not the risk's.
   */
  correct(auth: AuthContext, id: string, input: CorrectionInput) {
    if (input.kind === 'rating_rationale') assertLanguages(auth, [], [input.text]);
    if (input.kind === 'risk_text') {
      if (input.field === 'title') assertLanguages(auth, [input.text]);
      else assertLanguages(auth, [], [input.text]);
    }
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await riskViewerOf(tx, auth);
      const risk = await this.lock(tx, viewer, id);
      if (!roleOf(viewer, risk).manager) throw notYours();
      if (risk.revision !== input.revision) throw stale();
      let details: Record<string, unknown> = { kind: input.kind };
      const none = () => new ConflictException({ code: 'nothing_to_correct' });
      if (input.kind === 'rating_rationale') {
        const done = await tx
          .update(riskRatings)
          .set({ rationale: input.text })
          .where(and(eq(riskRatings.id, input.ratingId), eq(riskRatings.riskId, id)))
          .returning({ id: riskRatings.id });
        if (done.length === 0) throw new NotFoundException();
        details = { ...details, ratingId: input.ratingId };
      } else if (input.kind === 'review_comment') {
        const done = await tx
          .update(riskReviews)
          .set({ comment: input.text })
          .where(and(eq(riskReviews.id, input.reviewId), eq(riskReviews.riskId, id)))
          .returning({ id: riskReviews.id });
        if (done.length === 0) throw new NotFoundException();
        details = { ...details, reviewId: input.reviewId };
      } else if (input.kind === 'note') {
        const done = await tx
          .update(riskNotes)
          .set({ text: input.text, correctedBy: auth.user.id, correctedAt: new Date() })
          .where(and(eq(riskNotes.id, input.noteId), eq(riskNotes.riskId, id)))
          .returning({ id: riskNotes.id });
        if (done.length === 0) throw new NotFoundException();
        details = { ...details, noteId: input.noteId };
      } else if (input.kind === 'reject_reason') {
        if (risk.rejectReason === null) throw none();
        await tx.update(risks).set({ rejectReason: input.text }).where(eq(risks.id, id));
      } else if (input.kind === 'close_reason') {
        if (risk.closeReason === null) throw none();
        // What a closure's signer signs stays as it was put to them.
        if (risk.status === 'open' && risk.closureRequestedAt) {
          throw new ConflictException({ code: 'closure_in_progress' });
        }
        await tx.update(risks).set({ closeReason: input.text }).where(eq(risks.id, id));
      } else if (input.kind === 'link_text') {
        const done = await tx
          .update(riskIncidentLinks)
          .set({ [input.field]: input.text })
          .where(
            and(
              eq(riskIncidentLinks.id, input.linkId),
              eq(riskIncidentLinks.riskId, id),
              sql`${input.field === 'note' ? riskIncidentLinks.note : riskIncidentLinks.removeReason} is not null`,
            ),
          )
          .returning({ id: riskIncidentLinks.id });
        if (done.length === 0) throw new NotFoundException();
        details = { ...details, linkId: input.linkId, field: input.field };
      } else if (input.kind === 'risk_text') {
        // A risk on the register or proposed is edited (`PATCH`).
        if (risk.status !== 'rejected' && risk.status !== 'closed') {
          throw new ConflictException({ code: 'use_edit' });
        }
        await tx.update(risks).set({ [input.field]: input.text }).where(eq(risks.id, id));
        details = { ...details, field: input.field };
      } else {
        const done = await tx
          .update(riskControls)
          .set({ inactiveReason: input.text })
          .where(
            and(eq(riskControls.id, input.controlId), eq(riskControls.riskId, id), sql`${riskControls.inactiveReason} is not null`),
          )
          .returning({ id: riskControls.id });
        if (done.length === 0) throw new NotFoundException();
        details = { ...details, controlId: input.controlId };
      }
      await this.touch(tx, id);
      await addEvent(tx, auth, id, 'text_corrected', details);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'risk_text_corrected', 'risk', id, details);
      return this.view(tx, auth, viewer, id);
    });
  }

  /**
   * The risk of an action, for someone who sees the risk in full, or who
   * owns the action while it is open, in progress or completed (as
   * visibility.ts: security review 17, L6). 404 otherwise.
   */
  async actionContext(tx: Transaction, auth: AuthContext, viewer: RiskViewer, action: ActionRow) {
    const [risk] = await tx
      .select(riskColumns)
      .from(risks)
      .where(and(eq(risks.id, action.riskId!), visible(viewer)));
    if (risk) return { risk, full: true };
    if (action.ownerId !== auth.user.id || !READING_ACTION.includes(action.status)) throw new NotFoundException();
    const [own] = await tx.select(riskColumns).from(risks).where(eq(risks.id, action.riskId!));
    return { risk: own, full: false };
  }

  /** What notifications about a risk say of it. */
  notified(r: Pick<RiskRow, 'id' | 'reference' | 'currentBand'>) {
    return { id: r.id, reference: r.reference, currentBand: r.currentBand, serious: isSerious(r.currentBand) };
  }
}

/** A unit column within a unit and everything beneath it. */
export const unitAndBelow = (unitId: string): SQL => sql`${risks.orgUnitId} in (
  with recursive below (id) as (
    select o.id from ${orgUnits} o where o.id = ${unitId}
    union
    select c.id from ${orgUnits} c join below b on c.parent_id = b.id
  ) select id from below)`;
