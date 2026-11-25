import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { pgErrorCode } from '../database/errors.js';
import { orgUnits } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { sameText, type Localized } from '../i18n/locales.js';

export type OrgUnitType = (typeof orgUnits.type.enumValues)[number];

/**
 * The three levels, and what each sits under. A unit's type never changes,
 * so this alone keeps the tree free of loops: nothing can be placed under
 * itself or under something beneath it, which is always of a lower level.
 */
const PARENT_TYPE: Record<OrgUnitType, OrgUnitType | null> = {
  facility: null,
  department: 'facility',
  unit: 'department',
};

/** What the API returns for an org unit. */
const unitFields = {
  id: orgUnits.id,
  parentId: orgUnits.parentId,
  type: orgUnits.type,
  code: orgUnits.code,
  name: orgUnits.name,
  active: orgUnits.active,
};

export type CreateInput = {
  type: OrgUnitType;
  code: string;
  name: Localized;
  parentId: string | null;
};

export type UpdateInput = {
  name?: Localized;
  parentId?: string | null;
  active?: boolean;
};

/**
 * The rules of a hospital's structure: facilities, the departments in them
 * and the units in those. A unit is switched off, never deleted, and while it
 * is on, everything above it is on too.
 */
@Injectable()
export class OrgUnitsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  /** The structure in code order. Units switched off only when asked for. */
  list(auth: AuthContext, includeInactive: boolean) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select(unitFields)
        .from(orgUnits)
        .where(includeInactive ? undefined : eq(orgUnits.active, true))
        .orderBy(asc(orgUnits.code)),
    );
  }

  /**
   * For the other areas: the units that can be chosen for something new, in
   * code order, with what a form needs to show them as a tree and no more.
   * `tx` is already scoped to the hospital.
   */
  choosable(tx: Transaction) {
    return tx
      .select({
        id: orgUnits.id,
        parentId: orgUnits.parentId,
        type: orgUnits.type,
        name: orgUnits.name,
      })
      .from(orgUnits)
      .where(eq(orgUnits.active, true))
      .orderBy(asc(orgUnits.code));
  }

  /**
   * For the other areas: refuses (400 `unknown_org_unit`) org units that
   * cannot be chosen for something new, because they do not exist in this
   * hospital or are switched off. Holds them until the transaction ends, so
   * none can be switched off between this check and the caller's write.
   */
  async assertActive(tx: Transaction, orgUnitIds: (string | null)[]) {
    const ids = [...new Set(orgUnitIds.filter((id) => id !== null))];
    if (ids.length === 0) return;
    const found = await tx
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(and(inArray(orgUnits.id, ids), eq(orgUnits.active, true)))
      .for('share');
    if (found.length !== ids.length) {
      throw new BadRequestException({ code: 'unknown_org_unit' });
    }
  }

  /** Reads a unit and holds it as it is until the transaction ends. */
  private async hold(tx: Transaction, id: string) {
    const [unit] = await tx
      .select({ id: orgUnits.id, type: orgUnits.type, active: orgUnits.active })
      .from(orgUnits)
      .where(eq(orgUnits.id, id))
      .for('share');
    return unit as typeof unit | undefined;
  }

  /**
   * The parent a unit of this type may sit under: none for a facility, a
   * facility for a department, a department for a unit. Anything else,
   * another hospital's unit included, is refused.
   */
  private async allowedParent(
    tx: Transaction,
    type: OrgUnitType,
    parentId: string | null,
  ) {
    const invalid = () => new BadRequestException({ code: 'invalid_parent' });
    const parentType = PARENT_TYPE[type];
    if (parentType === null) {
      if (parentId !== null) throw invalid();
      return null;
    }
    if (parentId === null) throw invalid();
    const parent = await this.hold(tx, parentId);
    if (!parent || parent.type !== parentType) throw invalid();
    return parent;
  }

  async create(auth: AuthContext, input: CreateInput) {
    const { tenant, user } = auth;
    try {
      return await this.tenantDb.withTenant(tenant.id, async (tx) => {
        const parent = await this.allowedParent(tx, input.type, input.parentId);
        // A new unit is on, so what it sits under must be on too.
        if (parent && !parent.active) {
          throw new ConflictException({ code: 'parent_inactive' });
        }
        const [unit] = await tx
          .insert(orgUnits)
          .values({ ...input, tenantId: tenant.id })
          .returning(unitFields);
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'org_unit_created',
          'org_unit',
          unit.id,
          { type: unit.type, parentId: unit.parentId },
        );
        return unit;
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') {
        throw new ConflictException({ code: 'code_taken' });
      }
      throw e;
    }
  }

  update(auth: AuthContext, id: string, input: UpdateInput) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      // Locked, so two changes to one unit cannot pass each other's checks.
      const [unit] = await tx
        .select(unitFields)
        .from(orgUnits)
        .where(eq(orgUnits.id, id))
        .for('update');
      if (!unit) throw new NotFoundException();

      const parentId =
        input.parentId === undefined ? unit.parentId : input.parentId;
      const active = input.active ?? unit.active;
      const renamed =
        input.name !== undefined && !sameText(input.name, unit.name);
      const moved = parentId !== unit.parentId;
      const switched = active !== unit.active;

      // The parent matters when the unit moves, or is switched on where it is.
      let parent = moved
        ? await this.allowedParent(tx, unit.type, parentId)
        : null;
      if (!moved && switched && active && parentId) {
        parent = (await this.hold(tx, parentId)) ?? null;
      }
      // While a unit is on, what it sits under is on too.
      if (active && parent && !parent.active) {
        throw new ConflictException({ code: 'parent_inactive' });
      }
      // Switched off from the bottom up, never over something still on.
      if (switched && !active) {
        const [child] = await tx
          .select({ id: orgUnits.id })
          .from(orgUnits)
          .where(and(eq(orgUnits.parentId, id), eq(orgUnits.active, true)))
          .limit(1);
        if (child) {
          throw new ConflictException({ code: 'has_active_children' });
        }
      }

      const changed = [
        ...(renamed ? ['name'] : []),
        ...(switched ? ['active'] : []),
      ];
      // Nothing differs from what is stored: no write, nothing to audit.
      if (changed.length === 0 && !moved) return unit;

      const [updated] = await tx
        .update(orgUnits)
        .set({
          ...(renamed && { name: input.name }),
          ...(moved && { parentId }),
          ...(switched && { active }),
          updatedAt: new Date(),
        })
        .where(eq(orgUnits.id, id))
        .returning(unitFields);
      // A move changes what every role granted above the unit covers, so it
      // is recorded as an action of its own, easy to find later.
      if (moved) {
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'org_unit_moved',
          'org_unit',
          id,
          { from: unit.parentId, to: parentId },
        );
      }
      // Which other fields changed, and the on/off state: never the name.
      if (renamed || switched) {
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'org_unit_updated',
          'org_unit',
          id,
          { changed, ...(switched && { active }) },
        );
      }
      return updated;
    });
  }
}
