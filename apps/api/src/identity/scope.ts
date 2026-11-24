import type { Permission } from './permissions.js';

/**
 * Where each of a user's permissions applies: `"all"` for the whole
 * organization, or the ids of the org units it covers (the units the role was
 * granted for and every unit beneath them). A permission the user does not
 * hold has no entry.
 */
export type Scope = Record<string, 'all' | string[]>;

export type Grant = { permissions: string[]; orgUnitId: string | null };

export type UnitNode = { id: string; parentId: string | null };

/** Works out a user's scope from their role grants and the org unit tree. */
export function buildScope(grants: Grant[], units: UnitNode[]): Scope {
  const children = new Map<string, string[]>();
  for (const unit of units) {
    if (!unit.parentId) continue;
    const list = children.get(unit.parentId) ?? [];
    list.push(unit.id);
    children.set(unit.parentId, list);
  }
  /** A unit and everything beneath it. */
  const subtree = (rootId: string) => {
    const seen = new Set<string>([rootId]);
    const queue = [rootId];
    for (let id = queue.pop(); id; id = queue.pop()) {
      for (const child of children.get(id) ?? []) {
        // The tree should have no loops; `seen` makes sure one cannot hang us.
        if (!seen.has(child)) {
          seen.add(child);
          queue.push(child);
        }
      }
    }
    return seen;
  };

  const everywhere = new Set<string>();
  const covered = new Map<string, Set<string>>();
  for (const grant of grants) {
    const reach = grant.orgUnitId ? subtree(grant.orgUnitId) : null;
    for (const permission of grant.permissions) {
      if (!reach) {
        everywhere.add(permission);
        continue;
      }
      const set = covered.get(permission) ?? new Set<string>();
      for (const id of reach) set.add(id);
      covered.set(permission, set);
    }
  }

  const scope: Scope = {};
  for (const [permission, ids] of covered) scope[permission] = [...ids].sort();
  for (const permission of everywhere) scope[permission] = 'all';
  return scope;
}

/**
 * Whether the user holds a permission for this org unit: granted for the
 * whole organization, for the unit itself, or for a unit above it. With no
 * unit (`null`), only a whole-organization grant counts.
 */
export function covers(
  auth: { scope: Scope },
  permission: Permission,
  orgUnitId: string | null,
): boolean {
  const reach = Object.hasOwn(auth.scope, permission)
    ? auth.scope[permission]
    : undefined;
  if (!reach) return false;
  if (reach === 'all') return true;
  return orgUnitId !== null && reach.includes(orgUnitId);
}

/**
 * Where any of the given permissions applies, for building a query: `"all"`,
 * or the org unit ids covered by at least one of them (possibly none).
 */
export function reachOf(
  auth: { scope: Scope },
  permissions: Permission[],
): 'all' | string[] {
  const ids = new Set<string>();
  for (const permission of permissions) {
    const reach = Object.hasOwn(auth.scope, permission)
      ? auth.scope[permission]
      : undefined;
    if (reach === 'all') return 'all';
    for (const id of reach ?? []) ids.add(id);
  }
  return [...ids];
}
