import { ConflictException, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  approvalRoutes,
  approvalRouteSteps,
  approvalRuns,
  approvalRunSteps,
  orgUnits,
  roleAssignments,
  roles,
} from '../database/schema.js';
import type { Permission } from '../identity/permissions.js';
import { buildScope } from '../identity/scope.js';
import { addDays } from '../i18n/time-zones.js';

/**
 * The approval engine: ordered routes of review and approval steps, runs of
 * a subject through a route, and the decision of each step in turn. Generic:
 * a document version goes through it today, an investigation later. It
 * knows nothing of documents; the code of each subject calls it, never the
 * reverse, and tells it what it needs to know:
 *
 * - the subject's owning unit, over which a role named in a step must be
 *   held for its holder to be an assignee;
 * - the permission that makes someone eligible at all (`policies.approve`
 *   for documents): a role named in a step must include it, and a person
 *   named in a step must hold it.
 *
 * Every method takes a transaction already scoped to the client by
 * `TenantDb.withTenant()`. Auditing, signatures and notifications are the
 * caller's, in the same transaction.
 */

export type RouteSubject = 'document';
export type RunSubject = 'document_version';
export type StepKind = (typeof approvalRunSteps.kind.enumValues)[number];
export type RunStatus = (typeof approvalRuns.status.enumValues)[number];
export type RunStepStatus = (typeof approvalRunSteps.status.enumValues)[number];

/** Who a step is for: one named person, or anyone holding a role. */
export type StepAssignee = {
  assigneeUserId: string | null;
  assigneeRoleId: string | null;
};

/** What the subject tells the engine about itself. */
export type SubjectContext = {
  /** The unit a role named in a step must be held over. */
  unitId: string;
  /** What an assignee must hold: `policies.approve` for documents. */
  permission: Permission;
};

/**
 * Where one person may be an assignee, for building queries: whether they
 * hold the permission at all (so may be named), and the roles they hold
 * that include it, each with the units it is held over.
 */
export type Assignment = {
  userId: string;
  named: boolean;
  roles: Map<string, 'all' | string[]>;
};

export type RunStep = {
  id: string;
  position: number;
  kind: StepKind;
  assigneeUserId: string | null;
  assigneeRoleId: string | null;
  dueInDays: number;
  status: RunStepStatus;
  activatedAt: Date | null;
  dueAt: Date | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  comment: string | null;
  signatureId: string | null;
};

export type Run = {
  id: string;
  routeId: string;
  subjectType: string;
  subjectId: string;
  status: RunStatus;
  currentPosition: number | null;
  startedBy: string;
  startedAt: Date;
  completedAt: Date | null;
  steps: RunStep[];
};

const runFields = {
  id: approvalRuns.id,
  routeId: approvalRuns.routeId,
  subjectType: approvalRuns.subjectType,
  subjectId: approvalRuns.subjectId,
  status: approvalRuns.status,
  currentPosition: approvalRuns.currentPosition,
  startedBy: approvalRuns.startedBy,
  startedAt: approvalRuns.startedAt,
  completedAt: approvalRuns.completedAt,
};

const stepFields = {
  id: approvalRunSteps.id,
  runId: approvalRunSteps.runId,
  position: approvalRunSteps.position,
  kind: approvalRunSteps.kind,
  assigneeUserId: approvalRunSteps.assigneeUserId,
  assigneeRoleId: approvalRunSteps.assigneeRoleId,
  dueInDays: approvalRunSteps.dueInDays,
  status: approvalRunSteps.status,
  activatedAt: approvalRunSteps.activatedAt,
  dueAt: approvalRunSteps.dueAt,
  decidedBy: approvalRunSteps.decidedBy,
  decidedAt: approvalRunSteps.decidedAt,
  comment: approvalRunSteps.comment,
  signatureId: approvalRunSteps.signatureId,
};

/** The unit and every unit above it, as a query of ids. */
const unitAndAbove = (unitId: string | SQLWrapper) => sql`(
  with recursive up (id, parent_id) as (
    select o.id, o.parent_id from ${orgUnits} o where o.id = ${unitId}
    union
    select o.id, o.parent_id from ${orgUnits} o join up on o.id = up.parent_id
  ) select id from up)`;

@Injectable()
export class ApprovalEngine {
  /**
   * The active route for a subject of this type: the one for the type, or
   * else the one for any type. Null when there is neither.
   */
  async routeFor(tx: Transaction, subject: RouteSubject, typeId: string) {
    const found = await tx
      .select({ id: approvalRoutes.id, typeId: approvalRoutes.documentTypeId })
      .from(approvalRoutes)
      .where(
        and(
          eq(approvalRoutes.subject, subject),
          eq(approvalRoutes.active, true),
          or(
            eq(approvalRoutes.documentTypeId, typeId),
            isNull(approvalRoutes.documentTypeId),
          ),
        ),
      );
    return found.find((r) => r.typeId === typeId) ?? found[0] ?? null;
  }

  /** A route's steps, in order. */
  stepsOf(tx: Transaction, routeId: string) {
    return tx
      .select({
        position: approvalRouteSteps.position,
        kind: approvalRouteSteps.kind,
        assigneeUserId: approvalRouteSteps.assigneeUserId,
        assigneeRoleId: approvalRouteSteps.assigneeRoleId,
        dueInDays: approvalRouteSteps.dueInDays,
      })
      .from(approvalRouteSteps)
      .where(eq(approvalRouteSteps.routeId, routeId))
      .orderBy(asc(approvalRouteSteps.position));
  }

  /**
   * The active people a step is for, now: the person named, if they hold
   * the permission; or everyone holding the role over the subject's unit
   * (granted for the whole organization, for the unit, or for a unit above
   * it), if the role still includes the permission.
   */
  async assignees(
    tx: Transaction,
    step: StepAssignee,
    ctx: SubjectContext,
  ): Promise<string[]> {
    if (step.assigneeUserId) {
      const { rows } = await tx.execute<{ id: string }>(sql`
        select u.id from users u
        where u.id = ${step.assigneeUserId} and u.status = 'active'
          and exists (
            select from ${roleAssignments} ra join ${roles} r on r.id = ra.role_id
            where ra.user_id = u.id and ${ctx.permission} = any(r.permissions))`);
      return rows.map((r) => r.id);
    }
    if (!step.assigneeRoleId) return [];
    const { rows } = await tx.execute<{ id: string }>(sql`
      select distinct ra.user_id as id
      from ${roleAssignments} ra
      join ${roles} r on r.id = ra.role_id
      join users u on u.id = ra.user_id and u.status = 'active'
      where ra.role_id = ${step.assigneeRoleId}
        and ${ctx.permission} = any(r.permissions)
        and (ra.org_unit_id is null or ra.org_unit_id in ${unitAndAbove(ctx.unitId)})
      order by 1`);
    return rows.map((r) => r.id);
  }

  /** Where one person may be an assignee: see `Assignment`. */
  async assignmentOf(
    tx: Transaction,
    userId: string,
    permission: Permission,
  ): Promise<Assignment> {
    const grants = await tx
      .select({
        roleId: roleAssignments.roleId,
        orgUnitId: roleAssignments.orgUnitId,
        permissions: roles.permissions,
      })
      .from(roleAssignments)
      .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
      .where(eq(roleAssignments.userId, userId));
    const eligible = grants.filter((g) => g.permissions.includes(permission));
    // The reach of each role, worked out as a scope whose "permissions" are
    // the role ids: the same rule as for permissions, a unit and below.
    const units = eligible.some((g) => g.orgUnitId)
      ? await tx
          .select({ id: orgUnits.id, parentId: orgUnits.parentId })
          .from(orgUnits)
      : [];
    const reach = buildScope(
      eligible.map((g) => ({ permissions: [g.roleId], orgUnitId: g.orgUnitId })),
      units,
    );
    return {
      userId,
      named: eligible.length > 0,
      roles: new Map(Object.entries(reach)),
    };
  }

  /** Whether this person is an assignee of this step, for this unit. */
  isAssignee(a: Assignment, step: StepAssignee, unitId: string) {
    if (step.assigneeUserId) return a.named && step.assigneeUserId === a.userId;
    if (!step.assigneeRoleId) return false;
    const reach = a.roles.get(step.assigneeRoleId);
    return reach === 'all' || (!!reach && reach.includes(unitId));
  }

  /**
   * `isAssignee` for a query over run steps (`approval_run_steps`, or an
   * alias of it), with the subject's unit as a column of the query. Never
   * null.
   */
  assignedTo(
    a: Assignment,
    unit: SQLWrapper,
    step: {
      assigneeUserId: SQLWrapper;
      assigneeRoleId: SQLWrapper;
    } = approvalRunSteps,
  ): SQL {
    const parts: SQL[] = [];
    if (a.named) parts.push(sql`${step.assigneeUserId} = ${a.userId}`);
    for (const [roleId, reach] of a.roles) {
      if (reach === 'all') {
        parts.push(sql`${step.assigneeRoleId} = ${roleId}`);
      } else if (reach.length > 0) {
        parts.push(
          sql`(${step.assigneeRoleId} = ${roleId} and ${unit} in (${sql.join(
            reach.map((id) => sql`${id}`),
            sql`, `,
          )}))`,
        );
      }
    }
    if (parts.length === 0) return sql`false`;
    return sql`coalesce((${sql.join(parts, sql` or `)}), false)`;
  }

  /**
   * Starts a run of the subject through the route: the steps are copied, the
   * first becomes the current one and its time starts. Refused with 409
   * `route_has_no_steps`, or `no_assignee` with the `position` of a step
   * that nobody could decide now (nobody holds what it names, or only
   * people in `excluded`, who may decide no step of this run: for a
   * document, everyone who prepared the version).
   *
   * Returns the run and who the first step is for.
   */
  async start(
    tx: Transaction,
    tenantId: string,
    input: {
      routeId: string;
      subjectType: RunSubject;
      subjectId: string;
      startedBy: string;
      ctx: SubjectContext;
      excluded: string[];
      now: Date;
      timeZone: string;
    },
  ) {
    const steps = await this.stepsOf(tx, input.routeId);
    if (steps.length === 0) {
      throw new ConflictException({ code: 'route_has_no_steps' });
    }
    let firstAssignees: string[] = [];
    for (const [i, step] of steps.entries()) {
      const can = (await this.assignees(tx, step, input.ctx)).filter(
        (id) => !input.excluded.includes(id),
      );
      if (can.length === 0) {
        throw new ConflictException({
          code: 'no_assignee',
          position: step.position,
        });
      }
      if (i === 0) firstAssignees = can;
    }
    const [run] = await tx
      .insert(approvalRuns)
      .values({
        tenantId,
        routeId: input.routeId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        status: 'in_progress',
        currentPosition: steps[0].position,
        startedBy: input.startedBy,
        startedAt: input.now,
      })
      .returning({ id: approvalRuns.id });
    await tx.insert(approvalRunSteps).values(
      steps.map((step, i) => ({
        tenantId,
        runId: run.id,
        position: step.position,
        kind: step.kind,
        assigneeUserId: step.assigneeUserId,
        assigneeRoleId: step.assigneeRoleId,
        dueInDays: step.dueInDays,
        status: i === 0 ? ('pending' as const) : ('waiting' as const),
        activatedAt: i === 0 ? input.now : null,
        dueAt:
          i === 0 ? addDays(input.now, step.dueInDays, input.timeZone) : null,
      })),
    );
    const started = (await this.runs(tx, [run.id]))[0];
    return { run: started, assignees: firstAssignees };
  }

  /** Runs by id, each with its steps in order. */
  async runs(tx: Transaction, ids: string[]): Promise<Run[]> {
    if (ids.length === 0) return [];
    const found = await tx
      .select(runFields)
      .from(approvalRuns)
      .where(inArray(approvalRuns.id, ids));
    const steps = await tx
      .select(stepFields)
      .from(approvalRunSteps)
      .where(inArray(approvalRunSteps.runId, ids))
      .orderBy(asc(approvalRunSteps.position));
    return found.map((run) => ({
      ...run,
      steps: steps
        .filter((s) => s.runId === run.id)
        .map(({ runId: _run, ...s }) => s),
    }));
  }

  /**
   * The runs of these subjects, newest first, each with its steps. With
   * `lock`, the runs in progress are held until the transaction ends, so
   * that two people deciding at once take turns.
   */
  async runsOf(
    tx: Transaction,
    subjectType: RunSubject,
    subjectIds: string[],
    { lock = false } = {},
  ): Promise<Run[]> {
    if (subjectIds.length === 0) return [];
    const query = tx
      .select({ id: approvalRuns.id })
      .from(approvalRuns)
      .where(
        and(
          eq(approvalRuns.subjectType, subjectType),
          inArray(approvalRuns.subjectId, subjectIds),
        ),
      )
      .orderBy(desc(approvalRuns.startedAt), desc(approvalRuns.id));
    const ids = lock ? await query.for('update') : await query;
    const list = await this.runs(
      tx,
      ids.map((r) => r.id),
    );
    const order = new Map(ids.map((r, i) => [r.id, i]));
    return list.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }

  /** The run of a subject that is in progress, if there is one. */
  async current(
    tx: Transaction,
    subjectType: RunSubject,
    subjectId: string,
    { lock = false } = {},
  ) {
    const runs = await this.runsOf(tx, subjectType, [subjectId], { lock });
    return runs.find((r) => r.status === 'in_progress') ?? null;
  }

  /** The step to be decided now, if the run is in progress. */
  pendingStep(run: Run) {
    if (run.status !== 'in_progress') return null;
    return run.steps.find((s) => s.status === 'pending') ?? null;
  }

  /**
   * Decides the current step. Approved: the next step becomes the current
   * one, or, after the last, the run is approved. Returned: the run ends
   * there, and the steps not reached are skipped. The caller has checked
   * that the person may decide it, under the lock of `current(..., lock)`.
   *
   * Returns how the run stands and, when it moved on, the new current step
   * and who it is for.
   */
  async decide(
    tx: Transaction,
    run: Run,
    input: {
      userId: string;
      outcome: 'approved' | 'returned';
      comment: string | null;
      signatureId: string | null;
      ctx: SubjectContext;
      excluded: string[];
      now: Date;
      timeZone: string;
    },
  ): Promise<{
    status: RunStatus;
    next: RunStep | null;
    nextAssignees: string[];
  }> {
    const step = this.pendingStep(run);
    if (!step) throw new ConflictException({ code: 'not_in_review' });
    await tx
      .update(approvalRunSteps)
      .set({
        status: input.outcome,
        decidedBy: input.userId,
        decidedAt: input.now,
        comment: input.comment,
        signatureId: input.signatureId,
      })
      .where(eq(approvalRunSteps.id, step.id));
    const next =
      input.outcome === 'approved'
        ? (run.steps.find((s) => s.position > step.position) ?? null)
        : null;
    if (input.outcome === 'returned' || !next) {
      const status = input.outcome === 'returned' ? 'returned' : 'approved';
      await this.close(tx, run, status, input.now);
      return { status, next: null, nextAssignees: [] };
    }
    const dueAt = addDays(input.now, next.dueInDays, input.timeZone);
    await tx
      .update(approvalRunSteps)
      .set({ status: 'pending', activatedAt: input.now, dueAt })
      .where(eq(approvalRunSteps.id, next.id));
    await tx
      .update(approvalRuns)
      .set({ currentPosition: next.position })
      .where(eq(approvalRuns.id, run.id));
    const nextAssignees = (await this.assignees(tx, next, input.ctx)).filter(
      (id) => !input.excluded.includes(id),
    );
    return {
      status: 'in_progress',
      next: { ...next, status: 'pending', activatedAt: input.now, dueAt },
      nextAssignees,
    };
  }

  /** Ends a run in progress without a decision: the subject was withdrawn. */
  cancel(tx: Transaction, run: Run, now: Date) {
    return this.close(tx, run, 'cancelled', now);
  }

  private async close(
    tx: Transaction,
    run: Run,
    status: Exclude<RunStatus, 'in_progress'>,
    now: Date,
  ) {
    await tx
      .update(approvalRunSteps)
      .set({ status: 'skipped' })
      .where(
        and(
          eq(approvalRunSteps.runId, run.id),
          inArray(approvalRunSteps.status, ['waiting', 'pending']),
        ),
      );
    await tx
      .update(approvalRuns)
      .set({ status, completedAt: now, currentPosition: null })
      .where(eq(approvalRuns.id, run.id));
  }
}
