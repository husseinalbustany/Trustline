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
  gt,
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
import { lastDays } from '../i18n/time-zones.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import { OrgUnitsService } from '../organization/org-units.service.js';
import {
  hashFollowUpCode,
  matchesFollowUpCode,
  newFollowUpCode,
} from './follow-up-code.js';
import { Notifier, type Draft, type Subject, type Who } from './notifier.js';
import { PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR } from './public-limits.js';
import { nextReference } from './reference.js';
import { closeDueAt, triageDueAt } from './response-rules.js';
import { ResponseRulesService } from './response-rules.service.js';
import {
  callsForSignOff,
  chooseMove,
  DEADLINE_LIVE_IN,
  hasSay,
  movesFor,
  needsSignOff,
  OPEN_STATUSES,
  overdueOf,
  SERIOUS_HARM,
  TRIAGE_FROM,
  type Caller,
  type EventKind,
  type HarmLevel,
  type IncidentStatus,
  type MoveKind,
} from './status.js';
import { seenInFull, visibleTo } from './visibility.js';

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
  /**
   * Signed in, and so told which member of staff did what. Someone reading
   * with a follow-up code is not: they may be anyone who was handed the
   * code, and get no name or id of anyone working at the hospital.
   */
  seesStaff: boolean;
};

/**
 * Someone who proved with the follow-up code that an anonymous report is
 * theirs. They see what a reporter sees, without the names of staff and
 * without the incident's number, and may do nothing but comment.
 */
const ANONYMOUS_REPORTER: Reader = {
  full: false,
  canTriage: false,
  canSignOff: false,
  isRequester: false,
  seesReporter: true,
  seesStaff: false,
};

/** The hospital a request acts for, as far as storing a report needs it. */
export type Hospital = { id: string; timeZone: string };

const HOUR_MS = 3_600_000;

/**
 * Stands in for the hospital when there is none to act for. A transaction
 * scoped to it sees no rows, so a request for an unknown hospital can be put
 * through the same steps as any other and fail the same way.
 */
const NO_TENANT = '00000000-0000-0000-0000-000000000000';

// What the summary counts and the list filters by, written once so that a
// count on the dashboard and the list it links to are the same incidents.
/** Not yet ended. Awaiting sign-off is still open: it is not closed yet. */
const isOpen = inArray(incidents.status, OPEN_STATUSES);
/** Severe harm, a death, or a sentinel event: `isSerious()` for a query. */
const isSeriousOne = or(
  inArray(incidents.harmLevel, SERIOUS_HARM),
  eq(incidents.isSentinel, true),
)!;

/**
 * The deadline an incident is working towards: to be triaged by while it is
 * new, to be closed by while it is being handled, none once it has ended.
 * `liveDueAt()` of status.ts, for a query.
 */
const liveDueAt = sql<Date | null>`case
  when ${inArray(incidents.status, DEADLINE_LIVE_IN.triage)} then ${incidents.triageDueAt}
  when ${inArray(incidents.status, DEADLINE_LIVE_IN.closure)} then ${incidents.closeDueAt}
end`;
/**
 * Which deadline an incident has missed at this moment, `overdueOf()` of
 * status.ts for a query. Worked out here each time; nothing stores it.
 */
const overdueAt = (now: Date) =>
  sql<'triage' | 'closure' | null>`case
    when ${inArray(incidents.status, DEADLINE_LIVE_IN.triage)} and ${lt(incidents.triageDueAt, now)} then 'triage'
    when ${inArray(incidents.status, DEADLINE_LIVE_IN.closure)} and ${lt(incidents.closeDueAt, now)} then 'closure'
  end`;

export type ListSort = 'newest' | 'oldest' | 'harm' | 'due';

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
  /**
   * The start of a reference, in any letter case; or, when it is digits
   * only, also the end of one: "42" finds INC-2026-00042.
   */
  reference?: string;
  /** Only what is not yet ended, as the summary counts "open". */
  open: boolean;
  /** Only severe harm, a death or a sentinel event, as the summary counts. */
  serious: boolean;
  /** Only what has missed its deadline, as the summary counts "overdue". */
  overdue: boolean;
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
    private readonly rules: ResponseRulesService,
    private readonly notifier: Notifier,
  ) {}

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
      seesStaff: true,
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
        tenant,
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
   *
   * Answered with the follow-up code and nothing else. The incident gets its
   * number like any other, but the sender is not told it: the numbers run in
   * one series, and one of them would tell anyone how many incidents the
   * hospital has had.
   *
   * A hospital takes only so many of these an hour, whoever sends them and
   * from wherever. Past that the answer is `retryAfter`, in seconds, and
   * nothing is stored. Counted here, in the database, under a lock that
   * makes reports to one hospital take their turn, so the ceiling is the
   * same for every API process and cannot be overrun by sending at once.
   */
  reportPublicly(
    tenant: Hospital,
    input: PublicReportInput,
  ): Promise<{ followUpCode: string } | { retryAfter: number }> {
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('trustline.public_reports'), hashtext(${tenant.id}))`,
      );
      const now = Date.now();
      // The report that fills the hour, if the hour is full: the newest but
      // fifty-nine. When it is an hour old there is room again.
      const [filling] = await tx
        .select({ at: incidents.reportedAt })
        .from(incidents)
        .where(
          and(
            eq(incidents.channel, 'public'),
            gt(incidents.reportedAt, new Date(now - HOUR_MS)),
          ),
        )
        .orderBy(desc(incidents.reportedAt))
        .offset(PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR - 1)
        .limit(1);
      if (filling) {
        return { retryAfter: (filling.at.getTime() + HOUR_MS - now) / 1000 };
      }
      const { followUpCode } = await this.store(
        tx,
        tenant,
        input,
        null,
        'public',
      );
      return { followUpCode: followUpCode! };
    });
  }

  /**
   * Stores a report, its first timeline entry and its audit entry, and tells
   * those who may triage it. With no reporter it is anonymous: nothing
   * records who made it, and it gets a follow-up code, of which only the
   * hash is kept.
   */
  private async store(
    tx: Transaction,
    tenant: Hospital,
    input: PublicReportInput,
    reporterId: string | null,
    channel: IncidentChannel,
  ) {
    const tenantId = tenant.id;
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
      startedAt.getTime() >= now.getTime() - LONGEST_REPORT_HOURS * HOUR_MS &&
      startedAt.getTime() <= now.getTime() + CLOCK_TOLERANCE_MINUTES * 60_000;
    const reference = await nextReference(
      tx,
      tenantId,
      'INC',
      now.getUTCFullYear(),
    );
    const followUpCode = reporterId === null ? newFollowUpCode() : null;
    // Its two deadlines, from the harm level the reporter gave and the
    // hospital's rules as they are now. A report is not yet sentinel.
    const gravity = { harmLevel: input.harmLevel, isSentinel: false };
    const rules = await this.rules.inForce(tx);
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
        // A death reported needs a second person to close it from the
        // start, whatever triage makes of it later.
        signOffNeeded: callsForSignOff(gravity),
        triageDueAt: triageDueAt(now, gravity, rules),
        closeDueAt: closeDueAt(now, gravity, rules, tenant.timeZone),
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
    // Everyone who may triage the unit where it happened. A named reporter
    // who is one of them is not told of their own report. An anonymous one
    // is told like the rest: leaving one triager out would record, in who
    // was not notified, exactly who reported.
    await this.notifier.send(tx, tenantId, {
      incident: {
        ...incident,
        orgUnitId: input.orgUnitId,
        ownerUnitId: null,
        assignedTo: null,
        reportedBy: reporterId,
      },
      actorId: reporterId,
      drafts: (who) => [
        {
          kind: 'incident_reported',
          to: who.mayTriage([input.orgUnitId]),
          internal: true,
        },
      ],
    });
    return { ...incident, followUpCode };
  }

  list(auth: AuthContext, input: ListInput) {
    const now = new Date();
    // Deadlines are for those handling an incident. Someone who sees one
    // only because they reported it is not told them: not as fields, and
    // not by what a filter finds or the order a sort puts it in.
    const inFull = seenInFull(auth);
    const overdue = sql<
      'triage' | 'closure' | null
    >`case when ${inFull} then ${overdueAt(now)} end`;
    const dueAt = sql<Date | null>`case when ${inFull} then ${liveDueAt} end`;
    // Every filter narrows what the caller may see, never widens it: an org
    // unit or a reference outside their view simply matches nothing.
    const where = and(
      visibleTo(auth),
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
      this.referenceLike(input.reference),
      input.open ? isOpen : undefined,
      input.serious ? isSeriousOne : undefined,
      input.overdue ? sql`${overdue} is not null` : undefined,
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
      // The nearest deadline first, which puts what is overdue at the top,
      // longest overdue first. Then what has no deadline to meet any more,
      // or none the caller is told: newest first.
      due: [
        sql`${dueAt} asc nulls last`,
        desc(incidents.reportedAt),
        desc(incidents.reference),
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
          // Null for an incident the caller sees only as its reporter.
          triageDueAt:
            sql<Date | null>`case when ${inFull} then ${incidents.triageDueAt} end`.mapWith(
              incidents.triageDueAt,
            ),
          closeDueAt:
            sql<Date | null>`case when ${inFull} then ${incidents.closeDueAt} end`.mapWith(
              incidents.closeDueAt,
            ),
          overdue,
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

  /**
   * Matches references that start with the text, in any letter case. Someone
   * who types only digits means a number, not a prefix, so those also match
   * references that end with them: "42" finds INC-2026-00042.
   *
   * The controller lets through letters, digits and hyphens only, so there
   * is nothing here for LIKE to read as a wildcard.
   */
  private referenceLike(text?: string): SQL | undefined {
    if (!text) return undefined;
    const reference = sql`upper(${incidents.reference})`;
    const starts = sql`${reference} like ${`${text.toUpperCase()}%`}`;
    if (!/^\d+$/.test(text)) return starts;
    return or(starts, sql`${reference} like ${`%${text}`}`);
  }

  summary(auth: AuthContext) {
    const now = new Date();
    const number = (condition: SQL) =>
      sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
    // "The last 30 days" are days on the hospital's own calendar: today
    // there and the 29 days before it.
    const { from, to, since } = lastDays(30, auth.tenant.timeZone, now);
    const recent = gte(incidents.reportedAt, since);
    // How long reporting took, from opening the form to sending it.
    const seconds = sql`greatest(extract(epoch from ${incidents.reportedAt} - ${incidents.reportStartedAt}), 0)`;
    // Deadlines are counted only over what the caller sees in full, as the
    // list shows them: someone's own reports say nothing here.
    const inFull = seenInFull(auth);
    // Triaged for the first time, and so measured against its deadline.
    const triaged = and(
      inFull,
      recent,
      sql`${incidents.firstTriagedAt} is not null`,
      sql`${incidents.triageDueAt} is not null`,
    )!;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [counts] = await tx
        .select({
          open: number(isOpen),
          awaitingTriage: number(sql`${incidents.status} = 'new'`),
          closedLast30Days: number(
            sql`${incidents.status} = 'closed' and ${gte(incidents.closedAt, since)}`,
          ),
          assignedToMe: number(
            and(isOpen, eq(incidents.assignedTo, auth.user.id))!,
          ),
          serious: number(and(isOpen, isSeriousOne)!),
          // What the list gives for `overdue=true`.
          overdue: number(sql`${inFull} and ${overdueAt(now)} is not null`),
          // Of the reports of the last 30 days that have been triaged, the
          // share whose first triage came no later than its deadline, as a
          // whole percentage. Null when none has been triaged.
          triagedOnTime: sql<
            number | null
          >`round(100.0 * count(*) filter (where ${triaged} and ${incidents.firstTriagedAt} <= ${incidents.triageDueAt}) / nullif(count(*) filter (where ${triaged}), 0))::int`,
          // The middle value, in whole seconds, over the reports of the last
          // 30 days that carry a start time. Null when there are none.
          medianSecondsToReport: sql<
            number | null
          >`round(percentile_cont(0.5) within group (order by ${seconds}) filter (where ${incidents.reportStartedAt} is not null and ${recent}))::int`,
        })
        .from(incidents)
        .where(visibleTo(auth));
      // The days those 30 are, as the list's `from` and `to` take them.
      return { ...counts, last30Days: { from, to } };
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
      and(eq(incidents.id, id), visibleTo(auth))!,
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
   *   Nor its deadlines, which are for those handling it, nor the note a
   *   closure request was withdrawn with.
   * - Without the right to see the reporter: nobody is named as reporter, as
   *   author of a comment written as the reporter, or as the one behind the
   *   timeline entries of the report and of those comments. They are marked
   *   `byReporter` instead. Nor is the reader told how the report arrived,
   *   because a report through the public link is always anonymous: to this
   *   reader a named report and an anonymous one look the same.
   * - Reading with a follow-up code: no member of staff is named either.
   *   Whatever staff did or wrote is marked `byStaff` and carries no person,
   *   the `people` map is empty, and the incident's id and number are left
   *   out: the code is all that reader has, and all they are given.
   *
   * Whether a comment was written as the reporter was decided when it was
   * written (see `comment()`), not here from who its author is: a handler
   * who also reported the incident comments under their own name, so a name
   * on a comment tells nobody who did or did not report.
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
        signOffNeeded: incidents.signOffNeeded,
        status: incidents.status,
        revision: incidents.revision,
        triageDueAt: incidents.triageDueAt,
        closeDueAt: incidents.closeDueAt,
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
      id: incidentId,
      reference,
      reportedBy,
      reporter: namedReporter,
      channel,
      assignedTo,
      closureRequestedBy,
      closureRequestedAt,
      signOffNeeded,
      triageDueAt: triageDue,
      closeDueAt: closeDue,
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
    const { full, canTriage, seesReporter, seesStaff } = reader;

    // Which comments were written as the reporter. Read for all of them,
    // also those this reader is not shown, and only this much of them.
    const asReporter = new Set(
      (
        await tx
          .select({
            id: incidentComments.id,
            authorId: incidentComments.authorId,
            byReporter: incidentComments.byReporter,
            asHandler: incidentComments.asHandler,
          })
          .from(incidentComments)
          .where(eq(incidentComments.incidentId, row.id))
      )
        .filter((c) => this.writtenAsReporter(c, reportedBy))
        .map((c) => c.id),
    );

    const eventRows = await tx
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
          eq(incidentEvents.incidentId, row.id),
          full ? undefined : eq(incidentEvents.visibleToReporter, true),
        ),
      )
      .orderBy(asc(incidentEvents.occurredAt), asc(incidentEvents.id));
    const events = eventRows.map(({ actor: person, ...event }) => {
      // The report itself, and each comment written as the reporter.
      // Whatever else the same person did on the incident (triaging it, say,
      // or commenting as one of its handlers) is shown under their name like
      // anyone else's.
      const commentId = (event.details as { commentId?: unknown } | null)
        ?.commentId;
      const byReporter =
        event.kind === 'reported' ||
        (event.kind === 'commented' &&
          typeof commentId === 'string' &&
          asReporter.has(commentId));
      return {
        ...event,
        actor: (byReporter ? seesReporter : seesStaff) ? person : null,
        byReporter,
        // Done by a member of staff as such. Always the case when it is not
        // the reporter's doing; said outright because a reader with a
        // follow-up code gets no person to tell it by.
        byStaff: !byReporter,
        details: full ? event.details : this.forReporter(event),
      };
    });

    const commentRows = await tx
      .select({
        id: incidentComments.id,
        author: { id: author.id, name: author.name },
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
    const comments = commentRows.map(({ author: person, ...c }) => {
      const byReporter = asReporter.has(c.id);
      return {
        id: c.id,
        author: (byReporter ? seesReporter : seesStaff) ? person : null,
        byReporter,
        byStaff: !byReporter,
        body: c.body,
        visibility: c.visibility,
        createdAt: c.createdAt,
      };
    });

    const names = await this.namesIn(tx, events);
    return {
      // The incident's id and number, for everyone who is signed in.
      ...(seesStaff && { id: incidentId, reference }),
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
      // Its two deadlines and which of them it has missed, for those
      // handling it. Worked out now, from the status it is in.
      triageDueAt: full ? triageDue : null,
      closeDueAt: full ? closeDue : null,
      overdue: full ? overdueOf(row, new Date()) : null,
      needsSignOff: needsSignOff({ ...incident, signOffNeeded }),
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
        revisionRequired: m.revision === 'required',
        kind: m.kind,
      })),
      events,
      comments,
      // People are named here only where a timeline entry points at them as
      // the one an incident was assigned to, never as its reporter; and not
      // at all to a reader with a follow-up code.
      ...names,
      people: seesStaff ? names.people : {},
    };
  }

  /**
   * Whether a stored comment was written as the incident's reporter. Decided
   * when it was written and kept in `by_reporter`. A comment that carries
   * neither that nor `as_handler` was stored before the capacity was
   * recorded, or by a release that does not record it; it is then read the
   * way all comments were before: the reporter's if its author reported the
   * incident. That errs towards hiding a name, never towards showing one.
   */
  private writtenAsReporter(
    comment: {
      authorId: string | null;
      byReporter: boolean;
      asHandler: boolean;
    },
    reportedBy: string | null,
  ) {
    return (
      comment.byReporter ||
      (!comment.asHandler &&
        comment.authorId !== null &&
        comment.authorId === reportedBy)
    );
  }

  /**
   * What a timeline entry's details hold for a reader who sees the incident
   * only as its reporter. Why a closure request was sent back, or taken
   * back, is between the people handling it: the reporter learns that it
   * happened and not what was said.
   */
  private forReporter(event: { kind: EventKind; details: unknown }) {
    if (event.kind === 'sent_back') return null;
    const details = event.details as Record<string, unknown> | null;
    if (details?.withdrawn === true) return { withdrawn: true };
    return event.details;
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
        signOffNeeded: incidents.signOffNeeded,
        categoryId: incidents.categoryId,
        orgUnitId: incidents.orgUnitId,
        ownerUnitId: incidents.ownerUnitId,
        assignedTo: incidents.assignedTo,
        reportedBy: incidents.reportedBy,
        reportedAt: incidents.reportedAt,
        triagedBy: incidents.triagedBy,
        closeDueAt: incidents.closeDueAt,
        closureRequestedBy: incidents.closureRequestedBy,
      })
      .from(incidents)
      .where(and(eq(incidents.id, id), visibleTo(auth)))
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
      // A new gravity brings a new deadline for closing, counted as ever
      // from when it was reported, under the rules as they are now. The
      // deadline for triage is not moved: this triage is the one it was set
      // for, and moving it now would change whether it was met.
      const regraded = 'harmLevel' in changes || 'isSentinel' in changes;
      const closeDue = regraded
        ? closeDueAt(
            incident.reportedAt,
            next,
            await this.rules.inForce(tx),
            tenant.timeZone,
          )
        : incident.closeDueAt;
      const moved = closeDue?.getTime() !== incident.closeDueAt?.getTime();
      await tx
        .update(incidents)
        .set({
          ...next,
          assignedTo: input.assignedTo,
          status: to,
          // Never cleared: what has once called for a second person to
          // close it goes on needing one, whatever it is called later. What
          // it was until this triage counts too, in case it was stored by a
          // release that did not keep this.
          signOffNeeded:
            incident.signOffNeeded ||
            callsForSignOff(incident) ||
            callsForSignOff(next),
          ...(decided && { triagedBy: user.id, triagedAt: now }),
          ...(incident.status === 'new' && { firstTriagedAt: now }),
          // A deadline that moved is another deadline: what was announced
          // about the old one says nothing about this one.
          ...(moved && {
            closeDueAt: closeDue,
            closeDueSoonAt: null,
            closeOverdueAt: null,
          }),
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

      // The person it is now assigned to, and everyone who may triage the
      // department it has been handed to. Someone who is both is told once,
      // of the assignment.
      const handedOver = 'ownerUnitId' in changes;
      if ((personChanged && input.assignedTo) || handedOver) {
        await this.notifier.send(tx, tenant.id, {
          incident: {
            ...incident,
            ownerUnitId: input.ownerUnitId,
            assignedTo: input.assignedTo,
          },
          actorId: user.id,
          drafts: (who) => [
            ...(personChanged
              ? [
                  {
                    kind: 'incident_assigned',
                    to: [input.assignedTo],
                    internal: true,
                  } satisfies Draft,
                ]
              : []),
            ...(handedOver
              ? [
                  {
                    kind: 'incident_handed_over',
                    to: who.mayTriage([input.ownerUnitId]),
                    internal: true,
                  } satisfies Draft,
                ]
              : []),
          ],
        });
      }

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
    kind?: MoveKind,
  ) {
    const { tenant, user } = auth;
    // Told to someone who sees the incident and may not triage it.
    const noTriage = () =>
      new ForbiddenException(
        auth.permissions.includes('incidents.triage')
          ? { code: 'outside_scope' }
          : { code: 'missing_permission', permission: 'incidents.triage' },
      );
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
        throw noTriage();
      }
      this.assertFresh(incident, revision);
      const from = incident.status;
      const move = chooseMove(incident, to, caller, kind);
      // Two moves lead there from here, and the caller did not say which.
      if (move === 'kind_required') {
        throw new BadRequestException({ code: 'kind_required' });
      }
      if (move === 'missing_triage_permission') throw noTriage();
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
      // A signature is on what the signer read. Without the revision there
      // is no telling whether that is still what is stored.
      if (move.revision === 'required' && revision === undefined) {
        throw new BadRequestException({ code: 'revision_required' });
      }

      const now = new Date();
      const noRequest = { closureRequestedBy: null, closureRequestedAt: null };
      const fields: Record<MoveKind, Partial<typeof incidents.$inferInsert>> = {
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
          ...fields[move.kind],
        })
        .where(eq(incidents.id, id));
      const details = {
        ...(note && { note }),
        ...(move.kind === 'withdraw' && { withdrawn: true }),
      };
      await this.addEvent(tx, tenant.id, id, {
        kind: move.event,
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
        { from, to, kind: move.kind },
      );

      const subject: Subject = incident;
      const outcome: Partial<Record<MoveKind, string>> = {
        close: 'closed',
        sign_off: 'closed',
        reject: 'rejected',
        reopen: 'reopened',
      };
      const decision: Partial<Record<MoveKind, string>> = {
        sign_off: 'signed_off',
        send_back: 'sent_back',
      };
      const drafts = (who: Who): Draft[] => [
        // Whoever asked for the closure learns what became of the request.
        ...(decision[move.kind]
          ? [
              {
                kind: 'sign_off_decided',
                data: { decision: decision[move.kind]! },
                to: [incident.closureRequestedBy],
                internal: true,
              } satisfies Draft,
            ]
          : []),
        // Everyone who could give the second signature, except who asked.
        ...(move.kind === 'request_sign_off'
          ? [
              {
                kind: 'sign_off_requested',
                to: who.maySignOff(),
                internal: true,
              } satisfies Draft,
            ]
          : []),
        // The reporter, if named, and the person it is assigned to learn
        // that it has ended, or is open again.
        ...(outcome[move.kind]
          ? [
              {
                kind: 'status_changed',
                data: { change: outcome[move.kind]! },
                to: [incident.reportedBy, incident.assignedTo],
              } satisfies Draft,
            ]
          : []),
      ];
      await this.notifier.send(tx, tenant.id, {
        incident: subject,
        actorId: user.id,
        drafts,
      });
      return this.detail(tx, auth, id);
    });
  }

  /**
   * A comment by someone signed in. In what capacity it is written is
   * decided here, at this moment, and stored with it: as one of the people
   * handling the incident if the writer sees all of it, as its reporter if
   * they see it only because they reported it. It is never worked out later
   * from who the author is. So a handler who also reported the incident
   * comments under their own name like any other handler, and neither a
   * name on a comment nor "the reporter" on one tells a reader who reported.
   */
  comment(
    auth: AuthContext,
    id: string,
    input: { body: string; visibility: CommentVisibility },
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const [incident] = await tx
        .select({
          id: incidents.id,
          reference: incidents.reference,
          orgUnitId: incidents.orgUnitId,
          ownerUnitId: incidents.ownerUnitId,
          assignedTo: incidents.assignedTo,
          reportedBy: incidents.reportedBy,
          triagedBy: incidents.triagedBy,
        })
        .from(incidents)
        .where(and(eq(incidents.id, id), visibleTo(auth)))
        // Held, so the access checked here is the access at the moment the
        // comment is stored: nobody is taken off the incident in between.
        .for('update');
      if (!incident) throw new NotFoundException();
      const full = this.seesAll(auth, incident);
      // Someone who could not read an internal comment may not write one.
      if (!full && input.visibility === 'internal') {
        throw new ForbiddenException({ code: 'internal_not_allowed' });
      }
      return this.addComment(
        tx,
        tenant.id,
        incident,
        full
          ? { as: 'handler', authorId: user.id }
          : { as: 'reporter', authorId: user.id },
        input,
      );
    });
  }

  /**
   * Stores a comment with its timeline and audit entries, and tells the
   * people following the incident. Written as the reporter with no author,
   * it is the anonymous reporter's, written with their follow-up code:
   * nothing names anyone, anywhere.
   */
  private async addComment(
    tx: Transaction,
    tenantId: string,
    incident: Subject & { triagedBy: string | null },
    writer:
      | { as: 'handler'; authorId: string }
      | { as: 'reporter'; authorId: string | null },
    input: { body: string; visibility: CommentVisibility },
  ) {
    const { authorId } = writer;
    const byReporter = writer.as === 'reporter';
    const [created] = await tx
      .insert(incidentComments)
      .values({
        tenantId,
        incidentId: incident.id,
        authorId,
        byReporter,
        asHandler: !byReporter,
        body: input.body,
        visibility: input.visibility,
        createdAt: sql`clock_timestamp()`,
      })
      .returning({
        id: incidentComments.id,
        visibility: incidentComments.visibility,
        createdAt: incidentComments.createdAt,
      });
    await this.addEvent(tx, tenantId, incident.id, {
      kind: 'commented',
      actorId: authorId,
      details: { commentId: created.id, visibility: input.visibility },
      visibleToReporter: input.visibility === 'everyone',
    });
    await tx
      .update(incidents)
      .set({ updatedAt: new Date() })
      .where(eq(incidents.id, incident.id));
    await this.provisioning.audit(
      tx,
      tenantId,
      authorId,
      'incident_commented',
      'incident',
      incident.id,
      {
        commentId: created.id,
        visibility: input.visibility,
        ...(byReporter && { byReporter }),
      },
    );
    // The person it is assigned to and whoever triaged it; and the reporter,
    // if named, when the comment is one they may read. Not the writer. The
    // notification says that there is a comment, never whose: "the reporter
    // commented" would be as good as a name to whoever knows the rest.
    await this.notifier.send(tx, tenantId, {
      incident,
      actorId: authorId,
      drafts: () => [
        {
          kind: 'comment_added',
          to: [
            incident.assignedTo,
            incident.triagedBy,
            input.visibility === 'everyone' ? incident.reportedBy : null,
          ],
          internal: input.visibility === 'internal',
        },
      ],
    });
    return created;
  }

  /**
   * Finds the anonymous report a follow-up code belongs to, or null.
   *
   * The code is all there is to give: no reference goes with it. A wrong
   * code must be indistinguishable from any other wrong code, in what is
   * answered and in how long it takes, whether or not the hospital exists.
   * So every attempt takes the same steps: hash what was typed, one lookup
   * by that hash, then one comparison of hashes in constant time, against a
   * stand-in when nothing was found.
   */
  private async byFollowUpCode(tx: Transaction, code: string) {
    const [found] = await tx
      .select({
        id: incidents.id,
        hash: incidents.followUpCodeHash,
        reference: incidents.reference,
        orgUnitId: incidents.orgUnitId,
        ownerUnitId: incidents.ownerUnitId,
        assignedTo: incidents.assignedTo,
        reportedBy: incidents.reportedBy,
        triagedBy: incidents.triagedBy,
      })
      .from(incidents)
      .where(eq(incidents.followUpCodeHash, hashFollowUpCode(code)));
    const matches = matchesFollowUpCode(code, found?.hash ?? null);
    return found && matches ? found : null;
  }

  /**
   * An anonymous report as its reporter sees it, opened with the follow-up
   * code. `tenantId` is null when there is no hospital to ask (unknown or
   * suspended): the same steps are taken and the same 404 answered, so the
   * cases cannot be told apart. Whether the hospital takes reports without
   * sign-in does not matter here: a code given to a member of staff who
   * reported anonymously works in a hospital that never opened that form.
   *
   * No session is involved even if the caller has one: nothing here knows,
   * and so nothing can record, who is holding the code.
   */
  followUp(tenantId: string | null, code: string) {
    return this.tenantDb.withTenant(tenantId ?? NO_TENANT, async (tx) => {
      const found = await this.byFollowUpCode(tx, code);
      const view =
        found &&
        (await this.view(
          tx,
          eq(incidents.id, found.id),
          () => ANONYMOUS_REPORTER,
        ));
      if (!view) throw new NotFoundException();
      return view;
    });
  }

  /**
   * A comment by the anonymous reporter, for everyone on the incident.
   * Answered with the report as it now reads, their comment included, so
   * that writing one costs one attempt at the code and not two.
   */
  followUpComment(tenantId: string | null, code: string, body: string) {
    const scope = tenantId ?? NO_TENANT;
    return this.tenantDb.withTenant(scope, async (tx) => {
      const found = await this.byFollowUpCode(tx, code);
      if (!found) throw new NotFoundException();
      await this.addComment(
        tx,
        scope,
        found,
        { as: 'reporter', authorId: null },
        { body, visibility: 'everyone' },
      );
      const view = await this.view(
        tx,
        eq(incidents.id, found.id),
        () => ANONYMOUS_REPORTER,
      );
      if (!view) throw new NotFoundException();
      return view;
    });
  }
}
