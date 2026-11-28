import { and, count, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { actions } from '../database/schema.js';
import { MEASURE_DEFINITIONS, tenthPercent } from '../reports/measures.js';

/**
 * The business's measure "Overdue corrective actions: under 10% of open
 * actions", as `reports/measures.ts` defines it (`actions.overdue`): its
 * code, target and direction are read from there, so that the dashboard
 * tile and the reports mean the same number. The month-end snapshot and
 * the Reports API's series are the reports module's to take
 * (`taken: false` until they are built).
 */
export const ACTIONS_OVERDUE = MEASURE_DEFINITIONS['actions.overdue'];

/**
 * Open actions (open or in progress) past their due day as of `today`, as
 * a share of open actions, to a tenth of a percent as the document
 * measures are, over those `within` picks (what the reader may see); and
 * beside it, how many of them have had their due day moved.
 */
export async function overdueActions(tx: Transaction, today: string, within: SQL) {
  const open = and(inArray(actions.status, ['open', 'in_progress']), within);
  const [row] = await tx
    .select({
      of: count(),
      overdue: sql<number>`count(*) filter (where ${actions.dueOn} < ${today})`.mapWith(Number),
      moved: sql<number>`count(*) filter (where ${ne(actions.dueOn, actions.originalDueOn)})`.mapWith(Number),
    })
    .from(actions)
    .where(open);
  return {
    code: ACTIONS_OVERDUE.code,
    count: row.overdue,
    of: row.of,
    percent: tenthPercent(row.overdue, row.of),
    target: ACTIONS_OVERDUE.target,
    dueDaysMoved: row.moved,
  };
}
