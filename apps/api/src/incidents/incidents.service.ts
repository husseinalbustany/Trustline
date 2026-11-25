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
import {
  hashFollowUpCode,
  matchesFollowUpCode,
  newFollowUpCode,
} from './follow-up-code.js';
import { nextReference } from './reference.js';
import {
  chooseMove,
  hasSay,
  movesFor,
  needsSignOff,
  OPEN_STATUSES,
  TRIAGE_FROM,
  type Caller,
  type EventKind,
  type HarmLevel,
  type IncidentStatus,
} from './status.js';

export type { HarmLevel, IncidentStatus } from './status.js';
export type IncidentType = (typeof incidents.type.enumValues)[number];
export type IncidentChannel = (typeof incidents.channel.enumValues)[number];
export type CommentVisibility =
  (typeof incidentComments.visibility.enumValues)[number];

/** How far ahead of the server a reporter's clock may be. */
export const CLOCK_TOLERANCE_MINUTES = 5;
/** Nothing is reported as having happened before this. */
export const EARLIEST_OCCURRED_AT = new Date('1900-01-01T00:00:00Z');
/** A form opened longer ago than this was not being filled in all that time. */
export const LONGEST_REPORT_HOURS = 24;
export const EXCERPT_LENGTH = 140;

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

/** A report through the public link: always anonymous, so it does not say. */
export type PublicReportInput = Omit<ReportInput, 'anonymous'>;

/**
 * What one reader is to one incident: what they may do to it, how much of it
 * they see, and whether they are told who reported it.
 */
type Reader = Caller & {
  /** Sees the internal parts too, not only what its reporter sees. */
  full: boolean;
  /** Reported it, or holds the right to see who did. */
  seesReporter: boolean;
};

/**
 * Someone who proved with the follow-up code that an anonymous report is
 * theirs. They see what a reporter sees and may do nothing but comment.
 */
const ANONYMOUS_REPORTER: Reader = {
  full: false,
  canTriage: false,
  canSignOff: false,
  isRequester: false,
  seesReporter: true,
};

/**
 * Stands in for the hospital when there is none to act for. A transaction
 * scoped to it sees no rows, so a request for an unknown hospital can be put
 * through the same steps as any other and fail the same way.
 */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

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
const requester = alias(users, 'requester');

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
    permission:
      | 'incidents.view'
      | 'incidents.triage'
      | 'incidents.see_reporter'
      | 'incidents.sign_off',
    incident: { orgUnitId: string; ownerUnitId: string | null },
  ) {
    return (
      covers(auth, permission, incident.orgUnitId) ||
      (incident.ownerUnitId !== null &&
        covers(auth, permission, incident.ownerUnitId))
    );
  }

  /**
   * What a signed-in user is to an incident they can see.
   *
   * Who reported it is told to the reporter and to those holding the right
   * to see it for the incident's unit or its handling department. Handling
   * the incident, even being assigned to it, does not tell.
   */
  private readerOf(
    auth: AuthContext,
    incident: {
      orgUnitId: string;
      ownerUnitId: string | null;
      assignedTo: string | null;
      reportedBy: string | null;
      status: IncidentStatus;
      closureRequestedBy: string | null;
    },
  ): Reader {
    return {
      full: this.seesAll(auth, incident),
      canTriage: this.holds(auth, 'incidents.triage', incident),
      canSignOff: this.holds(auth, 'incidents.sign_off', incident),
      // Read from the stored request, never from anything the caller sends.
      isRequester:
        incident.status === 'awaiting_sign_off' &&
        incident.closureRequestedBy === auth.user.id,
      seesReporter:
        incident.reportedBy === auth.user.id ||
        this.holds(auth, 'incidents.see_reporter', incident),
    };
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
    tenantId: string,
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
      tenantId,
      incidentId,
      occurredAt: sql`clock_timestamp()`,
      ...event,
    });
  }

  /** The categories a report can be filed under, in display order. */
  private activeCategories(tx: Transaction) {
    return tx
      .select({
        id: incidentCategories.id,
        code: incidentCategories.code,
        name: incidentCategories.name,
      })
      .from(incidentCategories)
      .where(eq(incidentCategories.active, true))
      .orderBy(asc(incidentCategories.position), asc(incidentCategories.code));
  }

  categories(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      this.activeCategories(tx),
    );
  }

  /**
   * What the public report form offers: where it can have happened and what
   * kind of thing it was. Nothing else about the hospital.
   */
  publicForm(tenantId: string) {
    return this.tenantDb.withTenant(tenantId, async (tx) => ({
      orgUnits: await this.orgUnits.choosable(tx),
      categories: await this.activeCategories(tx),
    }));
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

  /**
   * A report by a signed-in member of staff. Reported anonymously, it is
   * stored with no trace of who made it and answered with the follow-up code
   * that is the only way back to it.
   */
  report(auth: AuthContext, input: ReportInput) {
    const { tenant, user } = auth;
    const { anonymous, ...report } = input;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { id, reference, followUpCode } = await this.store(
        tx,
        tenant.id,
        report,
        anonymous ? null : user.id,
        'app',
      );
      return followUpCode ? { id, reference, followUpCode } : { id, reference };
    });
  }

  /**
   * A report through the hospital's public link. Nobody is signed in and
   * nothing about the sender is passed in here, so nothing about them can be
   * stored: not on the incident, its timeline or the audit log.
   */
  reportPublicly(tenantId: string, input: PublicReportInput) {
    return this.tenantDb.withTenant(tenantId, async (tx) => {
      const { reference, followUpCode } = await this.store(
        tx,
        tenantId,
        input,
        null,
        'public',
      );
      return { reference, followUpCode: followUpCode! };
    });
  }

  /**
   * Stores a report, its first timeline entry and its audit entry. With no
   * reporter it is anonymous: nothing records who made it, and it gets a
   * follow-up code, of which only the hash is kept.
   */
  private async store(
    tx: Transaction,
    tenantId: string,
    input: PublicReportInput,
    reporterId: string | null,
    channel: IncidentChannel,
  ) {
    const { startedAt, ...fields } = input;
    this.assertHarmFits(input.type, input.harmLevel, false);
    await this.assertCategory(tx, input.categoryId);
    // Where it happened: a unit of this hospital that is still in use.
    await this.orgUnits.assertActive(tx, [input.orgUnitId]);

    const now = new Date();
    // Kept only when believable. A device with a wrong clock sends a time
    // that is not; the report is taken all the same, without the measure.
    const believable =
      startedAt !== undefined &&
      startedAt.getTime() >= now.getTime() - LONGEST_REPORT_HOURS * 3_600_000 &&
      startedAt.getTime() <= now.getTime() + CLOCK_TOLERANCE_MINUTES * 60_000;
    const reference = await nextReference(
      tx,
      tenantId,
      'INC',
      now.getUTCFullYear(),
    );
    const followUpCode = reporterId === null ? newFollowUpCode() : null;
    const [incident] = await tx
      .insert(incidents)
      .values({
        ...fields,
        tenantId,
        reference,
        channel,
        reportedBy: reporterId,
        followUpCodeHash: followUpCode && hashFollowUpCode(followUpCode),
        reportedAt: now,
        reportStartedAt: believable ? startedAt : null,
      })
      .returning({ id: incidents.id, reference: incidents.reference });
    await this.addEvent(tx, tenantId, incident.id, {
      kind: 'reported',
      actorId: reporterId,
      toStatus: 'new',
      visibleToReporter: true,
    });
    // For a public report the entry says that one was received, and nothing
    // more: no address, no device, nothing of what was written.
    await this.provisioning.audit(
      tx,
      tenantId,
      reporterId,
      'incident_reported',
      'incident',
      incident.id,
      {
        reference,
        type: input.type,
        anonymous: reporterId === null,
        ...(channel === 'public' && { channel }),
      },
    );
    return { ...incident, followUpCode };
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
    // Awaiting sign-off is still open: it is not closed until it is signed.
    const open = inArray(incidents.status, OPEN_STATUSES);
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
  private find(tx: Transaction, auth: AuthContext, id: string) {
    return this.view(
      tx,
      and(eq(incidents.id, id), this.visibleTo(auth))!,
      (incident) => this.readerOf(auth, incident),
    );
  }

  /**
   * One incident as one reader may see it, or null if `where` finds none.
   * Every response that shows an incident is built here, so what is hidden
   * from a reader is hidden in one place:
   *
   * - Without full access: no internal comment, no internal timeline entry,
   *   not the person it is assigned to, not who asked for its closure, and
   *   not the note it was sent back with.
   * - Without the right to see the reporter: nobody is named as reporter, as
   *   author of a comment the reporter wrote, or as the one behind the
   *   timeline entries of the report and of those comments. They are marked
   *   `byReporter` instead. Nor is the reader told how the report arrived,
   *   because a report through the public link is always anonymous: to this
   *   reader a named report and an anonymous one look the same.
   *
   * The reporter's id is read only to decide this and is never returned.
   */
  private async view(
    tx: Transaction,
    where: SQL,
    readerOf: (incident: {
      orgUnitId: string;
      ownerUnitId: string | null;
      assignedTo: string | null;
      reportedBy: string | null;
      status: IncidentStatus;
      closureRequestedBy: string | null;
    }) => Reader,
  ) {
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
        channel: incidents.channel,
        reportedBy: incidents.reportedBy,
        reporter: { id: reporter.id, name: reporter.name },
        assignedTo: { id: assignee.id, name: assignee.name },
        triagedAt: incidents.triagedAt,
        closedAt: incidents.closedAt,
        closureSummary: incidents.closureSummary,
        rejectionReason: incidents.rejectionReason,
        closureRequestedBy: { id: requester.id, name: requester.name },
        closureRequestedAt: incidents.closureRequestedAt,
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
      .leftJoin(requester, eq(requester.id, incidents.closureRequestedBy))
      .where(where);
    if (!row) return null;

    // Taken apart here so that nothing below can pass the reporter on by
    // spreading the row.
    const {
      reportedBy,
      reporter: namedReporter,
      channel,
      assignedTo,
      closureRequestedBy,
      closureRequestedAt,
      ...incident
    } = row;
    const reader = readerOf({
      orgUnitId: row.orgUnit.id,
      ownerUnitId: row.ownerUnit?.id ?? null,
      assignedTo: assignedTo?.id ?? null,
      reportedBy,
      status: row.status,
      closureRequestedBy: closureRequestedBy?.id ?? null,
    });
    const { full, canTriage, seesReporter } = reader;

    const eventRows = await tx
      .select({
        id: incidentEvents.id,
        kind: incidentEvents.kind,
        occurredAt: incidentEvents.occurredAt,
        actorId: incidentEvents.actorId,
        actor: { id: actor.id, name: actor.name },
        fromStatus: incidentEvents.fromStatus,
        toStatus: incidentEvents.toStatus,
        details: incidentEvents.details,
      })
      .from(incidentEvents)
      .leftJoin(actor, eq(actor.id, incidentEvents.actorId))
      .where(
        and(
          eq(incidentEvents.incidentId, row.id),
          full ? undefined : eq(incidentEvents.visibleToReporter, true),
        ),
      )
      .orderBy(asc(incidentEvents.occurredAt), asc(incidentEvents.id));
    const events = eventRows.map(({ actorId, actor: person, ...event }) => {
      // The report itself, and each comment the reporter wrote: by a named
      // reporter under their own account, or with a follow-up code, which
      // leaves no actor at all. Whatever else the same person did on the
      // incident (triaging it, say) they did as a handler, and it is shown
      // under their name like anyone else's.
      const byReporter =
        event.kind === 'reported' ||
        (event.kind === 'commented' &&
          (actorId === null || actorId === reportedBy));
      return {
        ...event,
        actor: byReporter && !seesReporter ? null : person,
        byReporter,
        // Why it was sent back is between the people handling it.
        details: event.kind === 'sent_back' && !full ? null : event.details,
      };
    });

    const commentRows = await tx
      .select({
        id: incidentComments.id,
        authorId: incidentComments.authorId,
        author: { id: author.id, name: author.name },
        byReporter: incidentComments.byReporter,
        body: incidentComments.body,
        visibility: incidentComments.visibility,
        createdAt: incidentComments.createdAt,
      })
      .from(incidentComments)
      .leftJoin(author, eq(author.id, incidentComments.authorId))
      .where(
        and(
          eq(incidentComments.incidentId, row.id),
          full ? undefined : eq(incidentComments.visibility, 'everyone'),
        ),
      )
      .orderBy(asc(incidentComments.createdAt), asc(incidentComments.id));
    const comments = commentRows.map(
      ({ authorId, author: person, byReporter: withCode, ...comment }) => {
        const byReporter =
          withCode || (authorId !== null && authorId === reportedBy);
        return {
          id: comment.id,
          author: byReporter && !seesReporter ? null : person,
          byReporter,
          body: comment.body,
          visibility: comment.visibility,
          createdAt: comment.createdAt,
        };
      },
    );

    return {
      ...incident,
      // Null to a reader who is not told who reported: knowing it came
      // through the public link would tell them it was anonymous.
      channel: seesReporter ? channel : null,
      // With `reporterShown`, null means it was reported anonymously.
      // Without, it means nothing either way.
      reporter: seesReporter ? namedReporter : null,
      reporterShown: seesReporter,
      // The reporter learns which department has it, not which person.
      assignedTo: full ? assignedTo : null,
      needsSignOff: needsSignOff(row),
      // While it awaits sign-off, `closureSummary` is the one proposed.
      closureRequestedBy: full ? closureRequestedBy : null,
      closureRequestedAt: full ? closureRequestedAt : null,
      access: full ? ('full' as const) : ('reporter' as const),
      canTriage,
      // What this reader may do next, so no screen has to know the rules.
      canRetriage: canTriage && TRIAGE_FROM.includes(row.status),
      moves: movesFor(row, reader).map((m) => ({
        to: m.to,
        noteRequired: m.note === 'required',
        action: m.action,
      })),
      events,
      comments,
      // People are named here only where a timeline entry points at them as
      // the one an incident was assigned to, never as its reporter.
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
   * Locks an incident the caller can see, for a decision on it. 404 if they
   * may not see it. Whether they may make the decision is for the caller of
   * this to check, on what is read here under the lock.
   */
  private async lock(tx: Transaction, auth: AuthContext, id: string) {
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
        reportedBy: incidents.reportedBy,
        closureRequestedBy: incidents.closureRequestedBy,
      })
      .from(incidents)
      .where(and(eq(incidents.id, id), this.visibleTo(auth)))
      .for('update');
    if (!incident) throw new NotFoundException();
    return incident;
  }

  triage(auth: AuthContext, id: string, input: TriageInput) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const incident = await this.lock(tx, auth, id);
      // They see it, but their right to triage is for somewhere else.
      if (!this.holds(auth, 'incidents.triage', incident)) {
        throw new ForbiddenException({ code: 'outside_scope' });
      }
      this.assertFresh(incident, input.revision);
      // Not once it has ended, and not while its closure awaits sign-off.
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
        await this.addEvent(tx, tenant.id, id, {
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
        await this.addEvent(tx, tenant.id, id, {
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

  /**
   * Moves an incident to another status. Who may make which move, and what
   * each needs, is decided in status.ts; this applies the decision.
   *
   * Closing a sentinel event or a death takes two people: one asks, with the
   * closure summary they propose, and another signs it off or sends it back.
   * "Another" is checked against who is stored as having asked, read under
   * the same lock as the change.
   */
  changeStatus(
    auth: AuthContext,
    id: string,
    to: IncidentStatus,
    note: string | null,
    revision?: number,
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const incident = await this.lock(tx, auth, id);
      const caller = this.readerOf(auth, incident);
      // First of all: someone with no say over it is told only that.
      if (!hasSay(incident, caller)) {
        if (incident.status === 'awaiting_sign_off') {
          throw new ForbiddenException({
            code: 'missing_permission',
            permission: 'incidents.sign_off',
          });
        }
        throw new ForbiddenException(
          auth.permissions.includes('incidents.triage')
            ? { code: 'outside_scope' }
            : { code: 'missing_permission', permission: 'incidents.triage' },
        );
      }
      this.assertFresh(incident, revision);
      const from = incident.status;
      const move = chooseMove(incident, to, caller);
      if (move === 'missing_sign_off_permission') {
        throw new ForbiddenException({
          code: 'missing_permission',
          permission: 'incidents.sign_off',
        });
      }
      if (move === 'same_person') {
        throw new ForbiddenException({ code: 'same_person' });
      }
      if (typeof move === 'string') throw new ConflictException({ code: move });
      if (move.note === 'required' && !note) {
        throw new BadRequestException({ code: 'note_required' });
      }

      const now = new Date();
      const noRequest = { closureRequestedBy: null, closureRequestedAt: null };
      const fields: Record<
        typeof move.action,
        Partial<typeof incidents.$inferInsert>
      > = {
        start: {},
        close: { closedBy: user.id, closedAt: now, closureSummary: note },
        // Not closed yet: the summary is the one proposed, and nobody has
        // closed it until the second person signs.
        request_sign_off: {
          closureSummary: note,
          closureRequestedBy: user.id,
          closureRequestedAt: now,
        },
        // Who asked stays on the record next to who signed.
        sign_off: { closedBy: user.id, closedAt: now },
        // The proposal falls; it stays on the timeline only.
        send_back: { closureSummary: null, ...noRequest },
        withdraw: { closureSummary: null, ...noRequest },
        reject: { rejectionReason: note },
        // Open again: the earlier ending stays on the timeline only.
        reopen: {
          closedBy: null,
          closedAt: null,
          closureSummary: null,
          rejectionReason: null,
          ...noRequest,
        },
      };
      await tx
        .update(incidents)
        .set({
          status: to,
          revision: incident.revision + 1,
          updatedAt: now,
          ...fields[move.action],
        })
        .where(eq(incidents.id, id));
      const details = {
        ...(note && { note }),
        ...(move.action === 'withdraw' && { withdrawn: true }),
      };
      await this.addEvent(tx, tenant.id, id, {
        kind: move.kind,
        actorId: user.id,
        fromStatus: from,
        toStatus: to,
        ...(Object.keys(details).length > 0 && { details }),
        // The reporter is told of every step. What a `sent_back` note says
        // is kept from them when the incident is read, in view().
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
        { from, to, action: move.action },
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
      return this.addComment(tx, tenant.id, id, user.id, input);
    });
  }

  /**
   * Stores a comment with its timeline and audit entries. With no author it
   * is the anonymous reporter's, written with their follow-up code: nothing
   * names anyone, anywhere.
   */
  private async addComment(
    tx: Transaction,
    tenantId: string,
    incidentId: string,
    authorId: string | null,
    input: { body: string; visibility: CommentVisibility },
  ) {
    const byReporter = authorId === null;
    const [created] = await tx
      .insert(incidentComments)
      .values({
        tenantId,
        incidentId,
        authorId,
        byReporter,
        body: input.body,
        visibility: input.visibility,
        createdAt: sql`clock_timestamp()`,
      })
      .returning({
        id: incidentComments.id,
        visibility: incidentComments.visibility,
        createdAt: incidentComments.createdAt,
      });
    await this.addEvent(tx, tenantId, incidentId, {
      kind: 'commented',
      actorId: authorId,
      details: { commentId: created.id, visibility: input.visibility },
      visibleToReporter: input.visibility === 'everyone',
    });
    await tx
      .update(incidents)
      .set({ updatedAt: new Date() })
      .where(eq(incidents.id, incidentId));
    await this.provisioning.audit(
      tx,
      tenantId,
      authorId,
      'incident_commented',
      'incident',
      incidentId,
      {
        commentId: created.id,
        visibility: input.visibility,
        ...(byReporter && { byReporter }),
      },
    );
    return created;
  }

  /**
   * Finds the anonymous report a follow-up code belongs to, or null.
   *
   * A wrong reference and a wrong code must be indistinguishable, in what is
   * answered and in how long it takes. So both take the same steps: one
   * lookup by reference, then one comparison of hashes in constant time,
   * against a stand-in when there is no report or it has no code.
   */
  private async byFollowUpCode(
    tx: Transaction,
    reference: string,
    code: string,
  ) {
    const [found] = await tx
      .select({ id: incidents.id, hash: incidents.followUpCodeHash })
      .from(incidents)
      .where(eq(incidents.reference, reference.trim().toUpperCase()));
    const matches = matchesFollowUpCode(code, found?.hash ?? null);
    return found && matches ? found.id : null;
  }

  /**
   * An anonymous report as its reporter sees it, opened with the follow-up
   * code. `tenantId` is null when there is no hospital to ask (unknown,
   * suspended, or not taking public reports): the same steps are taken and
   * the same 404 answered, so the cases cannot be told apart.
   *
   * No session is involved even if the caller has one: nothing here knows,
   * and so nothing can record, who is holding the code.
   */
  followUp(tenantId: string | null, reference: string, code: string) {
    return this.tenantDb.withTenant(tenantId ?? NO_TENANT, async (tx) => {
      const id = await this.byFollowUpCode(tx, reference, code);
      const view =
        id &&
        (await this.view(tx, eq(incidents.id, id), () => ANONYMOUS_REPORTER));
      if (!view) throw new NotFoundException();
      return view;
    });
  }

  /** A comment by the anonymous reporter, for everyone on the incident. */
  followUpComment(
    tenantId: string | null,
    reference: string,
    code: string,
    body: string,
  ) {
    const scope = tenantId ?? NO_TENANT;
    return this.tenantDb.withTenant(scope, async (tx) => {
      const id = await this.byFollowUpCode(tx, reference, code);
      if (!id) throw new NotFoundException();
      return this.addComment(tx, scope, id, null, {
        body,
        visibility: 'everyone',
      });
    });
  }
}
