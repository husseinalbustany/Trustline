import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { measureSnapshots, orgUnits, reportSettings, users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { fitsLanguages, pickText, type Locale, type Localized } from '../i18n/locales.js';
import { dayOf, momentIn, startOfDay } from '../i18n/time-zones.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { reachOf } from '../identity/scope.js';
import { csv, csvFileName } from '../policies/csv.js';
import {
  documentFigures,
  documentMeasures,
  incidentFigures,
  incidentMeasures,
  MEASURE_CODES,
  MEASURE_DEFINITIONS,
  metOf,
  ORGANIZATION_KEY,
  type MeasureCode,
  type MeasureValue,
} from './measures.js';
import { MeasureSnapshots, MODULE_MEASURES, monthLock, monthOf, rowKey, type SnapshotModule } from './snapshots.service.js';
import { REPORTS_WORDING } from './wording/index.js';

/** The most months a series is asked for at once. */
export const MAX_MONTHS = 120;
/** The most rows a CSV holds, as every other export. */
const EXPORT_CAP = 50_000;

export type SeriesQuery = { from: string; to: string; unitId?: string; measures?: MeasureCode[] };

type Reach = 'all' | string[];
const reaches = (r: Reach, unitId: string | null) => r === 'all' || (unitId !== null && r.includes(unitId));

/** `YYYY-MM` as the month's first day. */
export const firstDay = (month: string) => `${month}-01`;

/**
 * The Reports API's figures (docs/specs/reports-and-measures.md, "Who sees
 * what"), scoped as the screens are, so that the page tells nobody what
 * their screens would not:
 *
 * - **The page:** `reports.view`. For the organization, for the whole of
 *   it; for a unit, over it (a unit out of reach is 404, as if not there).
 * - **Incident measures:** also `incidents.view` or `incidents.triage` over
 *   the unit (the organization: everywhere). Seeing incidents only as their
 *   reporter or assignee shows no figures here.
 * - **How reports arrived** (public link, anonymous or named): only with
 *   `incidents.see_reporter` over the unit too. One anonymous report in a
 *   ward, counted for someone handling it, would tell them it was.
 * - **Document measures:** also `policies.manage` or `policies.view_all`
 *   over the unit (full sight).
 * - **Modules:** the measures of a module the client does not have are
 *   absent, as if they did not exist.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly snapshots: MeasureSnapshots,
    private readonly provisioning: ProvisioningService,
  ) {}

  /** Refuses a unit out of reach (404) or the organization without the whole of it (403). */
  private async scope(tx: Transaction, auth: AuthContext, unitId: string | undefined) {
    const reports = reachOf(auth, ['reports.view']);
    if (unitId) {
      const [unit] = await tx.select({ id: orgUnits.id }).from(orgUnits).where(eq(orgUnits.id, unitId));
      if (!unit || !reaches(reports, unitId)) throw new NotFoundException();
    } else if (reports !== 'all') {
      throw new ForbiddenException({ code: 'missing_permission', permission: 'reports.view' });
    }
    const unit = unitId ?? null;
    const has = (m: string) => (auth.tenant.modules as string[]).includes(m);
    const visible = MEASURE_CODES.filter((code) => {
      const def = MEASURE_DEFINITIONS[code];
      if (!def.taken || !has(def.module)) return false;
      if (def.module === 'incidents') return reaches(reachOf(auth, ['incidents.view', 'incidents.triage']), unit);
      if (def.module === 'policies') return reaches(reachOf(auth, ['policies.manage', 'policies.view_all']), unit);
      return false;
    });
    return { unit, visible, toldReporters: reaches(reachOf(auth, ['incidents.see_reporter']), unit) };
  }

  /**
   * What a figure's details may say to this caller: how reports arrived
   * only to those told reporters, and never for a unit row of a month whose
   * unit has gained or lost units since (`moved`): the difference between
   * two such rows would tell one unit's split (security review 16, L5).
   */
  private detailsFor(code: MeasureCode, details: Record<string, unknown>, toldReporters: boolean, moved = false) {
    if (code !== 'incidents.reported' || (toldReporters && !moved)) return details;
    const { channel: _channel, ...rest } = details;
    return rest;
  }

  /**
   * A row's target as this caller may be told it. The reporting volume's
   * target is the organization's baseline: no unit's target, and a figure
   * of the whole organization (security review 16, M2).
   */
  private targetOf(code: MeasureCode, unit: string | null, target: { value: number | null; source: string | null }) {
    return unit !== null && code === 'incidents.reported' ? { value: null, source: null } : target;
  }

  /**
   * The months, among these, whose stored subtree of the unit is not its
   * subtree now: a unit taken that month moved in or out since. Compared
   * over the units that had figures that month.
   */
  private async movedMonths(tx: Transaction, unit: string, from: string, to: string) {
    const { rows: now } = await tx.execute<{ id: string }>(sql`
      with recursive t (id) as (
        select ${unit}::uuid
        union
        select u.id from org_units u join t on u.parent_id = t.id
      ) select id from t`);
    const today = new Set(now.map((r) => r.id));
    const { rows } = await tx.execute<{ month: string; org_unit_id: string; inside: boolean }>(sql`
      select distinct month::text as month, org_unit_id, coalesce(${unit}::uuid = any(unit_path), false) as inside
      from measure_snapshots
      where measure = 'incidents.reported' and org_unit_id is not null
        and month between ${firstDay(from)}::date and ${firstDay(to)}::date`);
    const moved = new Set<string>();
    for (const r of rows) if (r.inside !== today.has(r.org_unit_id)) moved.add(r.month);
    return moved;
  }

  /** The latest revision of each month of these measures, for one unit or the organization. */
  private async series(tx: Transaction, unit: string | null, measures: MeasureCode[], from: string, to: string) {
    if (measures.length === 0) return [];
    return tx
      .selectDistinctOn([measureSnapshots.measure, measureSnapshots.month])
      .from(measureSnapshots)
      .where(
        and(
          sql`${measureSnapshots.measure} = any(array[${sql.join(measures.map((m) => sql`${m}`), sql`, `)}]::text[])`,
          unit === null ? sql`${measureSnapshots.orgUnitId} is null` : eq(measureSnapshots.orgUnitId, unit),
          sql`${measureSnapshots.month} between ${firstDay(from)}::date and ${firstDay(to)}::date`,
        ),
      )
      .orderBy(asc(measureSnapshots.measure), asc(measureSnapshots.month), desc(measureSnapshots.revision));
  }

  /** The month so far, worked out now, as the dashboard works it out. */
  private async live(tx: Transaction, auth: AuthContext, unit: string | null, measures: MeasureCode[], now: Date) {
    const zone = auth.tenant.timeZone;
    const today = dayOf(now, zone);
    const scope = unit === null ? { units: null } : { units: [unit] };
    const key = unit ?? ORGANIZATION_KEY;
    const out: Partial<Record<MeasureCode, MeasureValue>> = {};
    if (measures.some((m) => MEASURE_DEFINITIONS[m].module === 'incidents')) {
      const f = (await incidentFigures(tx, { ...scope, from: startOfDay(monthOf(today), zone), until: new Date(now.getTime() + 60_000), at: now })).get(key)!;
      Object.assign(out, incidentMeasures(f));
    }
    if (measures.some((m) => MEASURE_DEFINITIONS[m].module === 'policies')) {
      const f = (await documentFigures(tx, { ...scope, day: today, asAt: null })).get(key)!;
      Object.assign(out, documentMeasures(f));
    }
    return out;
  }

  /** Each measure the caller may see: its months, and the month so far. */
  measures(auth: AuthContext, query: SeriesQuery) {
    const now = new Date();
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { unit, visible, toldReporters } = await this.scope(tx, auth, query.unitId);
      const asked = query.measures ? visible.filter((m) => query.measures!.includes(m)) : visible;
      const rows = await this.series(tx, unit, asked, query.from, query.to);
      const live = await this.live(tx, auth, unit, asked, now);
      const targets = await this.snapshots.targetsOf(tx);
      const moved =
        unit !== null && toldReporters && asked.includes('incidents.reported')
          ? await this.movedMonths(tx, unit, query.from, query.to)
          : new Set<string>();
      return {
        unitId: unit,
        measures: asked.map((code) => {
          const def = MEASURE_DEFINITIONS[code];
          const current = live[code]!;
          const target = this.targetOf(code, unit, targets[code]);
          return {
            code,
            module: def.module,
            direction: def.direction,
            valueUnit: def.valueUnit,
            definitionVersion: def.definitionVersion,
            target: target.value,
            targetSource: target.source,
            months: rows
              .filter((r) => r.measure === code)
              .map((r) => {
                const value = r.value === null ? null : Number(r.value);
                const kept = this.targetOf(code, unit, { value: r.target === null ? null : Number(r.target), source: r.targetSource });
                return {
                  month: r.month.slice(0, 7),
                  value,
                  numerator: r.numerator,
                  denominator: r.denominator,
                  target: kept.value,
                  targetSource: kept.source,
                  met: metOf(def.direction, value, kept.value),
                  status: r.status,
                  method: r.method,
                  revision: r.revision,
                  correctedAt: r.method === 'corrected' ? r.takenAt : null,
                  asAt: r.asAt,
                  takenAt: r.takenAt,
                  definitionVersion: r.definitionVersion,
                  details: this.detailsFor(code, r.details, toldReporters, moved.has(r.month)),
                };
              }),
            current: {
              month: monthOf(dayOf(now, auth.tenant.timeZone)).slice(0, 7),
              value: current.value,
              numerator: current.numerator,
              denominator: current.denominator,
              met: metOf(def.direction, current.value, target.value),
              provisional: current.provisional,
              asOf: now,
              details: this.detailsFor(code, current.details, toldReporters),
            },
          };
        }),
      };
    });
  }

  /** Every revision of one month of one measure, with why each was made. */
  history(auth: AuthContext, code: string, query: { month: string; unitId?: string }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { unit, visible, toldReporters } = await this.scope(tx, auth, query.unitId);
      if (!(visible as string[]).includes(code)) throw new NotFoundException();
      const measure = code as MeasureCode;
      const rows = await tx
        .select({ row: measureSnapshots, requesterName: users.name })
        .from(measureSnapshots)
        .leftJoin(users, eq(users.id, measureSnapshots.requestedBy))
        .where(
          and(
            eq(measureSnapshots.measure, measure),
            eq(measureSnapshots.month, firstDay(query.month)),
            unit === null ? sql`${measureSnapshots.orgUnitId} is null` : eq(measureSnapshots.orgUnitId, unit),
          ),
        )
        .orderBy(asc(measureSnapshots.revision));
      const def = MEASURE_DEFINITIONS[measure];
      const moved =
        unit !== null && toldReporters && measure === 'incidents.reported'
          ? (await this.movedMonths(tx, unit, query.month, query.month)).size > 0
          : false;
      // A correction's reason is written for the whole organization, and
      // may name wards or people: shown on a unit's row only to those who
      // read reports for all of it (security review 16, L4).
      const toldReasons = unit === null || reachOf(auth, ['reports.view']) === 'all';
      return {
        code: measure,
        month: query.month,
        unitId: unit,
        revisions: rows.map(({ row: r, requesterName }) => {
          const value = r.value === null ? null : Number(r.value);
          const kept = this.targetOf(measure, unit, { value: r.target === null ? null : Number(r.target), source: r.targetSource });
          return {
            revision: r.revision,
            value,
            numerator: r.numerator,
            denominator: r.denominator,
            target: kept.value,
            met: metOf(def.direction, value, kept.value),
            status: r.status,
            method: r.method,
            reason: toldReasons ? r.reason : null,
            requestedBy: r.requestedBy ? { id: r.requestedBy, name: requesterName } : null,
            asAt: r.asAt,
            takenAt: r.takenAt,
            definitionVersion: r.definitionVersion,
            details: this.detailsFor(measure, r.details, toldReporters, moved),
          };
        }),
      };
    });
  }

  /** The months of the measures as a CSV file, in the caller's language. Audited. */
  exportMeasures(auth: AuthContext, query: SeriesQuery, locale: Locale) {
    const zone = auth.tenant.timeZone;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { unit, visible } = await this.scope(tx, auth, query.unitId);
      const asked = query.measures ? visible.filter((m) => query.measures!.includes(m)) : visible;
      const rows = (await this.series(tx, unit, asked, query.from, query.to)).slice(0, EXPORT_CAP);
      const w = REPORTS_WORDING[locale];
      let unitName: string = w.organization;
      let unitPath = '';
      if (unit) {
        const { rows: found } = await tx.execute<{ name: Localized; path: string }>(sql`
          with recursive up (id, name, depth) as (
            select id, name, 0 from org_units where id = ${unit}
            union all
            select p.id, p.name, up.depth + 1 from up join org_units u on u.id = up.id join org_units p on p.id = u.parent_id
          ) select (select name from up where depth = 0) as name,
                   string_agg(name ->> ${locale}, ' / ' order by depth desc) as path from up`);
        const pick = (n: Localized) => pickText(n, locale, auth.tenant.defaultLocale);
        unitName = found[0] ? pick(found[0].name) : unit;
        unitPath = found[0]?.path ?? '';
      }
      const body = csv(
        [w.csv.month, w.csv.unit, w.csv.unitPath, w.csv.measure, w.csv.value, w.csv.numerator, w.csv.denominator, w.csv.target, w.csv.met, w.csv.status, w.csv.method, w.csv.revision, w.csv.asAt, w.csv.definitionVersion],
        rows.map((r) => {
          const def = MEASURE_DEFINITIONS[r.measure as MeasureCode];
          const value = r.value === null ? null : Number(r.value);
          const target = this.targetOf(r.measure as MeasureCode, unit, { value: r.target === null ? null : Number(r.target), source: r.targetSource }).value;
          const met = metOf(def.direction, value, target);
          return [
            r.month.slice(0, 7),
            unitName,
            unitPath,
            w.measures[r.measure as MeasureCode],
            value,
            r.numerator,
            r.denominator,
            target,
            met === null ? null : met ? w.yes : w.no,
            w.status[r.status],
            w.method[r.method],
            r.revision,
            momentIn(r.asAt, zone),
            r.definitionVersion,
          ];
        }),
      );
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'measures_exported', 'tenant', auth.tenant.id, {
        filters: { ...query },
        locale,
        rows: rows.length,
      });
      return { body, fileName: csvFileName('measures', dayOf(new Date(), zone)) };
    });
  }

  /**
   * A correction: the month's figures worked out again by Trustline, as at
   * the same end of the month, from the records as they are now, never
   * typed in; a new revision of each, with the reason. For the
   * organization and every unit of the month, or one unit.
   */
  correct(auth: AuthContext, input: { month: string; measures: MeasureCode[]; unitId?: string; reason: string }) {
    const now = new Date();
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { visible } = await this.scope(tx, auth, input.unitId);
      const measures = input.measures.filter((m) => visible.includes(m));
      if (measures.length !== input.measures.length) throw new NotFoundException();
      const month = firstDay(input.month);
      // One correction per client at a time, and never beside the check
      // making the same month final (security review 16, L1 and L6): a
      // correction works a month out again for every unit, so a second one
      // waits its turn (409).
      const { rows: free } = await tx.execute<{ client: boolean; month: boolean }>(sql`
        select pg_try_advisory_xact_lock(hashtextextended(${`trustline.measures.${auth.tenant.id}.correct`}, 0)) as client,
               pg_try_advisory_xact_lock(${monthLock(auth.tenant.id, month)}) as month`);
      if (!free[0].client || !free[0].month) throw new ConflictException({ code: 'correction_in_progress' });
      const latest = await this.snapshots.latest(tx, month, measures);
      const units = input.unitId ? [input.unitId] : [...new Set([...latest.values()].map((r) => r.orgUnitId))];
      const takenOn = await this.snapshots.takenOn(tx, month);
      if (!takenOn || latest.size === 0 || (input.unitId && ![...latest.values()].some((r) => r.orgUnitId === input.unitId))) {
        throw new ConflictException({ code: 'no_snapshot' });
      }
      const revisions: { measure: MeasureCode; unitId: string | null; revision: number; from: unknown; to: unknown }[] = [];
      for (const module of ['incidents', 'policies'] as SnapshotModule[]) {
        const mine = measures.filter((m) => MODULE_MEASURES[module].includes(m));
        if (mine.length === 0) continue;
        // On what the month was taken on: its targets, boundaries and
        // structure; only the figures are worked out again (security
        // review 16, M1).
        const rows = (
          await this.snapshots.compute(tx, { module, month, zone: auth.tenant.timeZone, history: true, now, onlyUnits: units, takenOn })
        ).filter((r) => mine.includes(r.measure) && latest.has(rowKey(r.measure, r.orgUnitId)));
        const stored = await this.snapshots.store(tx, auth.tenant.id, month, rows, {
          method: 'corrected',
          reason: input.reason,
          requestedBy: auth.user.id,
        });
        // A revision taken by another writer meanwhile: nothing is kept.
        if (stored.length !== rows.length) throw new ConflictException({ code: 'stale_measures' });
        for (const s of stored) {
          const before = latest.get(rowKey(s.measure, s.orgUnitId))!;
          revisions.push({
            measure: s.measure,
            unitId: s.orgUnitId,
            revision: s.revision,
            from: { value: before.value === null ? null : Number(before.value), numerator: before.numerator, denominator: before.denominator },
            to: { value: s.value, numerator: s.numerator, denominator: s.denominator },
          });
        }
      }
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'measure_correction_requested', 'tenant', auth.tenant.id, {
        month: input.month,
        measures,
        unitId: input.unitId ?? null,
        reason: input.reason,
        values: revisions,
      });
      return { month: input.month, revisions };
    });
  }

  /** The client's targets and baseline, with the business's beside them. */
  settings(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) => this.settingsIn(tx, auth));
  }

  /**
   * The settings as this caller may read them. The baseline and the
   * reporting-volume target are figures of the organization's reports:
   * only for those who see incident figures for all of it (security review
   * 16, M2). A module the client lacks has no targets here.
   */
  private async settingsIn(tx: Transaction, auth: AuthContext) {
    const [row] = await tx.select().from(reportSettings);
    const targets = await this.snapshots.targetsOf(tx);
    const has = (m: string) => (auth.tenant.modules as string[]).includes(m);
    const reportsAll = has('incidents') && reachOf(auth, ['incidents.view', 'incidents.triage']) === 'all';
    return {
      revision: row?.revision ?? 0,
      targets: MEASURE_CODES.filter(
        (c) => c !== 'incidents.reported' && MEASURE_DEFINITIONS[c].taken && has(MEASURE_DEFINITIONS[c].module),
      ).map((code) => ({
        code,
        module: MEASURE_DEFINITIONS[code].module,
        direction: MEASURE_DEFINITIONS[code].direction,
        business: MEASURE_DEFINITIONS[code].target,
        client: typeof row?.targets?.[code] === 'number' ? row.targets[code] : null,
        effective: targets[code].value,
      })),
      baseline:
        reportsAll && row?.baselineMonthlyAverage !== null && row?.baselineMonthlyAverage !== undefined
          ? { monthlyAverage: Number(row.baselineMonthlyAverage), note: row.baselineNote }
          : null,
      firstMonthsBaseline: reportsAll ? await this.snapshots.firstMonthsBaseline(tx) : null,
      reportedTarget: reportsAll
        ? { value: targets['incidents.reported'].value, source: targets['incidents.reported'].source }
        : null,
    };
  }

  /** Changes the client's targets or baseline: audited, on its revision. */
  updateSettings(
    auth: AuthContext,
    input: {
      targets?: Partial<Record<MeasureCode, number | null>>;
      baseline?: { monthlyAverage: number; note: Localized } | null;
      revision: number;
    },
  ) {
    if (input.baseline?.note && !fitsLanguages(input.baseline.note, auth.tenant)) {
      throw new BadRequestException({ code: 'language_mismatch', field: 'baseline.note' });
    }
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [row] = await tx.select().from(reportSettings).for('update');
      if ((row?.revision ?? 0) !== input.revision) throw new ConflictException({ code: 'stale_settings' });
      const targets: Record<string, number> = { ...row?.targets };
      const changes: Record<string, unknown> = {};
      if (input.targets) {
        const changed: Record<string, { from: number | null; to: number | null }> = {};
        for (const [code, value] of Object.entries(input.targets)) {
          const from = typeof targets[code] === 'number' ? targets[code] : null;
          if (value === null || value === undefined) delete targets[code];
          else targets[code] = value;
          const to = typeof targets[code] === 'number' ? targets[code] : null;
          if (from !== to) changed[code] = { from, to };
        }
        if (Object.keys(changed).length > 0) changes.targets = changed;
      }
      const baselineBefore =
        row?.baselineMonthlyAverage !== null && row?.baselineMonthlyAverage !== undefined
          ? { monthlyAverage: Number(row.baselineMonthlyAverage), note: row.baselineNote }
          : null;
      if (input.baseline !== undefined && JSON.stringify(input.baseline) !== JSON.stringify(baselineBefore)) {
        changes.baseline = { from: baselineBefore, to: input.baseline };
      }
      if (Object.keys(changes).length === 0) return this.settingsIn(tx, auth);
      const values = {
        targets,
        ...(input.baseline !== undefined && {
          baselineMonthlyAverage: input.baseline?.monthlyAverage ?? null,
          baselineNote: input.baseline?.note ?? null,
        }),
        revision: (row?.revision ?? 0) + 1,
        updatedAt: new Date(),
        updatedBy: auth.user.id,
      };
      if (row) await tx.update(reportSettings).set(values).where(eq(reportSettings.tenantId, auth.tenant.id));
      else {
        // Two first changes at once: the second finds the row made, and is
        // stale (security review 16, L7).
        const made = await tx
          .insert(reportSettings)
          .values({ tenantId: auth.tenant.id, ...values })
          .onConflictDoNothing()
          .returning({ tenantId: reportSettings.tenantId });
        if (made.length === 0) throw new ConflictException({ code: 'stale_settings' });
      }
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'report_settings_changed', 'tenant', auth.tenant.id, changes);
      return this.settingsIn(tx, auth);
    });
  }
}
