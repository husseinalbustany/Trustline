import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { measureSnapshots, reportSettings } from '../database/schema.js';
import { startOfDay } from '../i18n/time-zones.js';
import {
  documentFigures,
  documentMeasures,
  incidentFigures,
  incidentMeasures,
  MEASURE_CODES,
  MEASURE_DEFINITIONS,
  ORGANIZATION_KEY,
  type MeasureCode,
  type MeasureValue,
} from './measures.js';

/** A module whose measures are taken. */
export type SnapshotModule = 'incidents' | 'policies';

/** The measures taken for a module. */
export const MODULE_MEASURES: Record<SnapshotModule, MeasureCode[]> = {
  incidents: MEASURE_CODES.filter((c) => MEASURE_DEFINITIONS[c].module === 'incidents' && MEASURE_DEFINITIONS[c].taken),
  policies: MEASURE_CODES.filter((c) => MEASURE_DEFINITIONS[c].module === 'policies' && MEASURE_DEFINITIONS[c].taken),
};

/** The first day of the month a day is in. */
export const monthOf = (day: string) => `${day.slice(0, 7)}-01`;
/** The first day of the month after. */
export function nextMonth(month: string) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
/** The months from one to another, both included. */
export function monthsBetween(from: string, to: string) {
  const out: string[] = [];
  for (let m = monthOf(from); m <= to; m = nextMonth(m)) out.push(m);
  return out;
}

/** A target in force, and where it comes from. */
export type Target = { value: number | null; source: 'business' | 'client' | 'baseline' | 'first_months' | null };
const NO_TARGET: Target = { value: null, source: null };

/** A month's figure for one measure and one unit, ready to be stored. */
export type SnapshotRow = {
  measure: MeasureCode;
  orgUnitId: string | null;
  unitBasis: string;
  unitPath: string[] | null;
  figure: MeasureValue;
  target: Target;
  startsAt: Date;
  asAt: Date;
};

/**
 * The lock of one client's month, taken by the check when it makes a month
 * final and by a correction (security review 16, L1), so that two never
 * add the same revision.
 */
export const monthLock = (tenantId: string, month: string) =>
  sql`hashtextextended(${`trustline.measures.${tenantId}.settle.${month}`}, 0)`;

/** The key of a measure and unit within a month. */
export const rowKey = (measure: string, orgUnitId: string | null) => `${measure} ${orgUnitId ?? ''}`;

/**
 * What a month was taken on, for working it out again (a correction, the
 * triage made final): its boundaries, its structure and the target of each
 * row, as stored, never as they are now (security review 16, M1). A later
 * change of target, time zone or structure never rewrites a past month.
 */
export type TakenOn = {
  startsAt: Date | null;
  asAt: Date;
  /** Each unit of the month, with its path from the top as it was. */
  structure: Map<string, string[]>;
  targets: Map<string, Target>;
};

/**
 * How a month's figures are worked out (docs/specs/reports-and-measures.md,
 * "How a snapshot is taken"), for the month-end check and for corrections,
 * in the client's transaction.
 */
@Injectable()
export class MeasureSnapshots {
  /**
   * The units of the month: every unit made before it ended, and in use
   * during it (in use now, or put out of use since it began), with the
   * path to each from the top.
   */
  async unitsOf(tx: Transaction, from: Date, asAt: Date) {
    const { rows } = await tx.execute<{ id: string; path: string[] }>(sql`
      with recursive up (id, ancestor, depth) as (
        select u.id, u.id, 0 from org_units u
        union
        select up.id, p.parent_id, up.depth + 1 from up join org_units p on p.id = up.ancestor
        where p.parent_id is not null
      )
      select u.id, array_agg(up.ancestor order by up.depth desc)::text[] as path
      from org_units u join up on up.id = u.id
      where u.created_at < ${asAt} and (u.active or u.updated_at >= ${from})
      group by u.id`);
    return rows;
  }

  /** The targets in force now: the client's own, else the business's; the baseline for reporting volume. */
  async targetsOf(tx: Transaction): Promise<Record<MeasureCode, Target>> {
    const [settings] = await tx.select().from(reportSettings);
    const out = {} as Record<MeasureCode, Target>;
    for (const code of MEASURE_CODES) {
      const own = settings?.targets?.[code];
      const business = MEASURE_DEFINITIONS[code].target;
      out[code] =
        typeof own === 'number'
          ? { value: own, source: 'client' }
          : business === null
            ? { value: null, source: null }
            : { value: business, source: 'business' };
    }
    // Reporting volume: above the client's figure from before Trustline,
    // or, with none, the average of its first three full months in it.
    if (settings?.baselineMonthlyAverage !== null && settings?.baselineMonthlyAverage !== undefined) {
      out['incidents.reported'] = { value: Number(settings.baselineMonthlyAverage), source: 'baseline' };
    } else {
      const first = await this.firstMonthsBaseline(tx);
      if (first !== null) out['incidents.reported'] = { value: first, source: 'first_months' };
    }
    return out;
  }

  /** The average of the first three full months' reports, for the organization; null before there are three. */
  async firstMonthsBaseline(tx: Transaction): Promise<number | null> {
    const { rows: started } = await tx.execute<{ started_on: string }>(
      sql`select started_on::text from module_starts where module = 'incidents'`,
    );
    const after = started[0] ? nextMonth(monthOf(started[0].started_on)) : null;
    const { rows } = await tx.execute<{ month: string; value: number }>(sql`
      select distinct on (month) month::text, value::float8 as value from measure_snapshots
      where measure = 'incidents.reported' and org_unit_id is null
        ${after ? sql`and month >= ${after}::date` : sql``}
      order by month, revision desc
      limit 3`);
    if (rows.length < 3) return null;
    return Math.round((rows.reduce((sum, r) => sum + Number(r.value), 0) / 3) * 10) / 10;
  }

  /**
   * One module's figures for a month, for the organization and every unit
   * of the month. `history`: the stock at the end of the month worked out
   * from the records' history (a month taken late, the backfill, a
   * correction); else read as the records stand. The triage is judged as
   * at `now`: what is still within its deadline makes it provisional.
   */
  async compute(
    tx: Transaction,
    input: {
      module: SnapshotModule;
      month: string;
      zone: string;
      history: boolean;
      now: Date;
      onlyUnits?: (string | null)[];
      /** Worked out again: on what the month was taken on. */
      takenOn?: TakenOn;
    },
  ): Promise<SnapshotRow[]> {
    const again = input.takenOn;
    const from = again?.startsAt ?? startOfDay(input.month, input.zone);
    const asAt = again?.asAt ?? startOfDay(nextMonth(input.month), input.zone);
    let units = again
      ? [...again.structure].map(([id, path]) => ({ id, path }))
      : await this.unitsOf(tx, from, asAt);
    // The whole structure of the month, for the subtrees; rows for those asked.
    const structure = again ? [...again.structure.values()] : undefined;
    if (input.onlyUnits) units = units.filter((u) => input.onlyUnits!.includes(u.id));
    const withOrganization = !input.onlyUnits || input.onlyUnits.includes(null);
    const ids = units.map((u) => u.id);
    const paths = new Map(units.map((u) => [u.id, u.path]));
    const targets = again ? null : await this.targetsOf(tx);
    const rows: SnapshotRow[] = [];
    const push = (key: string, figures: Partial<Record<MeasureCode, MeasureValue>>) => {
      const unit = key === ORGANIZATION_KEY ? null : key;
      if (unit === null && !withOrganization) return;
      for (const [code, figure] of Object.entries(figures) as [MeasureCode, MeasureValue][]) {
        rows.push({
          measure: code,
          orgUnitId: unit,
          unitBasis: MEASURE_DEFINITIONS[code].unitBasis,
          unitPath: unit ? (paths.get(unit) ?? [unit]) : null,
          figure,
          target: again
            ? (again.targets.get(rowKey(code, unit)) ?? NO_TARGET)
            : unit !== null && code === 'incidents.reported'
              ? // The organization's baseline is no unit's target (security review 16, M2).
                NO_TARGET
              : targets![code],
          startsAt: from,
          asAt,
        });
      }
    };
    const scope = { units: ids, ...(structure && { structure }) };
    if (input.module === 'incidents') {
      const range = { from, until: asAt, at: input.now };
      for (const [key, f] of await incidentFigures(tx, { units: null, ...range })) push(key, incidentMeasures(f));
      for (const [key, f] of await incidentFigures(tx, { ...scope, ...range })) push(key, incidentMeasures(f));
    } else {
      // The day after the month on its own calendar, as it was taken.
      const at = { day: nextMonth(input.month), asAt: input.history ? asAt : null };
      for (const [key, f] of await documentFigures(tx, { units: null, ...at })) push(key, documentMeasures(f));
      for (const [key, f] of await documentFigures(tx, { ...scope, ...at })) push(key, documentMeasures(f));
    }
    return rows;
  }

  /**
   * What a month was taken on (TakenOn): from its stored rows, the latest
   * revision of each measure and unit.
   */
  async takenOn(tx: Transaction, month: string): Promise<TakenOn | null> {
    const rows = await tx
      .selectDistinctOn([measureSnapshots.measure, measureSnapshots.orgUnitId], {
        measure: measureSnapshots.measure,
        orgUnitId: measureSnapshots.orgUnitId,
        unitPath: measureSnapshots.unitPath,
        target: measureSnapshots.target,
        targetSource: measureSnapshots.targetSource,
        startsAt: measureSnapshots.startsAt,
        asAt: measureSnapshots.asAt,
      })
      .from(measureSnapshots)
      .where(eq(measureSnapshots.month, month))
      .orderBy(asc(measureSnapshots.measure), asc(measureSnapshots.orgUnitId), sql`${measureSnapshots.revision} desc`);
    if (rows.length === 0) return null;
    const structure = new Map<string, string[]>();
    const targets = new Map<string, Target>();
    for (const r of rows) {
      if (r.orgUnitId) structure.set(r.orgUnitId, r.unitPath ?? [r.orgUnitId]);
      targets.set(rowKey(r.measure, r.orgUnitId), {
        value: r.target === null ? null : Number(r.target),
        source: (r.targetSource as Target['source']) ?? null,
      });
    }
    const first = rows[0];
    return { startsAt: first.startsAt, asAt: first.asAt, structure, targets };
  }

  /** Stores rows as one revision each, after the latest of their month, measure and unit. */
  async store(
    tx: Transaction,
    tenantId: string,
    month: string,
    rows: SnapshotRow[],
    how: {
      method: 'snapshot' | 'reconstructed' | 'corrected';
      reason?: string | null;
      requestedBy?: string | null;
      status?: 'provisional' | 'final';
    },
  ) {
    if (rows.length === 0) return [];
    const latest = await this.latest(tx, month, [...new Set(rows.map((r) => r.measure))]);
    const values = rows.map((r) => {
      const before = latest.get(rowKey(r.measure, r.orgUnitId));
      return {
        tenantId,
        month,
        measure: r.measure,
        orgUnitId: r.orgUnitId,
        unitBasis: r.unitBasis,
        unitPath: r.unitPath,
        value: r.figure.value,
        numerator: r.figure.numerator,
        denominator: r.figure.denominator,
        details: r.figure.details,
        target: r.target.value,
        targetSource: r.target.source,
        status: how.status ?? (r.figure.provisional ? ('provisional' as const) : ('final' as const)),
        method: how.method,
        revision: (before?.revision ?? 0) + 1,
        reason: how.reason ?? null,
        requestedBy: how.requestedBy ?? null,
        startsAt: r.startsAt,
        asAt: r.asAt,
        definitionVersion: MEASURE_DEFINITIONS[r.measure].definitionVersion,
      };
    });
    // What was written, not what was meant to be: a revision another
    // writer took first is left out (security review 16, L1).
    const written = new Set<string>();
    for (let i = 0; i < values.length; i += 500) {
      const inserted = await tx
        .insert(measureSnapshots)
        .values(values.slice(i, i + 500))
        .onConflictDoNothing()
        .returning({ measure: measureSnapshots.measure, orgUnitId: measureSnapshots.orgUnitId });
      for (const r of inserted) written.add(rowKey(r.measure, r.orgUnitId));
    }
    return values.filter((v) => written.has(rowKey(v.measure, v.orgUnitId)));
  }

  /** The latest revision of each measure and unit of a month. */
  async latest(tx: Transaction, month: string, measures: string[]) {
    const rows = await tx
      .selectDistinctOn([measureSnapshots.measure, measureSnapshots.orgUnitId], {
        measure: measureSnapshots.measure,
        orgUnitId: measureSnapshots.orgUnitId,
        revision: measureSnapshots.revision,
        status: measureSnapshots.status,
        method: measureSnapshots.method,
        value: measureSnapshots.value,
        numerator: measureSnapshots.numerator,
        denominator: measureSnapshots.denominator,
      })
      .from(measureSnapshots)
      .where(and(eq(measureSnapshots.month, month), inArray(measureSnapshots.measure, measures)))
      .orderBy(asc(measureSnapshots.measure), asc(measureSnapshots.orgUnitId), sql`${measureSnapshots.revision} desc`);
    return new Map(rows.map((r) => [rowKey(r.measure, r.orgUnitId), r]));
  }

  /** The months of a module that have figures, any revision. */
  async takenMonths(tx: Transaction, module: SnapshotModule) {
    const { rows } = await tx.execute<{ month: string }>(sql`
      select distinct month::text as month from measure_snapshots
      where measure = any(array[${sql.join(MODULE_MEASURES[module].map((c) => sql`${c}`), sql`, `)}]::text[])`);
    return new Set(rows.map((r) => r.month));
  }

  /** The months whose triage is still provisional, by its latest revision of the organization or a unit. */
  async provisionalMonths(tx: Transaction) {
    const { rows } = await tx.execute<{ month: string }>(sql`
      select distinct month::text as month from (
        select distinct on (month, coalesce(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)) month, status
        from measure_snapshots where measure = 'incidents.triaged_on_time'
        order by month, coalesce(org_unit_id, '00000000-0000-0000-0000-000000000000'::uuid), revision desc) t
      where status = 'provisional'`);
    return rows.map((r) => r.month);
  }
}

