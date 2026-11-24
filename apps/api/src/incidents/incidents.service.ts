import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Transaction } from '../database/client.js';
import {
  incidentCategories,
  incidentComments,
  incidentEvents,
  incidents,
  orgUnits,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers, reachOf } from '../identity/scope.js';
import { nextReference } from './reference.js';

export type IncidentStatus = (typeof incidents.status.enumValues)[number];
export type IncidentType = (typeof incidents.type.enumValues)[number];
export type HarmLevel = (typeof incidents.harmLevel.enumValues)[number];
export type CommentVisibility =
  (typeof incidentComments.visibility.enumValues)[number];
type EventKind = (typeof incidentEvents.kind.enumValues)[number];

/** How far ahead of the server a reporter's clock may be. */
export const CLOCK_TOLERANCE_MINUTES = 5;
export const EXCERPT_LENGTH = 140;

/**
 * Every allowed change of status outside triage, and the timeline entry it
 * leaves. `note` says whether the person must explain the change.
 */
const MOVES: {
  from: IncidentStatus[];
  to: IncidentStatus;
  kind: EventKind;
  note: 'required' | 'optional';
}[] = [
  {
    from: ['triaged'],
    to: 'in_progress',
    kind: 'status_changed',
    note: 'optional',
  },
  {
    from: ['triaged', 'in_progress'],
    to: 'closed',
    kind: 'closed',
    note: 'required',
  },
  { from: ['new'], to: 'rejected', kind: 'rejected', note: 'required' },
  {
    from: ['closed', 'rejected'],
    to: 'in_progress',
    kind: 'reopened',
    note: 'required',
  },
];

export type ReportInput = {
  type: IncidentType;
  categoryId: string;
  orgUnitId: string;
  occurredAt: Date;
  description: string;
  immediateAction: string | null;
  harmLevel: HarmLevel;
  anonymous: boolean;
};

export type ListInput = {
  status?: IncidentStatus;
  mine: boolean;
  page: number;
  pageSize: number;
};

export type TriageInput = {
  harmLevel: HarmLevel;
  isSentinel: boolean;
  categoryId?: string;
  ownerUnitId: string;
  assignedTo: string | null;
};

// An incident points at org units twice and at users several times.
const place = alias(orgUnits, 'place');
const ownerUnit = alias(orgUnits, 'owner_unit');
const reporter = alias(users, 'reporter');
const assignee = alias(users, 'assignee');
const actor = alias(users, 'actor');
const author = alias(users, 'author');

/** The rules of incident reporting: who sees what, and what may change. */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  /**
   * The incidents a user may see: the ones they reported, and the ones that
   * happened in, or are owned by, a unit their view or triage rights cover.
   */
  private visibleTo(auth: AuthContext): SQL {
    const reach = reachOf(auth, ['incidents.view', 'incidents.triage']);
    if (reach === 'all') return sql`true`;
    const mine = eq(incidents.reportedBy, auth.user.id);
    if (reach.length === 0) return mine;
    return or(
      mine,
      inArray(incidents.orgUnitId, reach),
      inArray(incidents.ownerUnitId, reach),
    )!;
  }

  /** Whether a permission covers where the incident happened or who owns it. */
  private holds(
    auth: AuthContext,
    permission: 'incidents.view' | 'incidents.triage',
    incident: { orgUnitId: string; ownerUnitId: string | null },
  ) {
    return (
      covers(auth, permission, incident.orgUnitId) ||
      (incident.ownerUnitId !== null &&
        covers(auth, permission, incident.ownerUnitId))
    );
  }

  private async assertCategory(tx: Transaction, categoryId: string) {
    const [category] = await tx
      .select({ id: incidentCategories.id })
      .from(incidentCategories)
      .where(
        and(
          eq(incidentCategories.id, categoryId),
          eq(incidentCategories.active, true),
        ),
      );
    if (!category) throw new BadRequestException({ code: 'unknown_category' });
  }

  private async assertOrgUnit(tx: Transaction, orgUnitId: string) {
    const [unit] = await tx
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(eq(orgUnits.id, orgUnitId));
    if (!unit) throw new BadRequestException({ code: 'unknown_org_unit' });
  }

  /**
   * Adds a timeline entry. The time is the clock's, not the transaction's
   * start, so two entries written by one request keep their order.
   */
  private async addEvent(
    tx: Transaction,
    auth: AuthContext,
    incidentId: string,
    event: {
      kind: EventKind;
      actorId: string | null;
      visibleToReporter: boolean;
      fromStatus?: IncidentStatus;
      toStatus?: IncidentStatus;
      details?: Record<string, unknown>;
    },
  ) {
    await tx.insert(incidentEvents).values({
      tenantId: auth.tenant.id,
      incidentId,
      occurredAt: sql`clock_timestamp()`,
      ...event,
    });
  }

  categories(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select({
          id: incidentCategories.id,
          code: incidentCategories.code,
          name: incidentCategories.name,
        })
        .from(incidentCategories)
        .where(eq(incidentCategories.active, true))
        .orderBy(
          asc(incidentCategories.position),
          asc(incidentCategories.code),
        ),
    );
  }

  report(auth: AuthContext, input: ReportInput) {
    const { tenant, user } = auth;
    const { anonymous, ...fields } = input;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      await this.assertCategory(tx, input.categoryId);
      await this.assertOrgUnit(tx, input.orgUnitId);

      // An anonymous report is stored with no trace of who made it: not on
      // the incident, not on its timeline, not in the audit log.
      const reporterId = anonymous ? null : user.id;
      const now = new Date();
      const reference = await nextReference(
        tx,
        tenant.id,
        'INC',
        now.getUTCFullYear(),
      );
      const [incident] = await tx
        .insert(incidents)
        .values({
          ...fields,
          tenantId: tenant.id,
          reference,
          reportedBy: reporterId,
          reportedAt: now,
        })
        .returning({ id: incidents.id, reference: incidents.reference });
      await this.addEvent(tx, auth, incident.id, {
        kind: 'reported',
        actorId: reporterId,
        toStatus: 'new',
        visibleToReporter: true,
      });
      await this.provisioning.audit(
        tx,
        tenant.id,
        reporterId,
        'incident_reported',
        'incident',
        incident.id,
        { reference, type: input.type, anonymous },
      );
      return incident;
    });
  }

  list(auth: AuthContext, input: ListInput) {
    const where = and(
      this.visibleTo(auth),
      input.status && eq(incidents.status, input.status),
      input.mine ? eq(incidents.reportedBy, auth.user.id) : undefined,
    );
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [{ total }] = await tx
        .select({ total: count() })
        .from(incidents)
        .where(where);
      const items = await tx
        .select({
          id: incidents.id,
          reference: incidents.reference,
          type: incidents.type,
          category: {
            id: incidentCategories.id,
            name: incidentCategories.name,
          },
          orgUnit: { id: place.id, name: place.name },
          ownerUnit: { id: ownerUnit.id, name: ownerUnit.name },
          occurredAt: incidents.occurredAt,
          reportedAt: incidents.reportedAt,
          harmLevel: incidents.harmLevel,
          isSentinel: incidents.isSentinel,
          status: incidents.status,
          // Cut in the database, so the full text never leaves it for a list.
          descriptionExcerpt: sql<string>`case when char_length(${incidents.description}) > ${EXCERPT_LENGTH} then left(${incidents.description}, ${EXCERPT_LENGTH - 1}) || '…' else ${incidents.description} end`,
        })
        .from(incidents)
        .innerJoin(
          incidentCategories,
          eq(incidentCategories.id, incidents.categoryId),
        )
        .innerJoin(place, eq(place.id, incidents.orgUnitId))
        .leftJoin(ownerUnit, eq(ownerUnit.id, incidents.ownerUnitId))
        .where(where)
        .orderBy(desc(incidents.reportedAt), desc(incidents.reference))
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      return { items, total };
    });
  }

  summary(auth: AuthContext) {
    const number = (condition: SQL) =>
      sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [counts] = await tx
        .select({
          open: number(
            sql`${incidents.status} in ('new', 'triaged', 'in_progress')`,
          ),
          awaitingTriage: number(sql`${incidents.status} = 'new'`),
          closedLast30Days: number(
            sql`${incidents.status} = 'closed' and ${incidents.closedAt} >= now() - interval '30 days'`,
          ),
        })
        .from(incidents)
        .where(this.visibleTo(auth));
      return counts;
    });
  }

  get(auth: AuthContext, id: string) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      this.detail(tx, auth, id),
    );
  }

  /** One incident as this user may see it. 404 if they may not see it. */
  private async detail(tx: Transaction, auth: AuthContext, id: string) {
    const [row] = await tx
      .select({
        id: incidents.id,
        reference: incidents.reference,
        type: incidents.type,
        category: { id: incidentCategories.id, name: incidentCategories.name },
        orgUnit: { id: place.id, name: place.name },
        ownerUnit: { id: ownerUnit.id, name: ownerUnit.name },
        occurredAt: incidents.occurredAt,
        reportedAt: incidents.reportedAt,
        description: incidents.description,
        immediateAction: incidents.immediateAction,
        harmLevel: incidents.harmLevel,
        isSentinel: incidents.isSentinel,
        status: incidents.status,
        reporter: { id: reporter.id, name: reporter.name },
        assignedTo: { id: assignee.id, name: assignee.name },
        triagedAt: incidents.triagedAt,
        closedAt: incidents.closedAt,
        closureSummary: incidents.closureSummary,
        rejectionReason: incidents.rejectionReason,
      })
      .from(incidents)
      .innerJoin(
        incidentCategories,
        eq(incidentCategories.id, incidents.categoryId),
      )
      .innerJoin(place, eq(place.id, incidents.orgUnitId))
      .leftJoin(ownerUnit, eq(ownerUnit.id, incidents.ownerUnitId))
      .leftJoin(reporter, eq(reporter.id, incidents.reportedBy))
      .leftJoin(assignee, eq(assignee.id, incidents.assignedTo))
      .where(and(eq(incidents.id, id), this.visibleTo(auth)));
    if (!row) throw new NotFoundException();

    const where = {
      orgUnitId: row.orgUnit.id,
      ownerUnitId: row.ownerUnit?.id ?? null,
    };
    const canTriage = this.holds(auth, 'incidents.triage', where);
    const full = canTriage || this.holds(auth, 'incidents.view', where);

    const events = await tx
      .select({
        id: incidentEvents.id,
        kind: incidentEvents.kind,
        occurredAt: incidentEvents.occurredAt,
        actor: { id: actor.id, name: actor.name },
        fromStatus: incidentEvents.fromStatus,
        toStatus: incidentEvents.toStatus,
        details: incidentEvents.details,
      })
      .from(incidentEvents)
      .leftJoin(actor, eq(actor.id, incidentEvents.actorId))
      .where(
        and(
          eq(incidentEvents.incidentId, id),
          full ? undefined : eq(incidentEvents.visibleToReporter, true),
        ),
      )
      .orderBy(asc(incidentEvents.occurredAt), asc(incidentEvents.id));
    const comments = await tx
      .select({
        id: incidentComments.id,
        author: { id: author.id, name: author.name },
        body: incidentComments.body,
        visibility: incidentComments.visibility,
        createdAt: incidentComments.createdAt,
      })
      .from(incidentComments)
      .innerJoin(author, eq(author.id, incidentComments.authorId))
      .where(
        and(
          eq(incidentComments.incidentId, id),
          full ? undefined : eq(incidentComments.visibility, 'everyone'),
        ),
      )
      .orderBy(asc(incidentComments.createdAt), asc(incidentComments.id));

    return {
      ...row,
      // The reporter learns which department has it, not which person.
      assignedTo: full ? row.assignedTo : null,
      access: full ? ('full' as const) : ('reporter' as const),
      canTriage,
      events,
      comments,
    };
  }

  /**
   * Locks an incident for a change by someone with triage rights over it.
   * 404 if they may not see it, 403 if they see it but may not triage it.
   */
  private async lockForTriage(tx: Transaction, auth: AuthContext, id: string) {
    const [incident] = await tx
      .select({
        id: incidents.id,
        status: incidents.status,
        orgUnitId: incidents.orgUnitId,
        ownerUnitId: incidents.ownerUnitId,
        assignedTo: incidents.assignedTo,
      })
      .from(incidents)
      .where(and(eq(incidents.id, id), this.visibleTo(auth)))
      .for('update');
    if (!incident) throw new NotFoundException();
    if (!this.holds(auth, 'incidents.triage', incident)) {
      throw new ForbiddenException({ code: 'outside_scope' });
    }
    return incident;
  }

  triage(auth: AuthContext, id: string, input: TriageInput) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const incident = await this.lockForTriage(tx, auth, id);
      if (incident.status !== 'new' && incident.status !== 'triaged') {
        throw new ConflictException({ code: 'invalid_transition' });
      }
      if (input.categoryId) await this.assertCategory(tx, input.categoryId);
      await this.assertOrgUnit(tx, input.ownerUnitId);
      if (input.assignedTo) {
        const [person] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(eq(users.id, input.assignedTo), eq(users.status, 'active')),
          );
        if (!person)
          throw new BadRequestException({ code: 'unknown_assignee' });
      }

      const now = new Date();
      await tx
        .update(incidents)
        .set({
          harmLevel: input.harmLevel,
          isSentinel: input.isSentinel,
          ...(input.categoryId && { categoryId: input.categoryId }),
          ownerUnitId: input.ownerUnitId,
          assignedTo: input.assignedTo,
          status: 'triaged',
          triagedBy: user.id,
          triagedAt: now,
          updatedAt: now,
        })
        .where(eq(incidents.id, id));

      await this.addEvent(tx, auth, id, {
        kind: 'triaged',
        actorId: user.id,
        fromStatus: incident.status,
        toStatus: 'triaged',
        // Shown to the reporter, so it names the department, not the person.
        details: {
          harmLevel: input.harmLevel,
          isSentinel: input.isSentinel,
          ownerUnitId: input.ownerUnitId,
          ...(input.categoryId && { categoryId: input.categoryId }),
        },
        visibleToReporter: true,
      });
      if (
        incident.ownerUnitId !== input.ownerUnitId ||
        incident.assignedTo !== input.assignedTo
      ) {
        await this.addEvent(tx, auth, id, {
          kind: 'assigned',
          actorId: user.id,
          details: {
            ownerUnitId: input.ownerUnitId,
            assignedTo: input.assignedTo,
          },
          visibleToReporter: false,
        });
      }
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'incident_triaged',
        'incident',
        id,
        {
          from: incident.status,
          to: 'triaged',
          harmLevel: input.harmLevel,
          isSentinel: input.isSentinel,
          categoryId: input.categoryId ?? null,
          ownerUnitId: input.ownerUnitId,
          assignedTo: input.assignedTo,
        },
      );
      return this.detail(tx, auth, id);
    });
  }

  changeStatus(
    auth: AuthContext,
    id: string,
    to: IncidentStatus,
    note: string | null,
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const incident = await this.lockForTriage(tx, auth, id);
      const from = incident.status;
      const move = MOVES.find((m) => m.to === to && m.from.includes(from));
      if (!move) throw new ConflictException({ code: 'invalid_transition' });
      if (move.note === 'required' && !note) {
        throw new BadRequestException({ code: 'note_required' });
      }

      const now = new Date();
      await tx
        .update(incidents)
        .set({
          status: to,
          updatedAt: now,
          ...(move.kind === 'closed' && {
            closedBy: user.id,
            closedAt: now,
            closureSummary: note,
          }),
          ...(move.kind === 'rejected' && { rejectionReason: note }),
          // Open again: the earlier ending stays on the timeline only.
          ...(move.kind === 'reopened' && {
            closedBy: null,
            closedAt: null,
            closureSummary: null,
            rejectionReason: null,
          }),
        })
        .where(eq(incidents.id, id));
      await this.addEvent(tx, auth, id, {
        kind: move.kind,
        actorId: user.id,
        fromStatus: from,
        toStatus: to,
        ...(note && { details: { note } }),
        visibleToReporter: true,
      });
      // The note may hold sensitive detail, so the audit log gets none of it.
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'incident_status_changed',
        'incident',
        id,
        { from, to },
      );
      return this.detail(tx, auth, id);
    });
  }

  comment(
    auth: AuthContext,
    id: string,
    input: { body: string; visibility: CommentVisibility },
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const [incident] = await tx
        .select({
          orgUnitId: incidents.orgUnitId,
          ownerUnitId: incidents.ownerUnitId,
        })
        .from(incidents)
        .where(and(eq(incidents.id, id), this.visibleTo(auth)));
      if (!incident) throw new NotFoundException();
      const full =
        this.holds(auth, 'incidents.view', incident) ||
        this.holds(auth, 'incidents.triage', incident);
      // Someone who could not read an internal comment may not write one.
      if (!full && input.visibility === 'internal') {
        throw new ForbiddenException({ code: 'internal_not_allowed' });
      }

      const [created] = await tx
        .insert(incidentComments)
        .values({
          tenantId: tenant.id,
          incidentId: id,
          authorId: user.id,
          body: input.body,
          visibility: input.visibility,
          createdAt: sql`clock_timestamp()`,
        })
        .returning({
          id: incidentComments.id,
          visibility: incidentComments.visibility,
          createdAt: incidentComments.createdAt,
        });
      await this.addEvent(tx, auth, id, {
        kind: 'commented',
        actorId: user.id,
        details: { commentId: created.id, visibility: input.visibility },
        visibleToReporter: input.visibility === 'everyone',
      });
      await tx
        .update(incidents)
        .set({ updatedAt: new Date() })
        .where(eq(incidents.id, id));
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'incident_commented',
        'incident',
        id,
        { commentId: created.id, visibility: input.visibility },
      );
      return created;
    });
  }
}
