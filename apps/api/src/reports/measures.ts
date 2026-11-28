import { sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { documentAcknowledgements, documents, incidents, users } from '../database/schema.js';

/**
 * The business's success measures (docs/business-requirements.md, "Success
 * measures"; docs/specs/reports-and-measures.md, "The measures"), defined
 * once. The dashboard's live figures (`IncidentsService.summary`,
 * `LibraryService.summary`), the month-end snapshots and the Reports API
 * all work them out here, so that the same words always mean the same
 * number.
 *
 * Each has its module, its target and the direction it is met in (the
 * business's default; a client may set its own), what its value is
 * counted in, which unit a record counts for, and a definition version:
 * a changed definition is a new version, which applies from the month it
 * is released.
 */
export type MeasureDefinition = {
  code: MeasureCode;
  module: 'incidents' | 'policies' | 'actions';
  /** The business's target; null: the client's baseline (reporting volume). */
  target: number | null;
  /** Met when the value is `below`, `at_least` or `above` the target. */
  direction: 'below' | 'at_least' | 'above';
  /** What the value is counted in. */
  valueUnit: 'seconds' | 'percent' | 'count';
  /** Which unit a record counts for. */
  unitBasis: 'occurred_in' | 'owner' | 'person';
  definitionVersion: number;
  /** Not taken yet: its module does not exist. */
  taken: boolean;
};

export const MEASURE_CODES = [
  'incidents.time_to_report',
  'incidents.reported',
  'incidents.triaged_on_time',
  'actions.overdue',
  'policies.past_review',
  'policies.acknowledged',
] as const;
export type MeasureCode = (typeof MEASURE_CODES)[number];

export const MEASURE_DEFINITIONS: Record<MeasureCode, MeasureDefinition> = {
  // Median seconds from opening the form to sending it, over the reports
  // sent in the month that carry a start time: under two minutes.
  'incidents.time_to_report': {
    code: 'incidents.time_to_report',
    module: 'incidents',
    target: 120,
    direction: 'below',
    valueUnit: 'seconds',
    unitBasis: 'occurred_in',
    definitionVersion: 1,
    taken: true,
  },
  // Reports sent in the month: above the baseline within six months.
  'incidents.reported': {
    code: 'incidents.reported',
    module: 'incidents',
    target: null,
    direction: 'above',
    valueUnit: 'count',
    unitBasis: 'occurred_in',
    definitionVersion: 1,
    taken: true,
  },
  // Of the reports sent in the month, decided or past their first triage
  // deadline, the share whose first decision came by that deadline.
  'incidents.triaged_on_time': {
    code: 'incidents.triaged_on_time',
    module: 'incidents',
    target: 95,
    direction: 'at_least',
    valueUnit: 'percent',
    unitBasis: 'occurred_in',
    definitionVersion: 1,
    taken: true,
  },
  // Defined now, taken once the actions module exists.
  'actions.overdue': {
    code: 'actions.overdue',
    module: 'actions',
    target: 10,
    direction: 'below',
    valueUnit: 'percent',
    unitBasis: 'owner',
    definitionVersion: 1,
    taken: false,
  },
  // At the end of the month, active documents whose next review was before
  // it ended, as a share of active documents: under 5%.
  'policies.past_review': {
    code: 'policies.past_review',
    module: 'policies',
    target: 5,
    direction: 'below',
    valueUnit: 'percent',
    unitBasis: 'owner',
    definitionVersion: 1,
    taken: true,
  },
  // At the end of the month, of the acknowledgements asked on the version
  // in force of an active document, of people still active, due before it
  // ended, the share given: 90% or more.
  'policies.acknowledged': {
    code: 'policies.acknowledged',
    module: 'policies',
    target: 90,
    direction: 'at_least',
    valueUnit: 'percent',
    unitBasis: 'person',
    definitionVersion: 1,
    taken: true,
  },
};

/** The two document targets, as the dashboard has always named them. */
export const MEASURES = {
  pastReviewBelow: MEASURE_DEFINITIONS['policies.past_review'].target!,
  acknowledgedAtLeast: MEASURE_DEFINITIONS['policies.acknowledged'].target!,
};

/** Reports sent in under this many seconds count as quick. */
export const QUICK_REPORT_SECONDS = 120;

/** A share as a whole percentage (triage, as the dashboard shows it). */
export const wholePercent = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((100 * part) / whole);
/** A share to a tenth of a percent (the document measures). */
export const tenthPercent = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((1000 * part) / whole) / 10;

/** Whether a value meets its target. Null when either is missing. */
export function metOf(direction: MeasureDefinition['direction'], value: number | null, target: number | null) {
  if (value === null || target === null) return null;
  return direction === 'below' ? value < target : direction === 'above' ? value > target : value >= target;
}

/**
 * Rows for the whole organization (`null`) or for each of these units and
 * what lies beneath. `structure`: the paths from the top to each unit as
 * they were (a month's stored `unit_path`s), for a month worked out again
 * on the structure it was taken on (decision 3); else the structure now.
 */
export type UnitScope = { units: null } | { units: string[]; structure?: string[][] };
const ORGANIZATION = '';

/** The pairs (ancestor, unit) of a structure as it was, for the units asked for. */
export function subtreesOf(units: string[], structure: string[][]) {
  const asked = new Set(units);
  const pairs = new Set<string>();
  for (const id of units) pairs.add(`${id} ${id}`);
  for (const path of structure) {
    const unit = path[path.length - 1];
    for (const ancestor of path) if (asked.has(ancestor)) pairs.add(`${ancestor} ${unit}`);
  }
  return [...pairs].map((p) => p.split(' ') as [string, string]);
}

/** The subtree of each unit asked for, as `tree(ancestor, unit)`. */
const treeOf = (scope: { units: string[]; structure?: string[][] }) =>
  scope.structure
    ? sql`
  with tree (ancestor, unit) as (
    select (e ->> 0)::uuid, (e ->> 1)::uuid
    from jsonb_array_elements(${JSON.stringify(subtreesOf(scope.units, scope.structure))}::jsonb) e
  )`
    : sql`
  with recursive tree (ancestor, unit) as (
    select u.id, u.id from org_units u
    where u.id = any(array[${sql.join(scope.units.map((id) => sql`${id}`), sql`, `)}]::uuid[])
    union
    select t.ancestor, u.id from tree t join org_units u on u.parent_id = t.unit
  )`;

const keyOf = (unit: string | null) => unit ?? ORGANIZATION;

export type IncidentFigures = {
  reported: number;
  byType: Record<string, number>;
  byHarm: Record<string, number>;
  byCategory: Record<string, number>;
  /** How reports arrived: given out only to those told reporters. */
  channel: { public: number; anonymous: number; named: number };
  medianSeconds: number | null;
  withStartTime: number;
  quick: number;
  triageMeasured: number;
  triageOnTime: number;
  /** Reports of the period neither decided nor past their deadline yet. */
  triagePending: number;
};

const emptyIncidents = (): IncidentFigures => ({
  reported: 0,
  byType: {},
  byHarm: {},
  byCategory: {},
  channel: { public: 0, anonymous: 0, named: 0 },
  medianSeconds: null,
  withStartTime: 0,
  quick: 0,
  triageMeasured: 0,
  triageOnTime: 0,
  triagePending: 0,
});

/**
 * The incident measures over the reports sent in [from, until), for the
 * organization or each unit (where they happened, and beneath), within
 * `where` (a caller's visibility, for the live figures). The triage is
 * judged as at `at`: a report decided by then is judged by its first
 * decision against its first deadline; one undecided past its deadline is
 * late already; one undecided before it is pending.
 */
export async function incidentFigures(
  tx: Transaction,
  input: UnitScope & { from: Date; until: Date; at: Date; where?: SQL },
): Promise<Map<string, IncidentFigures>> {
  const out = new Map<string, IncidentFigures>();
  const keys = input.units === null ? [null] : input.units;
  for (const k of keys) out.set(keyOf(k), emptyIncidents());
  if (input.units !== null && input.units.length === 0) return out;
  const scope = input.units === null ? sql`` : treeOf(input);
  const from = input.units === null ? sql`from ${incidents}` : sql`from ${incidents} join tree t on t.unit = ${incidents.orgUnitId}`;
  const unit = input.units === null ? sql`null::uuid` : sql`t.ancestor`;
  const where = sql`${incidents.reportedAt} >= ${input.from} and ${incidents.reportedAt} < ${input.until}${input.where ? sql` and ${input.where}` : sql``}`;
  const seconds = sql`greatest(extract(epoch from ${incidents.reportedAt} - ${incidents.reportStartedAt}), 0)`;
  const due = sql`coalesce(${incidents.firstTriageDueAt}, ${incidents.triageDueAt})`;
  const decided = sql`(${incidents.firstTriagedAt} is not null and ${incidents.firstTriagedAt} <= ${input.at})`;
  const undecided = sql`(${incidents.firstTriagedAt} > ${input.at} or (${incidents.firstTriagedAt} is null and ${incidents.status} = 'new'))`;
  const measured = sql`(${incidents.triageDueAt} is not null and (${decided} or (${undecided} and ${due} < ${input.at})))`;
  const { rows } = await tx.execute<{
    unit: string | null;
    reported: number;
    median: number | null;
    with_start: number;
    quick: number;
    measured: number;
    on_time: number;
    pending: number;
    public: number;
    anonymous: number;
    named: number;
  }>(sql`${scope}
    select ${unit} as unit,
      count(*)::int as reported,
      round(percentile_cont(0.5) within group (order by ${seconds}) filter (where ${incidents.reportStartedAt} is not null))::int as median,
      (count(*) filter (where ${incidents.reportStartedAt} is not null))::int as with_start,
      (count(*) filter (where ${incidents.reportStartedAt} is not null and ${seconds} < ${QUICK_REPORT_SECONDS}))::int as quick,
      (count(*) filter (where ${measured}))::int as measured,
      (count(*) filter (where ${measured} and ${decided} and ${incidents.firstTriagedAt} <= ${due}))::int as on_time,
      (count(*) filter (where ${incidents.triageDueAt} is not null and ${undecided} and ${due} >= ${input.at}))::int as pending,
      (count(*) filter (where ${incidents.channel} = 'public'))::int as public,
      (count(*) filter (where ${incidents.reportedBy} is null))::int as anonymous,
      (count(*) filter (where ${incidents.reportedBy} is not null))::int as named
    ${from}
    where ${where}
    group by 1`);
  for (const r of rows) {
    const f = out.get(keyOf(r.unit))!;
    Object.assign(f, {
      reported: r.reported,
      medianSeconds: r.median,
      withStartTime: r.with_start,
      quick: r.quick,
      triageMeasured: r.measured,
      triageOnTime: r.on_time,
      triagePending: r.pending,
      channel: { public: r.public, anonymous: r.anonymous, named: r.named },
    });
  }
  for (const [dimension, column] of [
    ['byType', incidents.type],
    ['byHarm', incidents.harmLevel],
    ['byCategory', incidents.categoryId],
  ] as const) {
    const { rows: split } = await tx.execute<{ unit: string | null; value: string; n: number }>(sql`${scope}
      select ${unit} as unit, ${column}::text as value, count(*)::int as n
      ${from}
      where ${where}
      group by 1, 2`);
    for (const r of split) out.get(keyOf(r.unit))![dimension][r.value] = r.n;
  }
  return out;
}

export type DocumentFigures = {
  active: number;
  pastReview: number;
  acknowledgementsDue: number;
  acknowledgementsGiven: number;
  /** Everyone asked, due or not: the dashboard's "as it stands". */
  acknowledgementsAsked: number;
  acknowledgementsAskedGiven: number;
};

const emptyDocuments = (): DocumentFigures => ({
  active: 0,
  pastReview: 0,
  acknowledgementsDue: 0,
  acknowledgementsGiven: 0,
  acknowledgementsAsked: 0,
  acknowledgementsAskedGiven: 0,
});

/** The actions that set a document's next review, and where they put it. */
const nextReviewIn = sql`case a.action when 'document_updated' then a.changes -> 'nextReviewOn' ->> 'to' else a.changes ->> 'nextReviewOn' end`;

/**
 * The document measures at the end of a day (`day`, exclusive: what stands
 * before it), for the organization or each unit (owning unit for the
 * documents; for the acknowledgements, the person's own unit, on
 * documents owned within that unit), within
 * `where` (documents) and `acknowledgedWhere` (the acknowledgements' documents).
 *
 * `asAt` null: from the records as they stand (the live figure, and a
 * snapshot taken on time). A moment: from their history, as they stood
 * then (a month taken late, the backfill, a correction):
 * - active: a version published before it, and not retired by then;
 * - the next review date: the last one set before it (published,
 *   reviewed, review approved, changed), else the one it has now;
 * - the version in force: the last published before it;
 * - a person active then: their last change of status before it, else the
 *   status they changed from after it, else the one they have now;
 * - an acknowledgement given before it.
 */
export async function documentFigures(
  tx: Transaction,
  input: UnitScope & { day: string; asAt: Date | null; where?: SQL; acknowledgedWhere?: SQL },
): Promise<Map<string, DocumentFigures>> {
  const out = new Map<string, DocumentFigures>();
  const keys = input.units === null ? [null] : input.units;
  for (const k of keys) out.set(keyOf(k), emptyDocuments());
  if (input.units !== null && input.units.length === 0) return out;
  const scope = input.units === null ? sql`` : treeOf(input);
  const unit = input.units === null ? sql`null::uuid` : sql`t.ancestor`;
  const at = input.asAt;
  const active = at
    ? sql`(exists (select from document_versions v where v.document_id = ${documents.id} and v.published_at < ${at})
           and (${documents.retiredAt} is null or ${documents.retiredAt} >= ${at}))`
    : sql`${documents.status} = 'active'`;
  const nextReview = at
    ? sql`coalesce((select (${nextReviewIn})::date from audit_log a
          where a.entity_type = 'document' and a.entity_id = ${documents.id} and a.occurred_at < ${at}
            and a.action in ('document_published', 'document_reviewed', 'document_review_approved', 'document_updated')
            and ${nextReviewIn} is not null
          order by a.occurred_at desc limit 1), ${documents.nextReviewOn})`
    : sql`${documents.nextReviewOn}`;
  const docsFrom = input.units === null
    ? sql`from ${documents}`
    : sql`from ${documents} join tree t on t.unit = ${documents.ownerUnitId}`;
  const { rows: docs } = await tx.execute<{ unit: string | null; active: number; past: number }>(sql`${scope}
    select ${unit} as unit,
      (count(*) filter (where ${active}))::int as active,
      (count(*) filter (where ${active} and ${nextReview} < ${input.day}::date))::int as past
    ${docsFrom}
    where true ${input.where ? sql`and ${input.where}` : sql``}
    group by 1`);
  for (const r of docs) Object.assign(out.get(keyOf(r.unit))!, { active: r.active, pastReview: r.past });

  const inForce = at
    ? sql`${documentAcknowledgements.versionId} = (select v.id from document_versions v
          where v.document_id = ${documents.id} and v.published_at < ${at} order by v.published_at desc limit 1)`
    : sql`${documentAcknowledgements.versionId} = ${documents.publishedVersionId}`;
  const personActive = at
    ? sql`(${users.createdAt} < ${at} and coalesce(
          (select a.changes -> 'status' ->> 'to' from audit_log a
            where a.entity_type = 'user' and a.entity_id = ${users.id} and a.action = 'user_updated'
              and a.changes ? 'status' and a.occurred_at < ${at} order by a.occurred_at desc limit 1),
          (select a.changes -> 'status' ->> 'from' from audit_log a
            where a.entity_type = 'user' and a.entity_id = ${users.id} and a.action = 'user_updated'
              and a.changes ? 'status' and a.occurred_at >= ${at} order by a.occurred_at asc limit 1),
          ${users.status}::text) = 'active')`
    : sql`${users.status} = 'active'`;
  const given = at
    ? sql`${documentAcknowledgements.acknowledgedAt} < ${at}`
    : sql`${documentAcknowledgements.acknowledgedAt} is not null`;
  const due = sql`${documentAcknowledgements.dueOn} < ${input.day}::date`;
  const acksFrom = sql`from ${documentAcknowledgements}
    join ${documents} on ${documents.id} = (select v.document_id from document_versions v where v.id = ${documentAcknowledgements.versionId})
    join ${users} on ${users.id} = ${documentAcknowledgements.userId}
    ${input.units === null
      ? sql``
      : // A unit's own people, on documents owned within the same unit
        // (security review 16, L3): what full sight over it shows.
        sql`join tree t on t.unit = ${users.orgUnitId}
        join tree o on o.ancestor = t.ancestor and o.unit = ${documents.ownerUnitId}`}`;
  const { rows: acks } = await tx.execute<{ unit: string | null; due: number; given: number; asked: number; asked_given: number }>(sql`${scope}
    select ${unit} as unit,
      (count(*) filter (where ${due}))::int as due,
      (count(*) filter (where ${due} and ${given}))::int as given,
      count(*)::int as asked,
      (count(*) filter (where ${given}))::int as asked_given
    ${acksFrom}
    where ${active} and ${inForce} and ${personActive}
      ${input.acknowledgedWhere ? sql`and ${input.acknowledgedWhere}` : sql``}
    group by 1`);
  for (const r of acks) {
    Object.assign(out.get(keyOf(r.unit))!, {
      acknowledgementsDue: r.due,
      acknowledgementsGiven: r.given,
      acknowledgementsAsked: r.asked,
      acknowledgementsAskedGiven: r.asked_given,
    });
  }
  return out;
}

/** One measure's figure, as stored and shown. */
export type MeasureValue = {
  value: number | null;
  numerator: number | null;
  denominator: number | null;
  details: Record<string, unknown>;
  /** Not settled yet: the triage of reports still within their deadline. */
  provisional: boolean;
};

/** The incident measures' figures, from the figures above. */
export function incidentMeasures(f: IncidentFigures): Record<'incidents.time_to_report' | 'incidents.reported' | 'incidents.triaged_on_time', MeasureValue> {
  return {
    'incidents.time_to_report': {
      value: f.medianSeconds,
      numerator: f.quick,
      denominator: f.withStartTime,
      details: { quickShare: wholePercent(f.quick, f.withStartTime), withStartTime: f.withStartTime, reported: f.reported },
      provisional: false,
    },
    'incidents.reported': {
      value: f.reported,
      numerator: f.reported,
      denominator: null,
      details: {
        byType: f.byType,
        byHarm: f.byHarm,
        byCategory: f.byCategory,
        nearMissShare: wholePercent(f.byType.near_miss ?? 0, f.reported),
        channel: f.channel,
      },
      provisional: false,
    },
    'incidents.triaged_on_time': {
      value: wholePercent(f.triageOnTime, f.triageMeasured),
      numerator: f.triageOnTime,
      denominator: f.triageMeasured,
      details: { pending: f.triagePending },
      provisional: f.triagePending > 0,
    },
  };
}

/** The document measures' figures. */
export function documentMeasures(f: DocumentFigures): Record<'policies.past_review' | 'policies.acknowledged', MeasureValue> {
  return {
    'policies.past_review': {
      value: tenthPercent(f.pastReview, f.active),
      numerator: f.pastReview,
      denominator: f.active,
      details: {},
      provisional: false,
    },
    'policies.acknowledged': {
      value: tenthPercent(f.acknowledgementsGiven, f.acknowledgementsDue),
      numerator: f.acknowledgementsGiven,
      denominator: f.acknowledgementsDue,
      details: {},
      provisional: false,
    },
  };
}

export const ORGANIZATION_KEY = ORGANIZATION;
