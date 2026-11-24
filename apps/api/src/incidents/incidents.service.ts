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
  gte,
  inArray,
  lt,
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
import type { Localized } from '../i18n/locales.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers, reachOf } from '../identity/scope.js';
import { OrgUnitsService } from '../organization/org-units.service.js';
import { nextReference } from './reference.js';

export type IncidentStatus = (typeof incidents.status.enumValues)[number];
export type IncidentType = (typeof incidents.type.enumValues)[number];
export type HarmLevel = (typeof incidents.harmLevel.enumValues)[number];
export type CommentVisibility =
  (typeof incidentComments.visibility.enumValues)[number];
type EventKind = (typeof incidentEvents.kind.enumValues)[number];

/** How far ahead of the server a reporter's clock may be. */
export const CLOCK_TOLERANCE_MINUTES = 5;
/** Nothing is reported as having happened before this. */
export const EARLIEST_OCCURRED_AT = new Date('1900-01-01T00:00:00Z');
/** A form opened longer ago than this was not being filled in all that time. */
export const LONGEST_REPORT_HOURS = 24;
export const EXCERPT_LENGTH = 140;

/** An incident can be triaged, and triaged again, until it has ended. */
const TRIAGE_FROM: IncidentStatus[] = ['new', 'triaged', 'in_progress'];
const SERIOUS_HARM: HarmLevel[] = ['severe', 'death'];

/** Severe harm, a death, or a sentinel event: never set aside unexamined. */
const isSerious = (incident: { harmLevel: HarmLevel; isSentinel: boolean }) =>
  incident.isSentinel || SERIOUS_HARM.includes(incident.harmLevel);

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

/**
 * The moves open from where an incident stands. A serious one cannot be
 * rejected: its harm level has to be lowered at triage first, which leaves a
 * trace of who decided so.
 */
const movesFrom = (incident: {
  status: IncidentStatus;
  harmLevel: HarmLevel;
  isSentinel: boolean;
}) =>
  MOVES.filter(
    (m) =>
      m.from.includes(incident.status) &&
      !(m.to === 'rejected' && isSerious(incident)),
  );

export type ReportInput = {
  type: IncidentType;
  categoryId: string;
  orgUnitId: string;
  occurredAt: Date;
  description: string;
  immediateAction: string | null;
  harmLevel: HarmLevel;
  anonymous: boolean;
  /** When the reporter opened the form, by their own clock. */
  startedAt?: Date;
};

export type ListSort = 'newest' | 'oldest' | 'harm';

export type ListInput = {
  status?: IncidentStatus;
  type?: IncidentType;
  harmLevel?: HarmLevel;
  sentinel?: boolean;
  /** Where it happened or who owns it. */
  orgUnitId?: string;
  /** Reported at or after this moment, and before that one. */
  reportedFrom?: Date;
  reportedBefore?: Date;
  /** The start of a reference, in any letter case. */
  reference?: string;
  assignedToMe: boolean;
  mine: boolean;
  sort: ListSort;
  page: number;
  pageSize: number;
};

export type TriageInput = {
  harmLevel: HarmLevel;
  isSentinel: boolean;
  categoryId?: string;
  ownerUnitId: string;
  assignedTo: string | null;
  /** The revision the triager was looking at, if they say. */
  revision?: number;
};

/** What a timeline entry's details may point at, and where its name is. */
const REFERENCES = {
  assignedTo: 'people',
  ownerUnitId: 'units',
  categoryId: 'categories',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    private readonly orgUnits: OrgUnitsService,
  ) {}

  /**
   * The incidents a user may see: the ones they reported, the ones assigned
   * to them, and the ones that happened in, or are owned by, a unit their
   * view or triage rights cover.
   */
  private visibleTo(auth: AuthContext): SQL {
    const reach = reachOf(auth, ['incidents.view', 'incidents.triage']);
    if (reach === 'all') return sql`true`;
    const mine = eq(incidents.reportedBy, auth.user.id);
    const assigned = eq(incidents.assignedTo, auth.user.id);
    if (reach.length === 0) return or(mine, assigned)!;
    return or(
      mine,
      assigned,
      inArray(incidents.orgUnitId, reach),
      inArray(incidents.ownerUnitId, reach),
    )!;
  }

  /**
   * Whether a user sees all of an incident, internal parts included: through
   * view or triage rights over it, or because it is assigned to them. Anyone
   * else who sees it does so only as its reporter.
   */
  private seesAll(
    auth: AuthContext,
    incident: {
      orgUnitId: string;
      ownerUnitId: string | null;
      assignedTo: string | null;
    },
  ) {
    return (
      incident.assignedTo === auth.user.id ||
      this.holds(auth, 'incidents.view', incident) ||
      this.holds(auth, 'incidents.triage', incident)
    );
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

  /**
   * Type and harm must agree: a near miss reached nobody and a hazard has not
   * happened yet, so neither can have harmed anyone or be a sentinel event.
   */
  private assertHarmFits(
    type: IncidentType,
    harmLevel: HarmLevel,
    isSentinel: boolean,
  ) {
    if (type === 'incident') return;
    if (harmLevel !== 'none') {
      throw new BadRequestException({ code: 'harm_not_applicable' });
    }
    if (isSentinel) {
      throw new BadRequestException({ code: 'sentinel_not_applicable' });
    }
  }

  /**
   * Refuses a decision made on an out-of-date screen: the incident was
   * triaged or moved since the caller read it. Not checked when the caller
   * does not say which revision they read.
   */
  private assertFresh(incident: { revision: number }, revision?: number) {
    if (revision !== undefined && revision !== incident.revision) {
      throw new ConflictException({ code: 'stale_incident' });
    }
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

  /**
   * The people an incident can be assigned to: active users only, and only
   * what a triager needs to pick one. No contact details.
   */
  assignableUsers(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select({
          id: users.id,
          name: users.name,
          orgUnitId: users.orgUnitId,
        })
        .from(users)
        .where(eq(users.status, 'active'))
        .orderBy(asc(users.email)),
    );
  }

  report(auth: AuthContext, input: ReportInput) {
    const { tenant, user } = auth;
    const { anonymous, startedAt, ...fields } = input;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      this.assertHarmFits(input.type, input.harmLevel, false);
      await this.assertCategory(tx, input.categoryId);
      // Where it happened: a unit of this hospital that is still in use.
      await this.orgUnits.assertActive(tx, [input.orgUnitId]);

      // An anonymous report is stored with no trace of who made it: not on
      // the incident, not on its timeline, not in the audit log.
      const reporterId = anonymous ? null : user.id;
      const now = new Date();
      // Kept only when believable. A device with a wrong clock sends a time
      // that is not; the report is taken all the same, without the measure.
      const believable =
        startedAt !== undefined &&
        startedAt.getTime() >=
          now.getTime() - LONGEST_REPORT_HOURS * 3_600_000 &&
        startedAt.getTime() <= now.getTime() + CLOCK_TOLERANCE_MINUTES * 60_000;
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
          reportStartedAt: believable ? startedAt : null,
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
    // Every filter narrows what the caller may see, never widens it: an org
    // unit or a reference outside their view simply matches nothing.
    const where = and(
      this.visibleTo(auth),
      input.status && eq(incidents.status, input.status),
      input.type && eq(incidents.type, input.type),
      input.harmLevel && eq(incidents.harmLevel, input.harmLevel),
      input.sentinel === undefined
        ? undefined
        : eq(incidents.isSentinel, input.sentinel),
      input.orgUnitId
        ? or(
            eq(incidents.orgUnitId, input.orgUnitId),
            eq(incidents.ownerUnitId, input.orgUnitId),
          )
        : undefined,
      input.reportedFrom && gte(incidents.reportedAt, input.reportedFrom),
      input.reportedBefore && lt(incidents.reportedAt, input.reportedBefore),
      // The controller lets through letters, digits and hyphens only, so
      // there is nothing here for LIKE to read as a wildcard.
      input.reference
        ? sql`upper(${incidents.reference}) like ${`${input.reference.toUpperCase()}%`}`
        : undefined,
      input.assignedToMe ? eq(incidents.assignedTo, auth.user.id) : undefined,
      input.mine ? eq(incidents.reportedBy, auth.user.id) : undefined,
    );
    const order: Record<ListSort, SQL[]> = {
      newest: [desc(incidents.reportedAt), desc(incidents.reference)],
      oldest: [asc(incidents.reportedAt), asc(incidents.reference)],
      // The harm levels are stored in order of severity: death comes first.
      // Within a level, the one that has waited longest.
      harm: [
        desc(incidents.harmLevel),
        asc(incidents.reportedAt),
        asc(incidents.reference),
      ],
    };
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
          assignedToMe: sql<boolean>`coalesce(${incidents.assignedTo} = ${auth.user.id}, false)`,
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
        .orderBy(...order[input.sort])
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      return { items, total };
    });
  }

  summary(auth: AuthContext) {
    const number = (condition: SQL) =>
      sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
    const open = sql`${incidents.status} in ('new', 'triaged', 'in_progress')`;
    // How long reporting took, from opening the form to sending it.
    const seconds = sql`greatest(extract(epoch from ${incidents.reportedAt} - ${incidents.reportStartedAt}), 0)`;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [counts] = await tx
        .select({
          open: number(open),
          awaitingTriage: number(sql`${incidents.status} = 'new'`),
          closedLast30Days: number(
            sql`${incidents.status} = 'closed' and ${incidents.closedAt} >= now() - interval '30 days'`,
          ),
          assignedToMe: number(
            sql`${open} and ${incidents.assignedTo} = ${auth.user.id}`,
          ),
          serious: number(
            sql`${open} and (${incidents.harmLevel} in ('severe', 'death') or ${incidents.isSentinel})`,
          ),
          // The middle value, in whole seconds, over the reports of the last
          // 30 days that carry a start time. Null when there are none.
          medianSecondsToReport: sql<
            number | null
          >`round(percentile_cont(0.5) within group (order by ${seconds}) filter (where ${incidents.reportStartedAt} is not null and ${incidents.reportedAt} >= now() - interval '30 days'))::int`,
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
    const found = await this.find(tx, auth, id);
    if (!found) throw new NotFoundException();
    return found;
  }

  /** One incident as this user may see it, or null if they may not. */
  private async find(tx: Transaction, auth: AuthContext, id: string) {
    const [row] = await tx
      .select({
        id: incidents.id,
        reference: incidents.reference,
        type: incidents.type,
        category: { id: incidentCategories.id, name: incidentCategories.name },
        // Named here even when switched off since, and marked as such.
        orgUnit: { id: place.id, name: place.name, active: place.active },
        ownerUnit: {
          id: ownerUnit.id,
          name: ownerUnit.name,
          active: ownerUnit.active,
        },
        occurredAt: incidents.occurredAt,
        reportedAt: incidents.reportedAt,
        description: incidents.description,
        immediateAction: incidents.immediateAction,
        harmLevel: incidents.harmLevel,
        isSentinel: incidents.isSentinel,
        status: incidents.status,
        revision: incidents.revision,
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
    if (!row) return null;

    const where = {
      orgUnitId: row.orgUnit.id,
      ownerUnitId: row.ownerUnit?.id ?? null,
    };
    const canTriage = this.holds(auth, 'incidents.triage', where);
    const full = this.seesAll(auth, {
      ...where,
      assignedTo: row.assignedTo?.id ?? null,
    });

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
      // What this caller may do next, so no screen has to know the rules.
      canRetriage: canTriage && TRIAGE_FROM.includes(row.status),
      moves: canTriage
        ? movesFrom(row).map((m) => ({
            to: m.to,
            noteRequired: m.note === 'required',
          }))
        : [],
      events,
      comments,
      ...(await this.namesIn(tx, events)),
    };
  }

  /**
   * The names of the people, org units and categories that the given timeline
   * entries point at by id, so a screen can show "from Ward 3 to Laboratory"
   * without looking anything up. Includes users who have left, and units and
   * categories switched off since: that is the point. Only what these entries
   * mention, so a reporter-only view names nothing from the entries hidden
   * from it.
   */
  private async namesIn(tx: Transaction, events: { details: unknown }[]) {
    const ids = {
      people: new Set<string>(),
      units: new Set<string>(),
      categories: new Set<string>(),
    };
    for (const { details } of events) {
      if (!details || typeof details !== 'object') continue;
      for (const [key, kind] of Object.entries(REFERENCES)) {
        const value = (details as Record<string, unknown>)[key];
        // Either the id itself, or a change `{ from, to }`.
        const mentioned =
          value && typeof value === 'object'
            ? Object.values(value as Record<string, unknown>)
            : [value];
        for (const id of mentioned) {
          if (typeof id === 'string' && UUID.test(id)) ids[kind].add(id);
        }
      }
    }
    const named = async (
      wanted: Set<string>,
      table: typeof users | typeof orgUnits | typeof incidentCategories,
    ) => {
      if (wanted.size === 0) return {};
      const rows: { id: string; name: Localized }[] = await tx
        .select({ id: table.id, name: table.name })
        .from(table)
        .where(inArray(table.id, [...wanted]));
      return Object.fromEntries(rows.map((r) => [r.id, r.name]));
    };
    return {
      people: await named(ids.people, users),
      units: await named(ids.units, orgUnits),
      categories: await named(ids.categories, incidentCategories),
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
        reference: incidents.reference,
        type: incidents.type,
        status: incidents.status,
        revision: incidents.revision,
        harmLevel: incidents.harmLevel,
        isSentinel: incidents.isSentinel,
        categoryId: incidents.categoryId,
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
      this.assertFresh(incident, input.revision);
      if (!TRIAGE_FROM.includes(incident.status)) {
        throw new ConflictException({ code: 'invalid_transition' });
      }
      this.assertHarmFits(incident.type, input.harmLevel, input.isSentinel);

      // What it has may stay, even if switched off since. What is newly
      // chosen must be in use.
      const categoryId = input.categoryId ?? incident.categoryId;
      if (categoryId !== incident.categoryId) {
        await this.assertCategory(tx, categoryId);
      }
      if (input.ownerUnitId !== incident.ownerUnitId) {
        await this.orgUnits.assertActive(tx, [input.ownerUnitId]);
      }
      if (input.assignedTo) {
        const [person] = await tx
          .select({ id: users.id })
          .from(users)
          .where(
            and(eq(users.id, input.assignedTo), eq(users.status, 'active')),
          );
        if (!person) {
          throw new BadRequestException({ code: 'unknown_assignee' });
        }
      }

      // Every value that changes, with what it was: nothing is corrected
      // without a trace. On first triage "what it was" is the reporter's.
      const next = {
        harmLevel: input.harmLevel,
        isSentinel: input.isSentinel,
        categoryId,
        ownerUnitId: input.ownerUnitId,
      };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of Object.keys(next) as (keyof typeof next)[]) {
        if (incident[key] !== next[key]) {
          changes[key] = { from: incident[key], to: next[key] };
        }
      }
      const personChanged = incident.assignedTo !== input.assignedTo;
      const reassigned = 'ownerUnitId' in changes || personChanged;
      // A triage decision: the first one, or a correction of an earlier one.
      const decided =
        incident.status === 'new' || Object.keys(changes).length > 0;
      // The same values it already has: no write, no trace, no new revision.
      if (!decided && !reassigned) return this.detail(tx, auth, id);

      // Work that has started stays started.
      const to = incident.status === 'in_progress' ? 'in_progress' : 'triaged';
      const now = new Date();
      await tx
        .update(incidents)
        .set({
          ...next,
          assignedTo: input.assignedTo,
          status: to,
          ...(decided && { triagedBy: user.id, triagedAt: now }),
          revision: incident.revision + 1,
          updatedAt: now,
        })
        .where(eq(incidents.id, id));

      if (decided) {
        await this.addEvent(tx, auth, id, {
          kind: 'triaged',
          actorId: user.id,
          fromStatus: incident.status,
          toStatus: to,
          // Shown to the reporter, so it names the department, not the person.
          details: changes,
          visibleToReporter: true,
        });
      }
      if (reassigned) {
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
      // Ids, levels and flags only.
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'incident_triaged',
        'incident',
        id,
        {
          from: incident.status,
          to,
          ...changes,
          ...(personChanged && {
            assignedTo: { from: incident.assignedTo, to: input.assignedTo },
          }),
        },
      );

      // Handed to a department outside the caller's own view: the change
      // stands, and they are told so instead of being shown what they may no
      // longer see.
      const view = await this.find(tx, auth, id);
      return (
        view ?? {
          id,
          reference: incident.reference,
          handedOff: true as const,
        }
      );
    });
  }

  changeStatus(
    auth: AuthContext,
    id: string,
    to: IncidentStatus,
    note: string | null,
    revision?: number,
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const incident = await this.lockForTriage(tx, auth, id);
      this.assertFresh(incident, revision);
      const from = incident.status;
      const move = MOVES.find((m) => m.to === to && m.from.includes(from));
      if (!move) throw new ConflictException({ code: 'invalid_transition' });
      if (move.kind === 'rejected' && isSerious(incident)) {
        throw new ConflictException({ code: 'serious_cannot_be_rejected' });
      }
      if (move.note === 'required' && !note) {
        throw new BadRequestException({ code: 'note_required' });
      }

      const now = new Date();
      await tx
        .update(incidents)
        .set({
          status: to,
          revision: incident.revision + 1,
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
          assignedTo: incidents.assignedTo,
        })
        .from(incidents)
        .where(and(eq(incidents.id, id), this.visibleTo(auth)))
        // Held, so the access checked here is the access at the moment the
        // comment is stored: nobody is taken off the incident in between.
        .for('update');
      if (!incident) throw new NotFoundException();
      const full = this.seesAll(auth, incident);
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
