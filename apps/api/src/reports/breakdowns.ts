import { sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { incidentHarmLevel, incidentType } from '../database/schema.js';
import type { Localized } from '../i18n/locales.js';
import { startOfDay } from '../i18n/time-zones.js';
import { monthsBetween, nextMonth } from './snapshots.service.js';

export const BREAKDOWNS = ['month', 'type', 'harm', 'category', 'unit', 'channel'] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];
export const INCIDENT_TYPES = incidentType.enumValues;
export const HARM_LEVELS = incidentHarmLevel.enumValues;
/** How a report arrived, each report in one: the public link, anonymous in the app, named. */
export const CHANNELS = ['public', 'anonymous', 'named'] as const;

export type BreakdownQuery = {
  from: string;
  to: string;
  unitId?: string;
  by: Breakdown;
  type?: (typeof INCIDENT_TYPES)[number];
  harmLevel?: (typeof HARM_LEVELS)[number];
};

export type BreakdownRow = {
  /** The month (`YYYY-MM`), type, harm level, category id, unit id or channel. */
  key: string;
  count: number;
  /** Whole percent to one place, of every report counted. */
  share: number | null;
  /** By category (the Pareto chart): this one and those before it. */
  runningShare?: number | null;
  /** By month: the month so far. */
  partial?: boolean;
  /** By category and unit: the name as written, for `pick()`. */
  name?: Localized;
  code?: string;
  /** By unit: the reports where they happened at the unit itself, not beneath it. */
  here?: boolean;
};

const shareOf = (n: number, total: number) => (total === 0 ? null : Math.round((n / total) * 1000) / 10);

/** The median of a run of counts (the run chart's centre line). */
export function medianOf(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The reports sent in a period (docs/specs/reports-and-measures.md, step 5),
 * counted by one breakdown, for the organization or one unit and what lies
 * beneath (where they happened, `org_unit_id`), from the records as they are
 * now: their type, harm level and category as triage left them, and the
 * structure as it is today. `from` and `until` are moments of the client's
 * calendar; months are the client's (`zone`).
 *
 * Who may ask, and for what, is the caller's business (ReportsService).
 */
export async function incidentBreakdown(
  tx: Transaction,
  input: BreakdownQuery & { unit: string | null; zone: string; from_: Date; until: Date; currentMonth: string },
) {
  const tree = input.unit
    ? sql`with recursive tree (id) as (
        select ${input.unit}::uuid
        union
        select u.id from org_units u join tree t on u.parent_id = t.id
      )`
    : sql``;
  const where: SQL[] = [sql`i.reported_at >= ${input.from_}`, sql`i.reported_at < ${input.until}`];
  if (input.unit) where.push(sql`i.org_unit_id in (select id from tree)`);
  if (input.type) where.push(sql`i.type = ${input.type}`);
  if (input.harmLevel) where.push(sql`i.harm_level = ${input.harmLevel}`);
  const filter = sql.join(where, sql` and `);

  const [{ total }] = (
    await tx.execute<{ total: number }>(sql`${tree} select count(*)::int as total from incidents i where ${filter}`)
  ).rows;
  const counted = async (key: SQL) =>
    new Map(
      (
        await tx.execute<{ key: string; n: number }>(
          sql`${tree} select ${key} as key, count(*)::int as n from incidents i where ${filter} group by 1`,
        )
      ).rows.map((r) => [r.key, r.n]),
    );
  const row = (key: string, count: number, extra: Partial<BreakdownRow> = {}): BreakdownRow => ({
    key,
    count,
    share: shareOf(count, total),
    ...extra,
  });

  let rows: BreakdownRow[];
  let median: number | null = null;
  switch (input.by) {
    case 'month': {
      const n = await counted(sql`to_char(i.reported_at at time zone ${input.zone}, 'YYYY-MM')`);
      // Every month asked for up to this one, none in the future; zeros too.
      const months = monthsBetween(`${input.from}-01`, `${input.to}-01`)
        .map((m) => m.slice(0, 7))
        .filter((m) => m <= input.currentMonth);
      rows = months.map((m) => row(m, n.get(m) ?? 0, { partial: m === input.currentMonth }));
      // Of the whole months only: the month so far is not yet a month.
      median = medianOf(rows.filter((r) => !r.partial).map((r) => r.count));
      break;
    }
    case 'type': {
      const n = await counted(sql`i.type::text`);
      rows = INCIDENT_TYPES.map((t) => row(t, n.get(t) ?? 0));
      break;
    }
    case 'harm': {
      const n = await counted(sql`i.harm_level::text`);
      rows = HARM_LEVELS.map((h) => row(h, n.get(h) ?? 0));
      break;
    }
    case 'channel': {
      const n = await counted(
        sql`case when i.channel = 'public' then 'public' when i.reported_by is null then 'anonymous' else 'named' end`,
      );
      rows = CHANNELS.map((c) => row(c, n.get(c) ?? 0));
      break;
    }
    case 'category': {
      // The Pareto chart: the categories reported, most first, each with
      // the running share of every report counted.
      const { rows: found } = await tx.execute<{ id: string; code: string; name: Localized; n: number }>(sql`${tree}
        select c.id, c.code, c.name, count(*)::int as n
        from incidents i join incident_categories c on c.id = i.category_id
        where ${filter}
        group by c.id, c.code, c.name, c.position
        order by n desc, c.position, c.code`);
      let running = 0;
      rows = found.map((c) => {
        running += c.n;
        return row(c.id, c.n, { code: c.code, name: c.name, runningShare: shareOf(running, total) });
      });
      break;
    }
    case 'unit': {
      // Each unit directly beneath (for the organization, each at the top),
      // counting itself and what lies beneath it; then the unit's own.
      const { rows: found } = await tx.execute<{ id: string; name: Localized; n: number }>(sql`
        with recursive children (id, name, top) as (
          select u.id, u.name, u.id from org_units u
          where ${input.unit ? sql`u.parent_id = ${input.unit}::uuid` : sql`u.parent_id is null`}
        ), below (id, top) as (
          select id, top from children
          union
          select u.id, b.top from org_units u join below b on u.parent_id = b.id
        )${input.unit ? sql`, tree (id) as (select ${input.unit}::uuid union select id from below)` : sql``}
        select c.id, c.name, (
          select count(*)::int from incidents i
          where ${filter} and i.org_unit_id in (select b.id from below b where b.top = c.id)
        ) as n
        from children c`);
      const sorted = found.sort((x, y) => y.n - x.n || x.id.localeCompare(y.id));
      rows = sorted.map((u) => row(u.id, u.n, { name: u.name }));
      if (input.unit) {
        const [{ n }] = (
          await tx.execute<{ n: number }>(sql`${tree} select count(*)::int as n from incidents i where ${filter} and i.org_unit_id = ${input.unit}::uuid`)
        ).rows;
        rows.push(row(input.unit, n, { here: true }));
      }
      break;
    }
  }
  return { total, rows, median };
}

/** The first moment of the period, and the moment after its end, never after now. */
export function periodOf(from: string, to: string, zone: string, now: Date) {
  const start = startOfDay(`${from}-01`, zone);
  const end = startOfDay(nextMonth(to), zone);
  return { from_: start, until: end > now ? now : end };
}
