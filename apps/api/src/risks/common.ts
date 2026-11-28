import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  actions,
  orgUnits,
  riskAcceptances,
  riskCategories,
  riskCommittees,
  riskEvents,
  riskNotes,
  riskRatings,
  risks,
  users,
} from '../database/schema.js';
import type { AuthContext } from '../identity/auth.service.js';
import { fitsLanguages, type Localized } from '../i18n/locales.js';
import { dayOf, shiftDay } from '../i18n/time-zones.js';
import type { BandCode } from './defaults.js';
import { loadMatrix, rankOf, type rate } from './matrix.js';

/**
 * What the register, the reviews, escalation and the answers of the risks
 * module share: the columns of a risk, its rating copies, where it stands
 * against tolerance, and its row as lists show it.
 */

export type Kind = 'inherent' | 'current' | 'target';
export const KINDS: Kind[] = ['inherent', 'current', 'target'];

export type Rated = ReturnType<typeof rate>;
export type RatedWithRationale = Rated & { rationale: Localized | null };

export const copyColumns = {
  inherentLikelihood: risks.inherentLikelihood,
  inherentImpact: risks.inherentImpact,
  inherentScore: risks.inherentScore,
  inherentBand: risks.inherentBand,
  inherentMatrixId: risks.inherentMatrixId,
  currentLikelihood: risks.currentLikelihood,
  currentImpact: risks.currentImpact,
  currentScore: risks.currentScore,
  currentBand: risks.currentBand,
  currentMatrixId: risks.currentMatrixId,
  targetLikelihood: risks.targetLikelihood,
  targetImpact: risks.targetImpact,
  targetScore: risks.targetScore,
  targetBand: risks.targetBand,
  targetMatrixId: risks.targetMatrixId,
};

export const riskColumns = {
  id: risks.id,
  reference: risks.reference,
  orgUnitId: risks.orgUnitId,
  categoryId: risks.categoryId,
  title: risks.title,
  cause: risks.cause,
  event: risks.event,
  consequence: risks.consequence,
  ownerId: risks.ownerId,
  status: risks.status,
  source: risks.source,
  treatment: risks.treatment,
  targetOn: risks.targetOn,
  ...copyColumns,
  nextReviewOn: risks.nextReviewOn,
  lastReviewedOn: risks.lastReviewedOn,
  escalatedToCommitteeId: risks.escalatedToCommitteeId,
  escalatedAt: risks.escalatedAt,
  highestBand: risks.highestBand,
  closureSignOffNeeded: risks.closureSignOffNeeded,
  references: risks.references,
  keywords: risks.keywords,
  rejectedBy: risks.rejectedBy,
  rejectedAt: risks.rejectedAt,
  rejectReason: risks.rejectReason,
  acceptanceId: risks.acceptanceId,
  closeReason: risks.closeReason,
  mergedIntoId: risks.mergedIntoId,
  closureRequestedBy: risks.closureRequestedBy,
  closureRequestedAt: risks.closureRequestedAt,
  closedBy: risks.closedBy,
  closedAt: risks.closedAt,
  createdBy: risks.createdBy,
  createdAt: risks.createdAt,
  updatedAt: risks.updatedAt,
  revision: risks.revision,
};

export type RiskRow = Pick<typeof risks.$inferSelect, keyof typeof riskColumns>;

/** One kind of a risk's copy, or null when it has none. */
export function copyOf(row: Pick<RiskRow, keyof typeof copyColumns>, kind: Kind) {
  const likelihood = row[`${kind}Likelihood`];
  const impact = row[`${kind}Impact`];
  const score = row[`${kind}Score`];
  const band = row[`${kind}Band`];
  const matrixId = row[`${kind}MatrixId`];
  if (likelihood === null || impact === null || score === null || band === null || matrixId === null) {
    return null;
  }
  return { likelihood, impact, score, band: band as BandCode, matrixId };
}

/** The columns of a risk for one rating copy. */
export const copyValues = (kind: Kind, r: Rated) => ({
  [`${kind}Likelihood`]: r.likelihood,
  [`${kind}Impact`]: r.impact,
  [`${kind}Score`]: r.score,
  [`${kind}Band`]: r.band,
  [`${kind}MatrixId`]: r.matrixId,
});

/** A rating as the trail and the timeline hold it: levels, never its rationale. */
export const short = (r: { likelihood: number; impact: number; score: number; band: string } | null) =>
  r ? { likelihood: r.likelihood, impact: r.impact, score: r.score, band: r.band } : null;

/** Whether a target is above a current rating, by score or by band. */
export const isAbove = (
  target: { score: number; band: BandCode } | null,
  current: { score: number; band: BandCode } | null,
) => !!target && !!current && (target.score > current.score || rankOf(target.band) > rankOf(current.band));

export type Standing = 'within' | 'above_treated' | 'above_accepted' | 'above_not_addressed';

/**
 * Where a risk stands against its category's tolerance, worked out when it
 * is read, never stored (spec, "Appetite and tolerance"):
 *
 * - `within`: the current band at or below the tolerance;
 * - `above_accepted`: above, with an acceptance in force (step 6);
 * - `above_treated`: above, with the treatment "reduce", a target within
 *   tolerance and at least one open action;
 * - `above_not_addressed`: anything else.
 *
 * Null for a risk with no current rating.
 */
export function standingOf(
  r: { currentBand: BandCode | null; targetBand: BandCode | null; treatment: string | null; acceptanceId?: string | null },
  tolerance: BandCode,
  openActions: number,
): Standing | null {
  if (!r.currentBand) return null;
  if (rankOf(r.currentBand) <= rankOf(tolerance)) return 'within';
  if (r.acceptanceId) return 'above_accepted';
  if (
    r.treatment === 'reduce' &&
    r.targetBand !== null &&
    rankOf(r.targetBand) <= rankOf(tolerance) &&
    openActions > 0
  ) {
    return 'above_treated';
  }
  return 'above_not_addressed';
}

/** The same rule, for a query of `risks` joined with `risk_categories`. */
export const aboveTolerance: SQL = sql`${risks.currentBand} > ${riskCategories.toleranceBand}`;
export const beingTreated: SQL = sql`(${risks.acceptanceId} is not null or ${risks.treatment} = 'reduce'
  and ${risks.targetBand} <= ${riskCategories.toleranceBand}
  and exists (select from ${actions} a where a.risk_id = ${risks.id} and a.status in ('open', 'in_progress')))`;

/** How many open actions a risk has, and how many of them are overdue, for a query. */
export const openActionsOf = sql<number>`(select count(*) from ${actions} a
  where a.risk_id = ${risks.id} and a.status in ('open', 'in_progress'))`.mapWith(Number);
export const overdueActionsOf = (today: string) =>
  sql<number>`(select count(*) from ${actions} a
    where a.risk_id = ${risks.id} and a.status in ('open', 'in_progress') and a.due_on < ${today}::date)`.mapWith(Number);

/**
 * The current score the trend is against: the current rating recorded at
 * the last review, while the latest current rating came after it; else the
 * current rating before the latest one. Null with nothing to compare.
 */
export const trendBase = sql<number | null>`(
  select case
    when latest.review_id is null and reviewed.score is not null then reviewed.score
    else previous.score end
  from (select r.review_id from ${riskRatings} r where r.risk_id = ${risks.id} and r.kind = 'current'
        order by r.rated_at desc, r.id desc limit 1) latest
  left join lateral (select r.score from ${riskRatings} r where r.risk_id = ${risks.id} and r.kind = 'current'
        and r.review_id is not null order by r.rated_at desc, r.id desc limit 1) reviewed on true
  left join lateral (select r.score from ${riskRatings} r where r.risk_id = ${risks.id} and r.kind = 'current'
        order by r.rated_at desc, r.id desc offset 1 limit 1) previous on true)`;

/** The columns a list row needs beside the risk's own. */
export const listExtras = (today: string) => ({
  toleranceBand: riskCategories.toleranceBand,
  trendBase,
  openActions: openActionsOf,
  // The last day of the acceptance in force, if any.
  acceptedUntil: sql<string | null>`(select a.until_on::text from ${riskAcceptances} a where a.id = ${risks.acceptanceId})`,
  overdueActions: overdueActionsOf(today),
});

export type ListRow = RiskRow & {
  toleranceBand: BandCode;
  trendBase: number | null;
  acceptedUntil: string | null;
  openActions: number;
  overdueActions: number;
};

/** A risk as a row of the register shows it. */
export function summaryOf(r: ListRow, today: string, inUseId: string | null) {
  const current = copyOf(r, 'current');
  const target = copyOf(r, 'target');
  const base = r.trendBase;
  return {
    id: r.id,
    reference: r.reference,
    title: r.title,
    orgUnitId: r.orgUnitId,
    categoryId: r.categoryId,
    ownerId: r.ownerId,
    status: r.status,
    inherent: short(copyOf(r, 'inherent')),
    current: short(current),
    target: short(target),
    // A target above the current rating: a new version of the matrix can
    // leave one so (security review 15, L3). Rate the target again.
    targetAboveCurrent: isAbove(target, current),
    tolerance: r.toleranceBand,
    standing: standingOf(r, r.toleranceBand, r.openActions),
    // "Accepted until 30 Jun 2027".
    acceptedUntil: r.acceptedUntil,
    // A closure waiting for its second signature.
    closureRequested: r.closureRequestedAt !== null,
    // Since the last review (or the rating before, with none).
    trend:
      current && base !== null && current.score !== base
        ? current.score > base
          ? ('up' as const)
          : ('down' as const)
        : null,
    nextReviewOn: r.nextReviewOn,
    lastReviewedOn: r.lastReviewedOn,
    review:
      r.status !== 'open' || !r.nextReviewOn
        ? null
        : r.nextReviewOn < today
          ? ('overdue' as const)
          : r.nextReviewOn <= shiftDay(today, 30)
            ? ('due' as const)
            : null,
    escalatedToCommitteeId: r.escalatedToCommitteeId,
    actions: { open: r.openActions, overdue: r.overdueActions },
    // A rating made on a version no longer in use, whose levels the new
    // one does not hold.
    rerateNeeded:
      inUseId !== null &&
      KINDS.some((k) => {
        const c = copyOf(r, k);
        return c !== null && c.matrixId !== inUseId;
      }),
    updatedAt: r.updatedAt,
  };
}

/** The names of what a response points at by id, as they are now. */
export async function namesOf(
  tx: Transaction,
  ids: {
    people?: (string | null)[];
    units?: (string | null)[];
    categories?: (string | null)[];
    committees?: (string | null)[];
  },
) {
  const wanted = (list?: (string | null)[]) => [...new Set((list ?? []).filter((id): id is string => !!id))];
  const named = async (
    list: string[],
    table: typeof users | typeof orgUnits | typeof riskCategories | typeof riskCommittees,
  ) => {
    if (list.length === 0) return {};
    const rows: { id: string; name: Localized }[] = await tx
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(inArray(table.id, list));
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  };
  return {
    people: await named(wanted(ids.people), users),
    units: await named(wanted(ids.units), orgUnits),
    categories: await named(wanted(ids.categories), riskCategories),
    committees: await named(wanted(ids.committees), riskCommittees),
  };
}

/** 400 `language_mismatch` unless the text fits the client's languages. */
export function assertLanguages(
  auth: AuthContext,
  names: (Localized | undefined)[],
  wording: (Localized | null | undefined)[] = [],
) {
  const ok =
    names.every((n) => n === undefined || fitsLanguages(n, auth.tenant)) &&
    wording.every((w) => fitsLanguages(w, auth.tenant, { required: false }));
  if (!ok) throw new BadRequestException({ code: 'language_mismatch' });
}

/** 403 for someone who reads a risk but may not do this to it. */
export const notYours = () =>
  new ForbiddenException({ code: 'missing_permission', permission: 'risks.manage' });

export const stale = () => new ConflictException({ code: 'stale_risk' });

/** Today on the client's calendar. */
export const todayOf = (auth: AuthContext) => dayOf(new Date(), auth.tenant.timeZone);

/** A text search, as a LIKE pattern with its own wildcards escaped. */
export const patternOf = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function addEvent(
  tx: Transaction,
  auth: { tenant: { id: string }; user: { id: string } } | { tenantId: string; actorId: string | null },
  riskId: string,
  kind: (typeof riskEvents.$inferInsert)['kind'],
  details: Record<string, unknown>,
) {
  const [tenantId, actorId] =
    'tenant' in auth ? [auth.tenant.id, auth.user.id] : [auth.tenantId, auth.actorId];
  await tx.insert(riskEvents).values({ tenantId, riskId, kind, actorId, details });
}

/** The matrix in use, held until the transaction ends. */
export async function matrixInUse(tx: Transaction) {
  const matrix = await loadMatrix(tx, { inUse: true }, 'share');
  // Every client is given one (ensureRiskDefaults).
  if (!matrix) throw new ConflictException({ code: 'no_matrix' });
  return matrix;
}

/** Writes ratings, each a new row, naming the review they were made at. */
export async function writeRatings(
  tx: Transaction,
  auth: AuthContext,
  riskId: string,
  rated: Partial<Record<Kind, RatedWithRationale>>,
  reviewId: string | null = null,
) {
  const rows = KINDS.filter((k) => rated[k]).map((kind) => {
    const r = rated[kind]!;
    return {
      tenantId: auth.tenant.id,
      riskId,
      kind,
      likelihood: r.likelihood,
      impact: r.impact,
      score: r.score,
      bandCode: r.band,
      matrixId: r.matrixId,
      rationale: r.rationale,
      ratedBy: auth.user.id,
      reviewId,
    };
  });
  if (rows.length > 0) await tx.insert(riskRatings).values(rows);
}

/** Text fields of a risk: the trail and the timeline say only that they changed (M1). */
export const TEXT_FIELDS = new Set(['title', 'cause', 'event', 'consequence', 'references', 'keywords', 'description']);

/**
 * A change as the trail and the timeline keep it: ids, days and choices
 * from and to; text only as `{ changed: true }` (security review 15, M1).
 */
export const redacted = (changes: Record<string, { from: unknown; to: unknown }>) =>
  Object.fromEntries(
    Object.entries(changes).map(([k, v]) => [k, TEXT_FIELDS.has(k) ? { changed: true } : v]),
  );

export type RiskNoteKind = (typeof riskNotes.$inferInsert)['kind'];

/**
 * Writes a reason on the record, correctable by a manager, and returns its
 * id for the timeline and the trail to name (security review 17, L5).
 */
export async function writeNote(
  tx: Transaction,
  author: { tenantId: string; userId: string },
  riskId: string,
  kind: RiskNoteKind,
  text: string,
) {
  const [row] = await tx
    .insert(riskNotes)
    .values({ tenantId: author.tenantId, riskId, kind, text, writtenBy: author.userId })
    .returning({ id: riskNotes.id });
  return row.id;
}

/** The reasons written on a risk, oldest first, as they stand now. */
export function notesOf(tx: Transaction, riskId: string) {
  return tx
    .select({
      id: riskNotes.id,
      kind: riskNotes.kind,
      text: riskNotes.text,
      writtenBy: riskNotes.writtenBy,
      writtenAt: riskNotes.writtenAt,
      correctedAt: riskNotes.correctedAt,
    })
    .from(riskNotes)
    .where(eq(riskNotes.riskId, riskId))
    .orderBy(asc(riskNotes.writtenAt), asc(riskNotes.id));
}
