import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { documentDesigns, documentTypes, tenants, type DocumentSection } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import type { Localized } from '../i18n/locales.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { same } from './same.js';
import { defaultDesign, designFits, type DesignInput, type Template, type Writing } from './design-input.js';
import { ProfileService } from './profile.service.js';


/** The design that applies, where it comes from, and the type's sections. */
export type EffectiveDesign = {
  /** The stored design used; null for the starting design. */
  id: string | null;
  /** `type`: the type's own; `organization`: the organization's; `defaults`. */
  source: 'type' | 'organization' | 'defaults';
  version: number;
  template: Template;
  writing: Writing;
  sectionGuidance: Record<string, Localized>;
  /** Null when asked for the organization's design. */
  type: { id: string; name: Localized; sections: DocumentSection[] } | null;
};

/**
 * The client's document design: one for the whole organization, and one
 * per document type where the client wants them visibly different. Each
 * change is a new version, audited; none is overwritten.
 */
@Injectable()
export class DesignService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly profiles: ProfileService,
  ) {}

  get(auth: AuthContext, typeId: string | null) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) => this.effective(tx, auth.tenant.id, typeId));
  }

  /**
   * Saves a new version of the organization's design (`documentTypeId`
   * null) or of one type's. 409 `design_changed` when another was saved
   * since the version read; 400 `unknown_type`, `unknown_section` (a
   * guidance for a section the type does not have), `language_mismatch`.
   */
  put(auth: AuthContext, input: DesignInput) {
    const { tenant, user } = auth;
    const sectionGuidance = Object.fromEntries(
      Object.entries(input.sectionGuidance).filter((e): e is [string, Localized] => e[1] !== null),
    );
    if (!designFits({ ...input, sectionGuidance }, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const type = input.documentTypeId
        ? await this.typeOf(tx, input.documentTypeId).catch(() => {
            throw new BadRequestException({ code: 'unknown_type' });
          })
        : null;
      const keys = new Set(
        type
          ? type.sections.map((s) => s.key)
          : (await tx.select({ sections: documentTypes.sections }).from(documentTypes)).flatMap((t) =>
              t.sections.map((s) => s.key),
            ),
      );
      const unknown = Object.keys(sectionGuidance).find((k) => !keys.has(k));
      if (unknown) throw new BadRequestException({ code: 'unknown_section', section: unknown });

      // One change at a time per design.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`trustline.design.${tenant.id}.${input.documentTypeId ?? 'organization'}`}, 0))`,
      );
      const current = await this.ownOf(tx, input.documentTypeId);
      if ((current?.version ?? 0) !== input.version) throw new ConflictException({ code: 'design_changed' });
      const before = current ?? (await this.effective(tx, tenant.id, input.documentTypeId));
      const changed = (['template', 'writing', 'sectionGuidance'] as const).filter(
        (part) => !current || !same(before[part], part === 'sectionGuidance' ? sectionGuidance : input[part]),
      );
      if (changed.length === 0) return this.effective(tx, tenant.id, input.documentTypeId);
      const version = (current?.version ?? 0) + 1;
      await tx.insert(documentDesigns).values({
        tenantId: tenant.id,
        documentTypeId: input.documentTypeId,
        version,
        template: input.template,
        writing: input.writing,
        sectionGuidance,
        createdBy: user.id,
      });
      await this.provisioning.audit(tx, tenant.id, user.id, 'document_design_updated', 'tenant', tenant.id, {
        documentTypeId: input.documentTypeId,
        version,
        changed,
      });
      return this.effective(tx, tenant.id, input.documentTypeId);
    });
  }

  /**
   * The design that applies to a type (or to the organization, for null):
   * the type's own, else the organization's, else the starting design made
   * from the profile. With the type's sections.
   */
  async effective(tx: Transaction, tenantId: string, typeId: string | null): Promise<EffectiveDesign> {
    const type = typeId ? await this.typeOf(tx, typeId) : null;
    const own = typeId ? await this.ownOf(tx, typeId) : null;
    const organization = own ? null : await this.ownOf(tx, null);
    const stored = own ?? organization;
    if (stored) {
      return {
        id: stored.id,
        source: own ? 'type' : 'organization',
        version: stored.version,
        template: stored.template as Template,
        writing: stored.writing as Writing,
        sectionGuidance: stored.sectionGuidance,
        type,
      };
    }
    const { profile } = await this.profiles.read(tx, tenantId);
    const [languages] = await tx
      .select({ locales: tenants.locales, defaultLocale: tenants.defaultLocale })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    return { id: null, source: 'defaults', version: 0, ...defaultDesign(profile, languages), type };
  }

  private async ownOf(tx: Transaction, typeId: string | null) {
    const [row] = await tx
      .select({
        id: documentDesigns.id,
        version: documentDesigns.version,
        template: documentDesigns.template,
        writing: documentDesigns.writing,
        sectionGuidance: documentDesigns.sectionGuidance,
      })
      .from(documentDesigns)
      .where(typeId ? eq(documentDesigns.documentTypeId, typeId) : isNull(documentDesigns.documentTypeId))
      .orderBy(desc(documentDesigns.version))
      .limit(1);
    return row ?? null;
  }

  async typeOf(tx: Transaction, typeId: string) {
    const [type] = await tx
      .select({ id: documentTypes.id, name: documentTypes.name, sections: documentTypes.sections })
      .from(documentTypes)
      .where(and(eq(documentTypes.id, typeId), eq(documentTypes.active, true)));
    if (!type) throw new NotFoundException({ code: 'unknown_type' });
    return type;
  }
}
