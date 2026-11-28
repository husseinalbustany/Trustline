import { eq, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  ApprovalEngine,
  type Assignment,
} from '../approvals/approval-engine.service.js';
import type { Transaction } from '../database/client.js';
import {
  approvalRuns,
  approvalRunSteps,
  documentAudiences,
  documents,
  documentVersions,
  orgUnits,
  roleAssignments,
  roles,
  users,
} from '../database/schema.js';
import type { AuthContext } from '../identity/auth.service.js';
import type { Permission } from '../identity/permissions.js';
import { reachOf } from '../identity/scope.js';

/**
 * Who sees which documents, as conditions for a query. Written once, here,
 * so that every list, count, search, notification and lookup means the same
 * documents, and nothing restricted, drafted or in review shows anywhere to
 * anyone the spec does not allow:
 *
 * - **Full sight** (everything about a document, every version, drafts,
 *   the history and the acknowledgement figures): those whose
 *   `policies.manage` or `policies.view_all` covers the document's owning
 *   unit (granted for the whole organization, for that unit or one above).
 * - **Reading** the published version of an active document: those who hold
 *   `policies.view`, `policies.manage` or `policies.view_all` anywhere, for
 *   a document open to all staff, or for a restricted one whose audience
 *   they are in; and the document's owner, whatever its confidentiality.
 * - **An assignee** of a step of an approval run in progress on one of its
 *   versions sees the document, that version, and the published version it
 *   is compared with. Nothing else.
 *
 * A retired document is seen only with full sight.
 */

/** What may read documents at all. `policies.view` is not scoped. */
export const READ_PERMISSIONS: Permission[] = [
  'policies.view',
  'policies.manage',
  'policies.view_all',
];

/** What makes someone an assignee of an approval step for a document. */
export const APPROVE_PERMISSION: Permission = 'policies.approve';

/** The person signed in, as these rules need them. */
export type Viewer = {
  userId: string;
  manageReach: 'all' | string[];
  fullReach: 'all' | string[];
  readsLibrary: boolean;
  /** Their own unit and every unit above it: what an audience covers. */
  homeUnits: string[];
  /** Every role they hold, wherever: what an audience is narrowed to. */
  roleIds: string[];
  assignment: Assignment;
};

export async function viewerOf(
  tx: Transaction,
  auth: AuthContext,
  engine: ApprovalEngine,
): Promise<Viewer> {
  const held = await tx
    .selectDistinct({ roleId: roleAssignments.roleId })
    .from(roleAssignments)
    .where(eq(roleAssignments.userId, auth.user.id));
  let homeUnits: string[] = [];
  if (auth.user.orgUnitId) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      with recursive up (id, parent_id) as (
        select o.id, o.parent_id from ${orgUnits} o where o.id = ${auth.user.orgUnitId}
        union
        select o.id, o.parent_id from ${orgUnits} o join up on o.id = up.parent_id
      ) select id from up`);
    homeUnits = rows.map((r) => r.id);
  }
  return {
    userId: auth.user.id,
    manageReach: reachOf(auth, ['policies.manage']),
    fullReach: reachOf(auth, ['policies.manage', 'policies.view_all']),
    readsLibrary: READ_PERMISSIONS.some((p) => auth.permissions.includes(p)),
    homeUnits,
    roleIds: held.map((r) => r.roleId),
    assignment: await engine.assignmentOf(tx, auth.user.id, APPROVE_PERMISSION),
  };
}

const ids = (list: string[]) =>
  sql.join(
    list.map((id) => sql`${id}`),
    sql`, `,
  );

/** A unit column within a reach: everywhere, or one of these units. */
export const within = (reach: 'all' | string[], unit: SQLWrapper): SQL =>
  reach === 'all'
    ? sql`true`
    : reach.length === 0
      ? sql`false`
      : sql`coalesce(${unit} in (${ids(reach)}), false)`;

/** Whether the viewer sees everything about the document. */
export const fullSight = (v: Viewer) => within(v.fullReach, documents.ownerUnitId);

/** Whether the viewer manages the document. */
export const manages = (v: Viewer) =>
  within(v.manageReach, documents.ownerUnitId);

/** Whether the viewer is in the document's audience. */
export function inAudience(v: Viewer, documentId: SQLWrapper = documents.id) {
  const unit =
    v.homeUnits.length > 0
      ? sql`a.org_unit_id in (${ids(v.homeUnits)})`
      : sql`false`;
  const role =
    v.roleIds.length > 0 ? sql`a.role_id in (${ids(v.roleIds)})` : sql`false`;
  return sql`exists (
    select from ${documentAudiences} a
    where a.document_id = ${documentId}
      and (a.org_unit_id is null or ${unit})
      and (a.role_id is null or ${role}))`;
}

/** Whether the viewer reads the document's published version. */
export function readsPublished(v: Viewer): SQL {
  const reader = v.readsLibrary
    ? sql`(${documents.confidentiality} = 'all_staff' or ${inAudience(v)})`
    : sql`false`;
  return sql`(${documents.status} = 'active' and (${reader} or ${documents.ownerId} = ${v.userId}))`;
}

/**
 * The version of the document whose approval run in progress has a step
 * for the viewer, if any: a query of one id, or null.
 */
export function assignedVersion(v: Viewer, engine: ApprovalEngine): SQL {
  const assigned = engine.assignedTo(v.assignment, documents.ownerUnitId, {
    assigneeUserId: sql`s.assignee_user_id`,
    assigneeRoleId: sql`s.assignee_role_id`,
  });
  return sql`(
    select dv.id from ${documentVersions} dv
    join ${approvalRuns} r on r.subject_type = 'document_version'
      and r.subject_id = dv.id and r.status = 'in_progress'
    join ${approvalRunSteps} s on s.run_id = r.id
    where dv.document_id = ${documents.id} and ${assigned}
    limit 1)`;
}

/** Whether the viewer sees the document at all. Never null. */
export function visible(v: Viewer, engine: ApprovalEngine): SQL {
  return sql`coalesce((${fullSight(v)} or ${readsPublished(v)} or ${assignedVersion(v, engine)} is not null), false)`;
}

/**
 * Whether a user (a row of `users`, or columns standing for one) is in a
 * document's audience and may read documents at all: who is asked to
 * acknowledge it, reminded, and counted as targeted. Active users only.
 */
export function audienceMember(
  user: { id: SQLWrapper; orgUnitId: SQLWrapper; status: SQLWrapper; kind: SQLWrapper },
  documentId: SQLWrapper,
): SQL {
  // Never an external reviewer, who reads but is asked nothing: not to
  // acknowledge, nor reminded, nor counted (security review 14, info).
  return sql`(
    ${user.status} = 'active'
    and ${user.kind} = 'staff'
    and exists (
      select from ${roleAssignments} ra join ${roles} r on r.id = ra.role_id
      where ra.user_id = ${user.id}
        and r.permissions && array['policies.view', 'policies.manage', 'policies.view_all']::text[])
    and exists (
      select from ${documentAudiences} a
      where a.document_id = ${documentId}
        and (a.org_unit_id is null or ${user.orgUnitId} in (
          with recursive below (id) as (
            select a.org_unit_id
            union
            select c.id from ${orgUnits} c join below b on c.parent_id = b.id
          ) select id from below))
        and (a.role_id is null or exists (
          select from ${roleAssignments} rr
          where rr.user_id = ${user.id} and rr.role_id = a.role_id))))`;
}

/** `audienceMember` for the `users` table itself. */
export const userInAudience = (documentId: SQLWrapper) =>
  audienceMember(
    { id: users.id, orgUnitId: users.orgUnitId, status: users.status, kind: users.kind },
    documentId,
  );
