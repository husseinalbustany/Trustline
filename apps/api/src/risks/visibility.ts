import { and, eq, isNull, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { ApprovalEngine, type Assignment } from '../approvals/approval-engine.service.js';
import type { Transaction } from '../database/client.js';
import {
  actions,
  approvalRuns,
  approvalRunSteps,
  riskAcceptances,
  riskCommittees,
  risks,
  roleAssignments,
} from '../database/schema.js';
import type { AuthContext } from '../identity/auth.service.js';
import type { Permission } from '../identity/permissions.js';
import { reachOf } from '../identity/scope.js';

/**
 * Who sees and who manages which risks, as conditions for a query and as
 * answers for one risk (docs/specs/risk-management.md, "Permissions").
 * Written once, here, so that every list, count, lookup and, later, heat
 * map, export, notification and digest means the same risks:
 *
 * - **A reader** of a risk: `risks.view` or `risks.manage` covering its
 *   unit (for a risk of the whole organization, a grant for the whole
 *   organization: `scope.ts` answers so for no unit); its owner; a member
 *   of the committee it is escalated to; and, for a summary only (its
 *   reference, title, status and current band), an owner of one of its
 *   actions that is not finished (`readsAsActionOwner`); an assignee of a
 *   step of its acceptance's or its closure's run in progress, who reads it
 *   to decide that step and nothing else.
 * - **A manager** of it: `risks.manage` covering its unit.
 * - A proposed or rejected risk is read only by its managers and by the
 *   person who raised it; a closed one only by readers through a
 *   permission. Access from a person's place ends when the place does.
 *
 * A risk outside a caller's reach is answered 404, never 403.
 */

/** What reads risks through a permission. */
export const READ_PERMISSIONS: Permission[] = ['risks.view', 'risks.manage'];

/** Any of the module's permissions: who uses the module through a role. */
export const ANY_RISK_PERMISSION: Permission[] = [
  'risks.view',
  'risks.manage',
  'risks.approve',
];

/** The person signed in, as these rules need them. */
export type RiskViewer = {
  userId: string;
  readReach: 'all' | string[];
  manageReach: 'all' | string[];
  /** The active committees they belong to, by a role for the whole organization. */
  committeeIds: string[];
  /** Where they may be named in a step of a risk's route (`risks.approve`). */
  assignment: Assignment;
};

/** The engine holds no state: its reading of roles serves every caller. */
const engine = new ApprovalEngine();

export async function riskViewerOf(
  tx: Transaction,
  auth: AuthContext,
): Promise<RiskViewer> {
  const committees = await tx
    .selectDistinct({ id: riskCommittees.id })
    .from(riskCommittees)
    .innerJoin(
      roleAssignments,
      and(
        eq(roleAssignments.userId, auth.user.id),
        isNull(roleAssignments.orgUnitId),
        or(
          eq(roleAssignments.roleId, riskCommittees.memberRoleId),
          eq(roleAssignments.roleId, riskCommittees.chairRoleId),
        ),
      ),
    )
    .where(eq(riskCommittees.active, true));
  return {
    userId: auth.user.id,
    readReach: reachOf(auth, READ_PERMISSIONS),
    manageReach: reachOf(auth, ['risks.manage']),
    committeeIds: committees.map((c) => c.id),
    assignment: await engine.assignmentOf(tx, auth.user.id, 'risks.approve'),
  };
}

const ids = (list: string[]) =>
  sql.join(
    list.map((id) => sql`${id}`),
    sql`, `,
  );

/**
 * A unit column within a reach. A null unit (the whole organization) is
 * within `"all"` only.
 */
export const within = (reach: 'all' | string[], unit: SQLWrapper): SQL =>
  reach === 'all'
    ? sql`true`
    : reach.length === 0
      ? sql`false`
      : sql`coalesce(${unit} in (${ids(reach)}), false)`;

/** Whether a unit (null: the whole organization) is within a reach. */
export const reaches = (reach: 'all' | string[], unitId: string | null) =>
  reach === 'all' || (unitId !== null && reach.includes(unitId));

/** Whether the viewer manages the risk. */
export const manages = (v: RiskViewer): SQL => within(v.manageReach, risks.orgUnitId);

/** Whether the viewer reads the risk through a permission. */
export const readsByPermission = (v: RiskViewer): SQL =>
  within(v.readReach, risks.orgUnitId);

/**
 * Whether the viewer is an assignee of a step of a run in progress on the
 * risk: its acceptance's (`risk_acceptance`) or its closure's (`risk`).
 * Never null.
 */
export function assigneeOfRun(v: RiskViewer): SQL {
  const assigned = engine.assignedTo(v.assignment, risks.orgUnitId, {
    assigneeUserId: sql`s.assignee_user_id`,
    assigneeRoleId: sql`s.assignee_role_id`,
  });
  return sql`exists (
    select from ${approvalRuns} r
    join ${approvalRunSteps} s on s.run_id = r.id
    left join ${riskAcceptances} a on r.subject_type = 'risk_acceptance' and a.id = r.subject_id
    where r.status = 'in_progress'
      and ((r.subject_type = 'risk' and r.subject_id = ${risks.id}) or a.risk_id = ${risks.id})
      and ${assigned})`;
}

/** Whether the viewer reads the risk from their place: owner, committee, assignee. */
export function readsByPlace(v: RiskViewer): SQL {
  const committee =
    v.committeeIds.length > 0
      ? sql`coalesce(${risks.escalatedToCommitteeId} in (${ids(v.committeeIds)}), false)`
      : sql`false`;
  return sql`(${risks.ownerId} = ${v.userId} or ${committee} or ${assigneeOfRun(v)})`;
}

/**
 * Whether the viewer owns one of the risk's actions that is not finished:
 * they read its summary, nothing more. Never null.
 */
export function readsAsActionOwner(v: RiskViewer): SQL {
  return sql`exists (select from ${actions} a
    where a.risk_id = ${risks.id} and a.owner_id = ${v.userId}
      and a.status in ('open', 'in_progress', 'completed'))`;
}

/** Whether the viewer is a member of the committee the risk is escalated to. */
export const isMember = (v: RiskViewer, committeeId: string | null) =>
  committeeId !== null && v.committeeIds.includes(committeeId);

/** Whether the viewer sees the risk in full. Never null. */
export function visible(v: RiskViewer): SQL {
  return sql`coalesce((
    (${risks.status} in ('proposed', 'rejected') and (${manages(v)} or ${risks.createdBy} = ${v.userId}))
    or (${risks.status} = 'closed' and ${readsByPermission(v)})
    or (${risks.status} = 'open' and (${readsByPermission(v)} or ${readsByPlace(v)}))
  ), false)`;
}

/** The same rules for one risk already read, for what a reader may do. */
export function roleOf(
  v: RiskViewer,
  risk: {
    orgUnitId: string | null;
    ownerId: string;
    status: string;
    escalatedToCommitteeId?: string | null;
  },
) {
  const manager = reaches(v.manageReach, risk.orgUnitId);
  return {
    manager,
    // The owner works on an open risk; a proposal is a manager's.
    owner: risk.ownerId === v.userId && risk.status === 'open',
    // A member of the committee it is escalated to, on the register.
    member:
      risk.status === 'open' &&
      isMember(v, risk.escalatedToCommitteeId ?? null),
  };
}
