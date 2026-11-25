import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import type { Permission } from './permissions.js';

/**
 * Who holds what, where: for a set of permissions and a set of org units,
 * every active user whose roles give them one of those permissions over one
 * of those units.
 */
export type Holders = {
  /**
   * The active users who hold this permission for any of these units: for
   * the whole organization, for the unit itself, or for a unit above it.
   * Units left out when asking (and null) are covered only from the whole
   * organization.
   */
  of(permission: Permission, unitIds: (string | null)[]): Set<string>;
  /** The active users who hold it for the whole organization. */
  everywhere(permission: Permission): Set<string>;
};

/**
 * The same question `covers()` in scope.ts answers for the person signed in,
 * answered for everybody at once: one query, in the database, whatever the
 * number of users. `covers()` reads a scope built from "the granted unit and
 * everything beneath it"; this walks the other way, from each unit asked
 * about up to the top, and keeps the grants made anywhere on that path. The
 * two agree, and notifications.e2e-spec.ts holds them to it.
 */
@Injectable()
export class AccessService {
  /**
   * `tx` is already scoped to the hospital by TenantDb.withTenant(), so only
   * its users, roles and units are read.
   */
  async holders(
    tx: Transaction,
    permissions: Permission[],
    unitIds: (string | null)[],
  ): Promise<Holders> {
    const asked = [...new Set(unitIds.filter((id) => id !== null))];
    const list = (values: string[], type: 'uuid' | 'text') =>
      values.length > 0
        ? sql`array[${sql.join(
            values.map((v) => sql`${v}`),
            sql`, `,
          )}]::${sql.raw(type)}[]`
        : sql`'{}'::${sql.raw(type)}[]`;
    // `above` pairs each unit asked about with itself and every unit over
    // it. UNION, not UNION ALL, so a loop in the tree (there should be none)
    // cannot run for ever.
    const { rows } = await tx.execute<{
      user_id: string;
      permission: string;
      unit_id: string | null;
    }>(sql`
      with recursive above (unit_id, ancestor_id) as (
        select u.id, u.id from org_units u where u.id = any(${list(asked, 'uuid')})
        union
        select a.unit_id, u.parent_id
        from above a
        join org_units u on u.id = a.ancestor_id
        where u.parent_id is not null
      )
      select distinct ra.user_id, p.permission, a.unit_id
      from role_assignments ra
      join roles r on r.id = ra.role_id
      join users u on u.id = ra.user_id and u.status = 'active'
      join unnest(${list(permissions, 'text')}) as p (permission)
        on p.permission = any(r.permissions)
      left join above a on a.ancestor_id = ra.org_unit_id
      where ra.org_unit_id is null or a.unit_id is not null`);

    // Per permission: who holds it everywhere, and who for each unit asked.
    const everywhere = new Map<string, Set<string>>();
    const byUnit = new Map<string, Set<string>>();
    const into = (map: Map<string, Set<string>>, key: string, id: string) => {
      const set = map.get(key) ?? new Set<string>();
      set.add(id);
      map.set(key, set);
    };
    for (const row of rows) {
      if (row.unit_id === null) into(everywhere, row.permission, row.user_id);
      else into(byUnit, `${row.permission} ${row.unit_id}`, row.user_id);
    }
    return {
      of(permission, units) {
        const found = new Set(everywhere.get(permission));
        for (const unit of units) {
          if (unit === null) continue;
          for (const id of byUnit.get(`${permission} ${unit}`) ?? []) {
            found.add(id);
          }
        }
        return found;
      },
      everywhere: (permission) => new Set(everywhere.get(permission)),
    };
  }
}
