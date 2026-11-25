import type { OrgUnit } from "./identity";

export type UnitType = OrgUnit["type"];

export const unitTypes = ["facility", "department", "unit"] as const;

/**
 * The three levels: what each sits under, and what is added under it. The
 * API decides; this only lets a form offer the choices it will accept.
 */
export const parentType: Record<UnitType, UnitType | null> = {
  facility: null,
  department: "facility",
  unit: "department",
};

export const childType: Record<UnitType, UnitType | null> = {
  facility: "department",
  department: "unit",
  unit: null,
};

/**
 * What placing a unit in the tree needs. The form for reporting without
 * sign-in gets no more than this, and only units that are active.
 */
export type TreeUnit = Pick<OrgUnit, "id" | "parentId" | "type" | "name"> & {
  active?: boolean;
};

/**
 * Units in the order of the tree: each one followed by what sits under it.
 * The API returns them ordered by code, not by place in the tree.
 */
export function inTreeOrder<T extends TreeUnit>(units: T[]): T[] {
  const ids = new Set(units.map((u) => u.id));
  const out: T[] = [];
  const seen = new Set<string>();
  const add = (parentId: string | null) => {
    for (const unit of units) {
      const isChild = parentId
        ? unit.parentId === parentId
        : !unit.parentId || !ids.has(unit.parentId);
      if (!isChild || seen.has(unit.id)) continue;
      seen.add(unit.id);
      out.push(unit);
      add(unit.id);
    }
  };
  add(null);
  return out;
}

const indent = { facility: "", department: "— ", unit: "— — " };

export type UnitOption = { id: string; label: string; inactive: boolean };

/**
 * Org units as the options of a select: the ones that can be chosen, each
 * under its parent and indented by level.
 *
 * `stored` is the unit already saved on the record being edited, with the
 * label to give it if it has been switched off since. It is then no longer
 * a choice, but it is listed first, marked inactive, so the form shows where
 * the record really is instead of quietly showing something else. The
 * record itself carries the unit's name, so nothing is looked up.
 *
 * `indented` is false where the reader does not know the hospital's tree,
 * and the dashes in front of a name would only be noise.
 */
export function unitOptions<T extends TreeUnit>(
  units: T[],
  nameOf: (unit: T) => string,
  stored?: { id: string; label: string } | null,
  indented = true,
): UnitOption[] {
  const out = inTreeOrder(units.filter((u) => u.active !== false)).map(
    (unit) => ({
      id: unit.id,
      // An option holds no elements, so the name is isolated with
      // U+2068 … U+2069: a name in the other direction ending in a bracket
      // keeps the bracket at its own end.
      label: `${indented ? indent[unit.type] : ""}\u2068${nameOf(unit)}\u2069`,
      inactive: false,
    }),
  );
  if (stored && !out.some((o) => o.id === stored.id)) {
    out.unshift({ id: stored.id, label: stored.label, inactive: true });
  }
  return out;
}
