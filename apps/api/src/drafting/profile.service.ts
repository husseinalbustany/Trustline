import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  documentSettings,
  documentTypes,
  organizationProfiles,
  roles,
  tenants,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { same } from './same.js';
import {
  emptyProfile,
  PROFILE_PARTS,
  profileFits,
  type ProfileInput,
} from './profile-input.js';


/**
 * The client profile: read and written by the client's administrators, and
 * read by drafting. Every change is audited with the parts that changed.
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  get(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) => this.view(tx, auth.tenant.id));
  }

  /**
   * Replaces the profile. 409 `profile_changed` when it changed since the
   * revision read; 400 `language_mismatch`, or `unknown_role` for a title
   * mapped to a role the client does not have.
   */
  put(auth: AuthContext, input: ProfileInput & { revision: number }) {
    const { tenant, user } = auth;
    const { revision, ...profile } = input;
    if (!profileFits(profile, tenant)) throw new BadRequestException({ code: 'language_mismatch' });
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const roleIds = [...new Set(profile.titles.flatMap((t) => (t.roleId ? [t.roleId] : [])))];
      if (roleIds.length > 0) {
        const found = await tx.select({ id: roles.id }).from(roles).where(inArray(roles.id, roleIds));
        if (found.length !== roleIds.length) throw new BadRequestException({ code: 'unknown_role' });
      }
      const [current] = await tx
        .select({ profile: organizationProfiles.profile, revision: organizationProfiles.revision })
        .from(organizationProfiles)
        .where(eq(organizationProfiles.tenantId, tenant.id))
        .for('update');
      if ((current?.revision ?? 0) !== revision) throw new ConflictException({ code: 'profile_changed' });
      const before = (current?.profile as ProfileInput | undefined) ?? null;
      const changed = PROFILE_PARTS.filter((part) => !before || !same(before[part], profile[part]));
      if (changed.length === 0) return this.view(tx, tenant.id);
      if (current) {
        await tx
          .update(organizationProfiles)
          .set({ profile, revision: current.revision + 1, updatedBy: user.id, updatedAt: new Date() })
          .where(eq(organizationProfiles.tenantId, tenant.id));
      } else {
        await tx.insert(organizationProfiles).values({ tenantId: tenant.id, profile, updatedBy: user.id });
      }
      // Which parts changed, not what they say: the profile keeps that.
      await this.provisioning.audit(tx, tenant.id, user.id, 'organization_profile_updated', 'tenant', tenant.id, { changed });
      return this.view(tx, tenant.id);
    });
  }

  /** The profile as stored, or an empty one. In a transaction of the client's. */
  async read(tx: Transaction, tenantId: string): Promise<{ profile: ProfileInput; revision: number }> {
    const [row] = await tx
      .select({ profile: organizationProfiles.profile, revision: organizationProfiles.revision })
      .from(organizationProfiles)
      .where(eq(organizationProfiles.tenantId, tenantId));
    if (row) return { profile: row.profile as ProfileInput, revision: row.revision };
    const [tenant] = await tx.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId));
    return { profile: emptyProfile(tenant.name), revision: 0 };
  }

  /**
   * The profile, with what it takes from elsewhere and does not hold: the
   * client's languages and authoritative language, and each document type's
   * numbering and review period (its house rules).
   */
  private async view(tx: Transaction, tenantId: string) {
    const { profile, revision } = await this.read(tx, tenantId);
    const [tenant] = await tx
      .select({ locales: tenants.locales, defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    const [settings] = await tx
      .select({ authoritativeLocale: documentSettings.authoritativeLocale })
      .from(documentSettings)
      .where(eq(documentSettings.tenantId, tenantId));
    const types = await tx
      .select({
        id: documentTypes.id,
        name: documentTypes.name,
        numberPrefix: documentTypes.numberPrefix,
        defaultReviewMonths: documentTypes.defaultReviewMonths,
      })
      .from(documentTypes)
      .where(eq(documentTypes.active, true))
      .orderBy(asc(documentTypes.position));
    return {
      ...profile,
      revision,
      fromSettings: {
        languages: tenant.locales,
        defaultLocale: tenant.defaultLocale,
        authoritativeLocale: settings?.authoritativeLocale ?? null,
        documentTypes: types,
      },
    };
  }
}
