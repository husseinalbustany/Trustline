import { eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { incidents } from '../database/schema.js';
import type { AuthContext } from '../identity/auth.service.js';
import { reachOf } from '../identity/scope.js';

/**
 * Which incidents a signed-in user sees, as conditions for a query. Written
 * once, here, so that every list, count and lookup means the same incidents.
 */

/**
 * The incidents a user sees all of, internal parts included: the ones
 * assigned to them, and the ones that happened in, or are handled by, a unit
 * their view or triage rights cover.
 */
export function seenInFull(auth: AuthContext): SQL {
  const reach = reachOf(auth, ['incidents.view', 'incidents.triage']);
  if (reach === 'all') return sql`true`;
  const assigned = sql`coalesce(${incidents.assignedTo} = ${auth.user.id}, false)`;
  if (reach.length === 0) return assigned;
  return sql`coalesce(${or(
    eq(incidents.assignedTo, auth.user.id),
    inArray(incidents.orgUnitId, reach),
    inArray(incidents.ownerUnitId, reach),
  )}, false)`;
}

/**
 * The incidents a user may see at all: those, and the ones they reported,
 * which they see as their reporter does and no further.
 */
export function visibleTo(auth: AuthContext): SQL {
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
