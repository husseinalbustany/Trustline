import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { pgErrorCode } from '../database/errors.js';
import {
  riskBands,
  riskCategories,
  riskCommittees,
  riskEvents,
  riskImpactDomains,
  riskMatrices,
  riskMatrixCells,
  riskAcceptances,
  riskMatrixLevels,
  risks,
  riskSettings,
  roles,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import { fitsLanguages, sameText, type Localized } from '../i18n/locales.js';
import { dayOf, shiftDay } from '../i18n/time-zones.js';
import { LinkedDocuments } from '../policies/linked-documents.js';
import type { BandCode } from './defaults.js';
import type {
  CategoryCreateInput,
  CategoryUpdateInput,
  CommitteeCreateInput,
  CommitteeUpdateInput,
  MatrixCreateInput,
  MatrixUpdateInput,
  SettingsInput,
} from './input.js';
import {
  assertSound,
  bandAt,
  bandOf,
  loadMatrix,
  matrixHead,
  matrixRefusal,
  partsOf,
  rankOf,
  type Matrix,
  type MatrixParts,
} from './matrix.js';

/** The most impact domains a version holds, switched off ones included. */
export const MAX_DOMAINS = 12;

/** The starting values of a client with no `risk_settings` row. */
export const DEFAULT_RISK_SETTINGS = {
  inherentRequired: true,
  frameworkDocumentId: null as string | null,
  assessmentThresholdBand: 'high' as BandCode,
  acceptanceMaxMonths: 12,
  revision: 1,
};

/** The client's settings of the module, in the caller's transaction. */
export async function riskSettingsOf(tx: Transaction, lock = false) {
  const query = tx
    .select({
      inherentRequired: riskSettings.inherentRequired,
      frameworkDocumentId: riskSettings.frameworkDocumentId,
      assessmentThresholdBand: riskSettings.assessmentThresholdBand,
      acceptanceMaxMonths: riskSettings.acceptanceMaxMonths,
      revision: riskSettings.revision,
    })
    .from(riskSettings);
  const [row] = lock ? await query.for('update') : await query;
  return row ?? { ...DEFAULT_RISK_SETTINGS };
}

const categoryFields = {
  id: riskCategories.id,
  code: riskCategories.code,
  name: riskCategories.name,
  position: riskCategories.position,
  active: riskCategories.active,
  appetite: riskCategories.appetite,
  appetiteStatement: riskCategories.appetiteStatement,
  toleranceBand: riskCategories.toleranceBand,
  revision: riskCategories.revision,
};

const committeeFields = {
  id: riskCommittees.id,
  code: riskCommittees.code,
  name: riskCommittees.name,
  position: riskCommittees.position,
  memberRoleId: riskCommittees.memberRoleId,
  chairRoleId: riskCommittees.chairRoleId,
  active: riskCommittees.active,
  revision: riskCommittees.revision,
};

/**
 * A value as text, objects with their keys in order: `jsonb` gives back a
 * localized text with its languages in its own order.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : v,
  );

/** What changed between two records, field by field, for the audit log. */
export function changesOf(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, to] of Object.entries(after)) {
    if (to === undefined) continue;
    if (canonical(to) === canonical(before[field] ?? null)) continue;
    changes[field] = { from: before[field] ?? null, to };
  }
  return changes;
}

const isUnique = (e: unknown) => pgErrorCode(e) === '23505';

/** A matrix as the settings screens show it. */
const viewOf = (m: Matrix) => ({
  id: m.id,
  version: m.version,
  status: m.status,
  likelihoodLevels: m.likelihoodLevels,
  impactLevels: m.impactLevels,
  putInUseAt: m.putInUseAt,
  putInUseBy: m.putInUseBy,
  revision: m.revision,
  likelihood: m.likelihood,
  impact: m.impact,
  domains: m.domains,
  bands: m.bands,
  cells: m.cells,
});

type Copy = { l: number | null; i: number | null; band: BandCode | null; matrix: string | null };

/**
 * The settings of the risks module, which belong to the whole
 * organization: the matrix and its versions, categories with appetite and
 * tolerance, committees, and the few settings of `risk_settings`. Read by
 * anyone signed in with the module (the rating dialog and the forms need
 * them), changed only by those who manage risks for the whole organization
 * (the controller checks), each change audited in its transaction. Nothing
 * here is deleted: a category or a committee is switched off, a matrix
 * retired.
 */
@Injectable()
export class RiskSettingsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly documents: LinkedDocuments,
  ) {}

  private assertLanguages(
    auth: AuthContext,
    names: (Localized | null | undefined)[],
    wording: (Localized | null | undefined)[] = [],
  ) {
    const ok =
      names.every((n) => n === undefined || fitsLanguages(n, auth.tenant)) &&
      wording.every((w) => fitsLanguages(w, auth.tenant, { required: false }));
    if (!ok) throw new BadRequestException({ code: 'language_mismatch' });
  }

  // The settings.

  /**
   * The module's settings with the matrix in use, the active categories
   * and the active committees: what a form or the rating dialog needs.
   * The framework document is named by its number, when the policies
   * module is on.
   */
  settings(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const settings = await riskSettingsOf(tx);
      const matrix = await loadMatrix(tx, { inUse: true });
      const categories = await this.categoryRows(tx, false);
      const committees = await this.committeeRows(tx, false);
      return {
        ...settings,
        frameworkDocument: await this.frameworkDocument(
          tx,
          auth,
          settings.frameworkDocumentId,
        ),
        matrix: matrix ? viewOf(matrix) : null,
        categories,
        committees,
      };
    });
  }

  private async frameworkDocument(
    tx: Transaction,
    auth: AuthContext,
    id: string | null,
  ) {
    if (!id) return null;
    // A link to a module that is off is kept, and shown again when it is
    // back (modules-and-subscriptions.md, "Links are optional").
    if (!auth.tenant.modules.includes('policies')) return null;
    // As the reader may be told of it: a restricted document they may not
    // open is only "a restricted document" (security review 15, L1).
    const found = (await this.documents.describe(tx, auth, [id]))[id];
    return found
      ? { id, restricted: found.restricted, number: found.number, status: found.status, title: found.title }
      : null;
  }

  /**
   * Changes the settings, given the revision the caller read (409
   * `stale_settings`). The framework must be a document in force of the
   * client's library (400 `unknown_document`), and the policies module on.
   */
  updateSettings(auth: AuthContext, input: SettingsInput) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      // Created if missing, then locked: two changes at once take turns.
      await tx
        .insert(riskSettings)
        .values({ tenantId: auth.tenant.id })
        .onConflictDoNothing();
      const before = await riskSettingsOf(tx, true);
      if (before.revision !== input.revision) {
        throw new ConflictException({ code: 'stale_settings' });
      }
      const { revision: _revision, ...fields } = input;
      if (fields.frameworkDocumentId) {
        const linkable =
          auth.tenant.modules.includes('policies') &&
          (await this.documents.linkable(tx, auth, fields.frameworkDocumentId));
        if (!linkable) {
          throw new BadRequestException({ code: 'unknown_document' });
        }
      }
      const changes = changesOf(before, fields);
      if (Object.keys(changes).length > 0) {
        await tx
          .update(riskSettings)
          .set({
            ...fields,
            revision: sql`${riskSettings.revision} + 1`,
            updatedBy: auth.user.id,
            updatedAt: new Date(),
          })
          .where(eq(riskSettings.tenantId, auth.tenant.id));
        await this.provisioning.audit(
          tx,
          auth.tenant.id,
          auth.user.id,
          'risk_settings_changed',
          'tenant',
          auth.tenant.id,
          changes,
        );
      }
      const after = await riskSettingsOf(tx);
      return {
        ...after,
        frameworkDocument: await this.frameworkDocument(
          tx,
          auth,
          after.frameworkDocumentId,
        ),
      };
    });
  }

  // The matrix and its versions.

  matrices(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select(matrixHead)
        .from(riskMatrices)
        .orderBy(desc(riskMatrices.version)),
    );
  }

  /**
   * One version. A draft comes, for those who manage risks for the whole
   * organization (who alone may put it in use), with what putting it in use
   * would do: how many risks on the register would change band, how many
   * have a rating it cannot hold (a level beyond its size) and would need
   * re-rating, and how many would have their target above their current
   * rating. Anyone else gets `preview: null`: the counts are of risks
   * across the organization (security review 15, L2).
   */
  matrix(auth: AuthContext, id: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const matrix = await loadMatrix(tx, { id });
      if (!matrix) throw new NotFoundException();
      const preview =
        matrix.status === 'draft' && covers(auth, 'risks.manage', null)
          ? (({ changed, outOfRange, targetAbove }) => ({
              risksChangingBand: changed.length,
              risksOutOfRange: outOfRange.length,
              risksTargetAboveCurrent: targetAbove.length,
            }))(await this.rebanding(tx, matrix))
          : null;
      return { ...viewOf(matrix), preview };
    });
  }

  /**
   * A new draft version: a copy of another version (its size, wording,
   * bands and cells), or a whole matrix as given. One draft at a time
   * (409 `draft_exists`).
   */
  createMatrix(auth: AuthContext, input: MatrixCreateInput) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      let parts: MatrixParts;
      let copiedFromId: string | null = null;
      if ('copyOf' in input) {
        const source = await loadMatrix(tx, { id: input.copyOf });
        if (!source) throw new BadRequestException({ code: 'unknown_matrix' });
        parts = partsOf(source);
        copiedFromId = source.id;
      } else {
        parts = input;
        await assertSound(tx, parts, auth.tenant);
      }
      const [{ last }] = await tx
        .select({ last: max(riskMatrices.version) })
        .from(riskMatrices);
      let matrix;
      try {
        [matrix] = await tx
          .insert(riskMatrices)
          .values({
            tenantId: auth.tenant.id,
            version: (last ?? 0) + 1,
            likelihoodLevels: parts.likelihoodLevels,
            impactLevels: parts.impactLevels,
            createdBy: auth.user.id,
          })
          .returning({ id: riskMatrices.id, version: riskMatrices.version });
      } catch (e) {
        if (isUnique(e)) throw new ConflictException({ code: 'draft_exists' });
        throw e;
      }
      await this.writeParts(tx, auth.tenant.id, matrix.id, parts);
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'risk_matrix_created',
        'risk_matrix',
        matrix.id,
        {
          version: matrix.version,
          likelihoodLevels: parts.likelihoodLevels,
          impactLevels: parts.impactLevels,
          copiedFromId,
        },
      );
      return viewOf((await loadMatrix(tx, { id: matrix.id }))!);
    });
  }

  private async writeParts(
    tx: Transaction,
    tenantId: string,
    matrixId: string,
    parts: MatrixParts,
  ) {
    await tx.insert(riskMatrixLevels).values(
      parts.levels.map((l) => ({
        tenantId,
        matrixId,
        axis: l.axis,
        level: l.level,
        label: l.label,
        descriptor: l.descriptor,
        frequency: l.axis === 'likelihood' ? l.frequency : null,
      })),
    );
    await tx.insert(riskImpactDomains).values(
      parts.domains.map((d) => ({
        tenantId,
        matrixId,
        name: d.name,
        descriptors: d.descriptors,
        position: d.position,
        active: d.active,
      })),
    );
    await tx.insert(riskBands).values(
      parts.bands.map((b) => ({ tenantId, matrixId, ...b })),
    );
    await tx.insert(riskMatrixCells).values(
      parts.cells.map((c) => ({
        tenantId,
        matrixId,
        likelihood: c.likelihood,
        impact: c.impact,
        bandCode: c.band,
      })),
    );
  }

  /**
   * Changes a version, part by part, given the revision the caller read
   * (409 `stale_matrix`). A draft takes any change but of its size (409
   * `matrix_size_fixed`: make a new draft of the size wanted). A version
   * in use takes only wording: labels, descriptors, frequencies, band
   * names and domains, which apply at once; anything that decides a band
   * (its size, cells, review intervals, escalation, signature) is 409
   * `matrix_in_use`, to be made in a new version. A retired one takes
   * nothing (409 `matrix_retired`).
   */
  updateMatrix(auth: AuthContext, id: string, input: MatrixUpdateInput) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const matrix = await loadMatrix(tx, { id }, 'update');
      if (!matrix) throw new NotFoundException();
      if (matrix.revision !== input.revision) {
        throw new ConflictException({ code: 'stale_matrix' });
      }
      if (matrix.status === 'retired') throw matrixRefusal('retired');
      const resized =
        (input.likelihoodLevels !== undefined &&
          input.likelihoodLevels !== matrix.likelihoodLevels) ||
        (input.impactLevels !== undefined &&
          input.impactLevels !== matrix.impactLevels);
      if (resized) {
        throw matrix.status === 'draft'
          ? new ConflictException({ code: 'matrix_size_fixed' })
          : matrixRefusal('in_use');
      }
      // What the caller writes fits the client's languages; what is
      // stored is not checked again (the starting wording is in all three).
      this.assertLanguages(
        auth,
        [
          ...(input.levels ?? []).map((l) => l.label),
          ...(input.domains ?? []).map((d) => d.name),
          ...(input.bands ?? []).map((b) => b.name),
        ],
        [
          ...(input.levels ?? []).flatMap((l) => [l.descriptor, l.frequency]),
          ...(input.domains ?? []).flatMap((d) => Object.values(d.descriptors)),
        ],
      );
      const parts = partsOf(matrix);
      const changed: Record<string, unknown> = {};

      // Levels: wording only, at any status.
      const levelChanges = [];
      for (const l of input.levels ?? []) {
        const current = parts.levels.find(
          (p) => p.axis === l.axis && p.level === l.level,
        );
        if (!current) throw new BadRequestException({ code: 'level_out_of_range' });
        const next = {
          ...current,
          label: l.label,
          descriptor: l.descriptor,
          frequency: l.axis === 'likelihood' ? l.frequency : null,
        };
        if (l.axis === 'impact' && l.frequency) {
          throw new BadRequestException({ code: 'frequency_of_impact' });
        }
        if (
          !sameText(current.label, next.label) ||
          !sameText(current.descriptor, next.descriptor) ||
          !sameText(current.frequency, next.frequency)
        ) {
          // The organization's own criteria, nothing personal: kept from
          // and to, so the trail shows what a level said when a risk was
          // rated on it (security review 15, L4).
          const fromTo = (k: 'label' | 'descriptor' | 'frequency') =>
            sameText(current[k], next[k]) ? {} : { [k]: { from: current[k], to: next[k] } };
          levelChanges.push({
            axis: l.axis,
            level: l.level,
            ...fromTo('label'),
            ...fromTo('descriptor'),
            ...fromTo('frequency'),
          });
          Object.assign(current, next);
        }
      }
      if (levelChanges.length) changed.levels = levelChanges;

      // Domains: wording, at any status. Unknown ids are refused.
      const domainChanges = [];
      for (const d of input.domains ?? []) {
        if (d.id) {
          const current = parts.domains.find((p) => p.id === d.id);
          if (!current) throw new BadRequestException({ code: 'unknown_domain' });
          if (canonical({ ...current, ...d }) !== canonical(current)) {
            domainChanges.push({
              id: d.id,
              from: { name: current.name, descriptors: current.descriptors, position: current.position, active: current.active },
              to: { name: d.name, descriptors: d.descriptors, position: d.position, active: d.active },
            });
            Object.assign(current, d);
          }
        } else {
          parts.domains.push(d);
          domainChanges.push({ added: true, to: { name: d.name, descriptors: d.descriptors, position: d.position } });
        }
      }
      // At most twelve, switched off ones included.
      if (parts.domains.length > MAX_DOMAINS) {
        throw new BadRequestException({ code: 'too_many_domains', max: MAX_DOMAINS });
      }
      if (domainChanges.length) changed.domains = domainChanges;

      // Bands: the name at any status, the rest in draft only.
      const bandChanges = [];
      for (const b of input.bands ?? []) {
        const current = parts.bands.find((p) => p.code === b.code)!;
        const rules = (['reviewIntervalDays', 'escalateToCommitteeId', 'acceptanceNeedsSignature'] as const).filter(
          (k) => b[k] !== undefined && b[k] !== current[k],
        );
        const renamed = b.name !== undefined && !sameText(b.name, current.name);
        if (rules.length > 0 && matrix.status !== 'draft') {
          throw matrixRefusal(matrix.status);
        }
        if (rules.length > 0 || renamed) {
          bandChanges.push({
            code: b.code,
            changed: [...rules, ...(renamed ? ['name'] : [])],
            ...(renamed ? { name: { from: current.name, to: b.name } } : {}),
            ...Object.fromEntries(rules.map((k) => [k, { from: current[k], to: b[k] }])),
          });
          for (const k of rules) Object.assign(current, { [k]: b[k] });
          if (renamed) current.name = b.name!;
        }
      }
      if (bandChanges.length) changed.bands = bandChanges;

      // Cells: in draft only.
      const cellChanges = [];
      for (const c of input.cells ?? []) {
        const current = parts.cells.find(
          (p) => p.likelihood === c.likelihood && p.impact === c.impact,
        );
        if (!current) throw new BadRequestException({ code: 'level_out_of_range' });
        if (current.band !== c.band) {
          if (matrix.status !== 'draft') throw matrixRefusal(matrix.status);
          cellChanges.push({ likelihood: c.likelihood, impact: c.impact, from: current.band, to: c.band });
          current.band = c.band;
        }
      }
      if (cellChanges.length) changed.cells = cellChanges;

      if (Object.keys(changed).length === 0) return viewOf(matrix);
      await assertSound(tx, parts, null);

      for (const l of parts.levels) {
        await tx
          .update(riskMatrixLevels)
          .set({ label: l.label, descriptor: l.descriptor, frequency: l.frequency })
          .where(
            and(
              eq(riskMatrixLevels.matrixId, id),
              eq(riskMatrixLevels.axis, l.axis),
              eq(riskMatrixLevels.level, l.level),
            ),
          );
      }
      for (const d of parts.domains) {
        const values = {
          name: d.name,
          descriptors: d.descriptors,
          position: d.position,
          active: d.active,
        };
        if (d.id) {
          await tx
            .update(riskImpactDomains)
            .set(values)
            .where(eq(riskImpactDomains.id, d.id));
        } else {
          await tx
            .insert(riskImpactDomains)
            .values({ tenantId: auth.tenant.id, matrixId: id, ...values });
        }
      }
      for (const b of bandChanges) {
        const band = bandOf(parts, b.code);
        await tx
          .update(riskBands)
          .set(
            matrix.status === 'draft'
              ? {
                  name: band.name,
                  reviewIntervalDays: band.reviewIntervalDays,
                  escalateToCommitteeId: band.escalateToCommitteeId,
                  acceptanceNeedsSignature: band.acceptanceNeedsSignature,
                }
              : { name: band.name },
          )
          .where(and(eq(riskBands.matrixId, id), eq(riskBands.code, b.code)));
      }
      for (const c of cellChanges) {
        await tx
          .update(riskMatrixCells)
          .set({ bandCode: c.to })
          .where(
            and(
              eq(riskMatrixCells.matrixId, id),
              eq(riskMatrixCells.likelihood, c.likelihood),
              eq(riskMatrixCells.impact, c.impact),
            ),
          );
      }
      await tx
        .update(riskMatrices)
        .set({ revision: sql`${riskMatrices.revision} + 1`, updatedAt: new Date() })
        .where(eq(riskMatrices.id, id));
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'risk_matrix_changed',
        'risk_matrix',
        id,
        { version: matrix.version, status: matrix.status, ...changed },
      );
      return viewOf((await loadMatrix(tx, { id }))!);
    });
  }

  /**
   * What putting a draft in use does to the risks on the register (open
   * and proposed): each rating copy whose levels the draft holds moves to
   * the draft's cell and its band; one it cannot hold keeps its band on
   * the old version, and the risk shows that it needs re-rating. The
   * current rating of a risk whose acceptance is in approval is what was
   * put to its signers and stays as it is (counted `awaitingAcceptance`);
   * the next rating after the decision is on the new version.
   */
  private async rebanding(tx: Transaction, draft: Matrix, lock = false) {
    const query = tx
      .select({
        id: risks.id,
        status: risks.status,
        nextReviewOn: risks.nextReviewOn,
        inherent: {
          l: risks.inherentLikelihood,
          i: risks.inherentImpact,
          band: risks.inherentBand,
          matrix: risks.inherentMatrixId,
        },
        current: {
          l: risks.currentLikelihood,
          i: risks.currentImpact,
          band: risks.currentBand,
          matrix: risks.currentMatrixId,
        },
        target: {
          l: risks.targetLikelihood,
          i: risks.targetImpact,
          band: risks.targetBand,
          matrix: risks.targetMatrixId,
        },
      })
      .from(risks)
      .where(inArray(risks.status, ['open', 'proposed']));
    const awaiting = new Set(
      (
        await tx
          .select({ riskId: riskAcceptances.riskId })
          .from(riskAcceptances)
          .where(eq(riskAcceptances.status, 'in_approval'))
      ).map((a) => a.riskId),
    );
    // Locked when they are about to be moved; a preview only reads.
    const rows = lock ? await query.for('update') : await query;
    const changed: {
      id: string;
      status: string;
      nextReviewOn: string | null;
      moved: Partial<Record<'inherent' | 'current' | 'target', { from: BandCode; to: BandCode; l: number; i: number }>>;
      outOfRange: string[];
      targetAbove: boolean;
    }[] = [];
    const outOfRange: string[] = [];
    const targetAbove: string[] = [];
    for (const r of rows) {
      const entry = {
        id: r.id,
        status: r.status,
        nextReviewOn: r.nextReviewOn,
        moved: {} as (typeof changed)[number]['moved'],
        outOfRange: [] as string[],
        targetAbove: false,
      };
      for (const kind of ['inherent', 'current', 'target'] as const) {
        if (kind === 'current' && awaiting.has(r.id)) continue;
        const copy: Copy = r[kind];
        if (copy.l === null || copy.i === null || copy.band === null) continue;
        const band = bandAt(draft, copy.l, copy.i);
        if (!band) {
          entry.outOfRange.push(kind);
          continue;
        }
        entry.moved[kind] = { from: copy.band, to: band, l: copy.l, i: copy.i };
      }
      if (entry.outOfRange.length) outOfRange.push(r.id);
      // A target the new bands put above the current rating (security
      // review 15, L3): counted, and said in the risk's timeline.
      const after = (kind: 'current' | 'target') =>
        r[kind].l === null || r[kind].i === null || r[kind].band === null
          ? null
          : { score: r[kind].l * r[kind].i, band: entry.moved[kind]?.to ?? r[kind].band };
      const [current, target] = [after('current'), after('target')];
      entry.targetAbove =
        !!current && !!target && (target.score > current.score || rankOf(target.band) > rankOf(current.band));
      if (entry.targetAbove) targetAbove.push(r.id);
      const bandChanged = Object.values(entry.moved).some((m) => m.from !== m.to);
      if (bandChanged || entry.outOfRange.length || entry.targetAbove || Object.keys(entry.moved).length) {
        changed.push(entry);
      }
    }
    return {
      // Every risk with a copy to move; those whose band changes are counted.
      all: changed,
      changed: changed.filter((c) =>
        Object.values(c.moved).some((m) => m.from !== m.to),
      ),
      outOfRange,
      targetAbove,
      awaitingAcceptance: rows.filter((r) => awaiting.has(r.id)).map((r) => r.id),
    };
  }

  /**
   * Puts a draft in use, given its revision: the version in use is
   * retired, and the risks on the register are moved onto the new one at
   * once, which is what an organization changing its criteria wants.
   * Earlier ratings keep the band they had. A risk's next review comes no
   * later than today plus its band's interval in the new version. Each
   * risk whose band changed says so in its timeline, and the entry says
   * how many.
   */
  putInUse(auth: AuthContext, id: string, revision: number) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      // The version in use first, as a rating holds it while it rates:
      // so nothing is rated on it once this begins.
      const previous = await loadMatrix(tx, { inUse: true }, 'update');
      const draft = await loadMatrix(tx, { id }, 'update');
      if (!draft) throw new NotFoundException();
      if (draft.revision !== revision) {
        throw new ConflictException({ code: 'stale_matrix' });
      }
      if (draft.status !== 'draft') throw new ConflictException({ code: 'not_draft' });
      await assertSound(tx, partsOf(draft), null);
      const now = new Date();
      if (previous) {
        await tx
          .update(riskMatrices)
          .set({ status: 'retired', retiredAt: now, updatedAt: now, revision: sql`${riskMatrices.revision} + 1` })
          .where(eq(riskMatrices.id, previous.id));
      }
      await tx
        .update(riskMatrices)
        .set({
          status: 'in_use',
          putInUseAt: now,
          putInUseBy: auth.user.id,
          updatedAt: now,
          revision: sql`${riskMatrices.revision} + 1`,
        })
        .where(eq(riskMatrices.id, id));

      const { all, changed, outOfRange, targetAbove, awaitingAcceptance } = await this.rebanding(tx, draft, true);
      const today = dayOf(now, auth.tenant.timeZone);
      for (const r of all) {
        const set: Record<string, unknown> = {};
        for (const [kind, m] of Object.entries(r.moved)) {
          set[`${kind}Band`] = m.to;
          set[`${kind}MatrixId`] = draft.id;
        }
        const current = r.moved.current;
        if (current && r.status === 'open') {
          const latest = shiftDay(today, bandOf(draft, current.to).reviewIntervalDays);
          if (!r.nextReviewOn || latest < r.nextReviewOn) set.nextReviewOn = latest;
        }
        const bandChanged = Object.values(r.moved).some((m) => m.from !== m.to);
        await tx
          .update(risks)
          .set({
            ...set,
            ...(bandChanged || r.outOfRange.length || r.targetAbove
              ? { revision: sql`${risks.revision} + 1`, updatedAt: now }
              : {}),
          })
          .where(eq(risks.id, r.id));
        if (bandChanged || r.outOfRange.length || r.targetAbove) {
          await tx.insert(riskEvents).values({
            tenantId: auth.tenant.id,
            riskId: r.id,
            kind: 'rebanded',
            actorId: auth.user.id,
            details: {
              matrixId: draft.id,
              version: draft.version,
              bands: Object.fromEntries(
                Object.entries(r.moved)
                  .filter(([, m]) => m.from !== m.to)
                  .map(([kind, m]) => [kind, { from: m.from, to: m.to }]),
              ),
              outOfRange: r.outOfRange,
              targetAboveCurrent: r.targetAbove,
            },
          });
        }
      }
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'risk_matrix_put_in_use',
        'risk_matrix',
        id,
        {
          version: draft.version,
          previousMatrixId: previous?.id ?? null,
          risksRebanded: changed.length,
          risksOutOfRange: outOfRange.length,
          risksTargetAboveCurrent: targetAbove.length,
          risksAwaitingAcceptance: awaitingAcceptance.length,
          riskIds: changed.map((c) => c.id),
        },
      );
      return {
        ...viewOf((await loadMatrix(tx, { id }))!),
        risksRebanded: changed.length,
        risksOutOfRange: outOfRange.length,
        risksTargetAboveCurrent: targetAbove.length,
        risksAwaitingAcceptance: awaitingAcceptance.length,
      };
    });
  }

  /** Retires a draft that will not be used, given its revision. */
  discard(auth: AuthContext, id: string, revision: number) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [draft] = await tx
        .select(matrixHead)
        .from(riskMatrices)
        .where(eq(riskMatrices.id, id))
        .for('update');
      if (!draft) throw new NotFoundException();
      if (draft.revision !== revision) {
        throw new ConflictException({ code: 'stale_matrix' });
      }
      if (draft.status !== 'draft') throw new ConflictException({ code: 'not_draft' });
      const now = new Date();
      await tx
        .update(riskMatrices)
        .set({ status: 'retired', retiredAt: now, updatedAt: now, revision: sql`${riskMatrices.revision} + 1` })
        .where(eq(riskMatrices.id, id));
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'risk_matrix_discarded',
        'risk_matrix',
        id,
        { version: draft.version },
      );
      return { ...draft, status: 'retired' as const, revision: draft.revision + 1 };
    });
  }

  // Categories.

  private categoryRows(tx: Transaction, includeInactive: boolean) {
    return tx
      .select(categoryFields)
      .from(riskCategories)
      .where(includeInactive ? undefined : eq(riskCategories.active, true))
      .orderBy(asc(riskCategories.position), asc(riskCategories.code));
  }

  categories(auth: AuthContext, includeInactive: boolean) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      this.categoryRows(tx, includeInactive),
    );
  }

  async createCategory(auth: AuthContext, input: CategoryCreateInput) {
    this.assertLanguages(auth, [input.name], [input.appetiteStatement]);
    try {
      return await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
        const [created] = await tx
          .insert(riskCategories)
          .values({ ...input, tenantId: auth.tenant.id })
          .returning(categoryFields);
        await this.provisioning.audit(
          tx,
          auth.tenant.id,
          auth.user.id,
          'risk_category_created',
          'risk_category',
          created.id,
          input,
        );
        return created;
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'code_taken' });
      throw e;
    }
  }

  /**
   * Changes a category, given its revision (409 `stale_category`). A
   * change of tolerance or appetite is audited from and to; where each
   * risk of it stands against tolerance is worked out when it is read, so
   * it follows at once.
   */
  updateCategory(auth: AuthContext, id: string, input: CategoryUpdateInput) {
    this.assertLanguages(auth, [input.name], [input.appetiteStatement]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [before] = await tx
        .select(categoryFields)
        .from(riskCategories)
        .where(eq(riskCategories.id, id))
        .for('update');
      if (!before) throw new NotFoundException();
      if (before.revision !== input.revision) {
        throw new ConflictException({ code: 'stale_category' });
      }
      const { revision: _revision, ...fields } = input;
      const changes = changesOf(before, fields);
      if (Object.keys(changes).length === 0) return before;
      const [after] = await tx
        .update(riskCategories)
        .set({
          ...fields,
          revision: sql`${riskCategories.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(riskCategories.id, id))
        .returning(categoryFields);
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'risk_category_updated',
        'risk_category',
        id,
        changes,
      );
      return after;
    });
  }

  // Committees.

  private committeeRows(tx: Transaction, includeInactive: boolean) {
    return tx
      .select(committeeFields)
      .from(riskCommittees)
      .where(includeInactive ? undefined : eq(riskCommittees.active, true))
      .orderBy(asc(riskCommittees.position), asc(riskCommittees.code));
  }

  committees(auth: AuthContext, includeInactive: boolean) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      this.committeeRows(tx, includeInactive),
    );
  }

  /** 400 `unknown_role` for a role the client does not have. */
  private async assertRoles(tx: Transaction, ids: (string | null | undefined)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (wanted.length === 0) return;
    const found = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.id, wanted));
    if (found.length !== wanted.length) {
      throw new BadRequestException({ code: 'unknown_role' });
    }
  }

  async createCommittee(auth: AuthContext, input: CommitteeCreateInput) {
    this.assertLanguages(auth, [input.name]);
    try {
      return await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
        await this.assertRoles(tx, [input.memberRoleId, input.chairRoleId]);
        const [created] = await tx
          .insert(riskCommittees)
          .values({ ...input, tenantId: auth.tenant.id })
          .returning(committeeFields);
        await this.provisioning.audit(
          tx,
          auth.tenant.id,
          auth.user.id,
          'risk_committee_created',
          'risk_committee',
          created.id,
          input,
        );
        return created;
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'code_taken' });
      throw e;
    }
  }

  /**
   * Changes a committee, given its revision (409 `stale_committee`). One
   * that a band of the matrix in use or of the draft escalates to, or that
   * open risks are before, is not switched off (409 `committee_in_use`:
   * security review 17, L3).
   */
  updateCommittee(auth: AuthContext, id: string, input: CommitteeUpdateInput) {
    this.assertLanguages(auth, [input.name]);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [before] = await tx
        .select(committeeFields)
        .from(riskCommittees)
        .where(eq(riskCommittees.id, id))
        .for('update');
      if (!before) throw new NotFoundException();
      if (before.revision !== input.revision) {
        throw new ConflictException({ code: 'stale_committee' });
      }
      const { revision: _revision, ...fields } = input;
      await this.assertRoles(tx, [fields.memberRoleId, fields.chairRoleId]);
      const changes = changesOf(before, fields);
      if (Object.keys(changes).length === 0) return before;
      if (fields.active === false && before.active) {
        const [used] = await tx
          .select({ id: riskBands.id })
          .from(riskBands)
          .innerJoin(riskMatrices, eq(riskMatrices.id, riskBands.matrixId))
          .where(
            and(
              eq(riskBands.escalateToCommitteeId, id),
              inArray(riskMatrices.status, ['in_use', 'draft']),
            ),
          )
          .limit(1);
        const [escalated] = await tx
          .select({ id: risks.id })
          .from(risks)
          .where(and(eq(risks.escalatedToCommitteeId, id), eq(risks.status, 'open')))
          .limit(1);
        if (used || escalated) throw new ConflictException({ code: 'committee_in_use' });
      }
      const [after] = await tx
        .update(riskCommittees)
        .set({
          ...fields,
          revision: sql`${riskCommittees.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(riskCommittees.id, id))
        .returning(committeeFields);
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'risk_committee_updated',
        'risk_committee',
        id,
        changes,
      );
      return after;
    });
  }

  // For pickers.

  /** The client's roles by name: to name a committee's members. */
  roles(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select({
          id: roles.id,
          code: roles.code,
          name: roles.name,
          isSystem: roles.isSystem,
        })
        .from(roles)
        .orderBy(asc(roles.code)),
    );
  }

  /**
   * Active people by name, for an owner: at most 50. Named columns only:
   * never a hash or a contact detail.
   */
  people(auth: AuthContext, q?: string) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) => {
      const pattern = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      return tx
        .select({ id: users.id, name: users.name, orgUnitId: users.orgUnitId })
        .from(users)
        .where(
          and(
            eq(users.status, 'active'),
            pattern
              ? sql`exists (select from jsonb_each_text(${users.name}) n where n.value ilike ${pattern})`
              : undefined,
          ),
        )
        .orderBy(sql`${users.name} ->> ${auth.tenant.defaultLocale}`, asc(users.id))
        .limit(50);
    });
  }
}
