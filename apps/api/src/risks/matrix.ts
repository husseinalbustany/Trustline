import { BadRequestException, ConflictException } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  riskBands,
  riskCommittees,
  riskImpactDomains,
  riskMatrices,
  riskMatrixCells,
  riskMatrixLevels,
  type RiskDomainDescriptors,
} from '../database/schema.js';
import { fitsLanguages, type LanguageSettings, type Localized } from '../i18n/locales.js';
import { BAND_CODES, type BandCode } from './defaults.js';
import type {
  BandInput,
  CellInput,
  DomainInput,
  LevelInput,
} from './input.js';

/**
 * The risk matrix as the module reads it (docs/specs/risk-management.md,
 * "The matrix"): one version with its levels, impact domains, four bands
 * and the band of every cell.
 */

export type Level = {
  level: number;
  label: Localized;
  descriptor: Localized | null;
  frequency: Localized | null;
};

export type Domain = {
  id: string;
  name: Localized;
  descriptors: RiskDomainDescriptors;
  position: number;
  active: boolean;
};

export type Band = {
  code: BandCode;
  name: Localized;
  reviewIntervalDays: number;
  escalateToCommitteeId: string | null;
  acceptanceNeedsSignature: boolean;
};

export type Cell = { likelihood: number; impact: number; band: BandCode };

export type Matrix = {
  id: string;
  version: number;
  status: 'draft' | 'in_use' | 'retired';
  likelihoodLevels: number;
  impactLevels: number;
  putInUseAt: Date | null;
  putInUseBy: string | null;
  revision: number;
  likelihood: Level[];
  impact: Level[];
  domains: Domain[];
  bands: Band[];
  cells: Cell[];
};

export const matrixHead = {
  id: riskMatrices.id,
  version: riskMatrices.version,
  status: riskMatrices.status,
  likelihoodLevels: riskMatrices.likelihoodLevels,
  impactLevels: riskMatrices.impactLevels,
  putInUseAt: riskMatrices.putInUseAt,
  putInUseBy: riskMatrices.putInUseBy,
  revision: riskMatrices.revision,
};

/** The rank of a band, from 0 (Low) to 3 (Extreme). */
export const rankOf = (band: BandCode) => BAND_CODES.indexOf(band);

/**
 * Everything of one version, or null. With `lock`, its row is held until
 * the caller's transaction ends: `share` while rating on it (it cannot be
 * retired meanwhile), `update` to change it.
 */
export async function loadMatrix(
  tx: Transaction,
  where: { id: string } | { inUse: true },
  lock: false | 'share' | 'update' = false,
): Promise<Matrix | null> {
  const query = tx
    .select(matrixHead)
    .from(riskMatrices)
    .where(
      'id' in where
        ? eq(riskMatrices.id, where.id)
        : eq(riskMatrices.status, 'in_use'),
    );
  const [head] =
    lock === 'share'
      ? await query.for('share')
      : lock === 'update'
        ? await query.for('update')
        : await query;
  if (!head) return null;
  // One after the other: a transaction is one connection.
  const levels = await tx
    .select({
      axis: riskMatrixLevels.axis,
      level: riskMatrixLevels.level,
      label: riskMatrixLevels.label,
      descriptor: riskMatrixLevels.descriptor,
      frequency: riskMatrixLevels.frequency,
    })
    .from(riskMatrixLevels)
    .where(eq(riskMatrixLevels.matrixId, head.id))
    .orderBy(asc(riskMatrixLevels.level));
  const domains = await tx
    .select({
      id: riskImpactDomains.id,
      name: riskImpactDomains.name,
      descriptors: riskImpactDomains.descriptors,
      position: riskImpactDomains.position,
      active: riskImpactDomains.active,
    })
    .from(riskImpactDomains)
    .where(eq(riskImpactDomains.matrixId, head.id))
    .orderBy(asc(riskImpactDomains.position), asc(riskImpactDomains.id));
  const bands = await tx
    .select({
      code: riskBands.code,
      name: riskBands.name,
      reviewIntervalDays: riskBands.reviewIntervalDays,
      escalateToCommitteeId: riskBands.escalateToCommitteeId,
      acceptanceNeedsSignature: riskBands.acceptanceNeedsSignature,
    })
    .from(riskBands)
    .where(eq(riskBands.matrixId, head.id));
  const cells = await tx
    .select({
      likelihood: riskMatrixCells.likelihood,
      impact: riskMatrixCells.impact,
      band: riskMatrixCells.bandCode,
    })
    .from(riskMatrixCells)
    .where(eq(riskMatrixCells.matrixId, head.id))
    .orderBy(asc(riskMatrixCells.likelihood), asc(riskMatrixCells.impact));
  const level = ({ axis: _axis, ...l }: (typeof levels)[number]): Level => l;
  return {
    ...head,
    likelihood: levels.filter((l) => l.axis === 'likelihood').map(level),
    impact: levels.filter((l) => l.axis === 'impact').map(level),
    domains,
    bands: bands.sort((a, b) => rankOf(a.code) - rankOf(b.code)),
    cells,
  };
}

/** The id of the version in use, or null. */
export async function matrixInUseId(tx: Transaction) {
  const [row] = await tx
    .select({ id: riskMatrices.id })
    .from(riskMatrices)
    .where(eq(riskMatrices.status, 'in_use'));
  return row?.id ?? null;
}

/** The band a cell of the matrix gives, or null outside it. */
export function bandAt(matrix: Pick<Matrix, 'cells'>, likelihood: number, impact: number) {
  return (
    matrix.cells.find((c) => c.likelihood === likelihood && c.impact === impact)
      ?.band ?? null
  );
}

/** A band's settings in this matrix. */
export const bandOf = (matrix: Pick<Matrix, 'bands'>, code: BandCode) =>
  matrix.bands.find((b) => b.code === code)!;

/**
 * A rating on the matrix: its score and band, or 400 `level_out_of_range`
 * for a level the matrix does not have.
 */
export function rate(matrix: Matrix, likelihood: number, impact: number) {
  const band = bandAt(matrix, likelihood, impact);
  if (
    !band ||
    likelihood > matrix.likelihoodLevels ||
    impact > matrix.impactLevels
  ) {
    throw new BadRequestException({ code: 'level_out_of_range' });
  }
  return { likelihood, impact, score: likelihood * impact, band, matrixId: matrix.id };
}

/** What makes up a matrix, part by part, as it will be written. */
export type MatrixParts = {
  likelihoodLevels: number;
  impactLevels: number;
  levels: LevelInput[];
  domains: (Omit<DomainInput, 'id'> & { id?: string })[];
  bands: Required<BandInput>[];
  cells: CellInput[];
};

const bad = (code: string, extra: Record<string, unknown> = {}) =>
  new BadRequestException({ code, ...extra });

/**
 * Refuses a matrix that is not whole and sound, with 400 and a code:
 *
 * - `matrix_incomplete`: each axis has every level from 1 to its size once,
 *   every cell has a band once, and the four bands are there once each;
 * - `level_out_of_range`: a level, cell or domain descriptor beyond its size;
 * - `frequency_of_impact`: a frequency is for likelihood only;
 * - `language_mismatch` (with `languages`, for a matrix written whole by
 *   the caller): a label or name not in the client's default language, or
 *   any text in a language the client does not use. What is stored is not
 *   checked again: the starting wording is in every language;
 * - `bands_out_of_order`: a cell's band is lower than that of a cell of
 *   lower or equal likelihood and impact, which would make a rise in either
 *   lower the risk;
 * - `signature_required`: acceptance above tolerance is always signed for
 *   High and Extreme;
 * - `unknown_committee`: escalation to a committee the client does not
 *   have, or has switched off.
 */
export async function assertSound(
  tx: Transaction,
  parts: MatrixParts,
  languages: LanguageSettings | null,
) {
  const fits = (
    text: Localized | null | undefined,
    options?: { required: boolean },
  ) => !languages || fitsLanguages(text, languages, options);
  const { likelihoodLevels: L, impactLevels: I } = parts;
  for (const [axis, size] of [
    ['likelihood', L],
    ['impact', I],
  ] as const) {
    const of = parts.levels.filter((l) => l.axis === axis);
    if (of.some((l) => l.level > size)) throw bad('level_out_of_range');
    const numbers = new Set(of.map((l) => l.level));
    if (of.length !== size || numbers.size !== size) throw bad('matrix_incomplete');
  }
  for (const l of parts.levels) {
    if (l.axis === 'impact' && l.frequency) throw bad('frequency_of_impact');
    if (
      !fits(l.label) ||
      !fits(l.descriptor, { required: false }) ||
      !fits(l.frequency, { required: false })
    ) {
      throw bad('language_mismatch');
    }
  }
  if (parts.domains.filter((d) => d.active).length === 0) {
    throw bad('matrix_incomplete');
  }
  for (const d of parts.domains) {
    if (!fits(d.name)) throw bad('language_mismatch');
    for (const [key, text] of Object.entries(d.descriptors)) {
      if (Number(key) > I) throw bad('level_out_of_range');
      if (!fits(text, { required: false })) {
        throw bad('language_mismatch');
      }
    }
  }
  const codes = new Set(parts.bands.map((b) => b.code));
  if (parts.bands.length !== 4 || codes.size !== 4) throw bad('matrix_incomplete');
  for (const b of parts.bands) {
    if (!fits(b.name)) throw bad('language_mismatch');
    if (!b.acceptanceNeedsSignature && rankOf(b.code) >= rankOf('high')) {
      throw bad('signature_required');
    }
  }
  const committees = parts.bands
    .map((b) => b.escalateToCommitteeId)
    .filter((id): id is string => !!id);
  for (const id of new Set(committees)) {
    const [found] = await tx
      .select({ id: riskCommittees.id })
      .from(riskCommittees)
      .where(and(eq(riskCommittees.id, id), eq(riskCommittees.active, true)));
    if (!found) throw bad('unknown_committee');
  }
  const grid = new Map<string, BandCode>();
  for (const c of parts.cells) {
    if (c.likelihood > L || c.impact > I) throw bad('level_out_of_range');
    const key = `${c.likelihood}:${c.impact}`;
    if (grid.has(key)) throw bad('matrix_incomplete');
    grid.set(key, c.band);
  }
  if (grid.size !== L * I) throw bad('matrix_incomplete');
  for (let l = 1; l <= L; l++) {
    for (let i = 1; i <= I; i++) {
      const here = rankOf(grid.get(`${l}:${i}`)!);
      const below = [
        l > 1 ? grid.get(`${l - 1}:${i}`) : undefined,
        i > 1 ? grid.get(`${l}:${i - 1}`) : undefined,
      ];
      if (below.some((b) => b !== undefined && rankOf(b) > here)) {
        throw bad('bands_out_of_order');
      }
    }
  }
}

/** The parts of a matrix as read, for checking a change against them. */
export function partsOf(matrix: Matrix): MatrixParts {
  return {
    likelihoodLevels: matrix.likelihoodLevels,
    impactLevels: matrix.impactLevels,
    levels: [
      ...matrix.likelihood.map((l) => ({ axis: 'likelihood' as const, ...l })),
      ...matrix.impact.map((l) => ({ axis: 'impact' as const, ...l })),
    ],
    domains: matrix.domains,
    bands: matrix.bands,
    cells: matrix.cells,
  };
}

/** 409 for a change a matrix in its state does not take. */
export const matrixRefusal = (status: Matrix['status']) =>
  new ConflictException({
    code: status === 'retired' ? 'matrix_retired' : 'matrix_in_use',
  });
