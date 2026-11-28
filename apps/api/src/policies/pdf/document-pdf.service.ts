import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TenantDb } from '../../database/tenant-db.service.js';
import { dayOf } from '../../i18n/time-zones.js';
import { SUPPORTED_LOCALES, type Locale, type Localized } from '../../i18n/locales.js';
import type { AuthContext } from '../../identity/auth.service.js';
import { ProvisioningService } from '../../identity/provisioning.service.js';
import { DocumentsService } from '../documents.service.js';
import { PdfRenderer } from './renderer.js';
import { documentPdfHtml, type Standing } from './template.js';

/** How many pages a PDF has: its page objects. */
const pagesOf = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;

/**
 * A version of a controlled document as a PDF (docs/specs/document-pdf.md):
 * in one of its languages or side by side in two, the language that applies
 * first; the page's direction and labels in the language asked for. Made by
 * the shared renderer from what the version route gives, and audited
 * (`document_pdf_made`).
 */
@Injectable()
export class DocumentPdfService {
  constructor(
    private readonly documents: DocumentsService,
    private readonly renderer: PdfRenderer,
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  async make(auth: AuthContext, id: string, versionId: string, asked: { languages?: string[]; locale?: string }, ip: string | null) {
    const locale = (asked.locale ?? auth.tenant.defaultLocale) as Locale;
    if (!auth.tenant.locales.includes(locale) || !(SUPPORTED_LOCALES as readonly string[]).includes(locale)) {
      throw new BadRequestException({ code: 'language_mismatch', field: 'locale' });
    }
    const { document, version } = await this.documents.printable(auth, id, versionId);
    const authoritative = version.languageStatus.authoritative;
    // One or two of the version's languages, the language that applies first.
    const wanted = asked.languages ?? [version.languages.includes(locale) ? locale : authoritative];
    if (
      wanted.length < 1 ||
      wanted.length > 2 ||
      new Set(wanted).size !== wanted.length ||
      !wanted.every((l) => version.languages.includes(l) && (SUPPORTED_LOCALES as readonly string[]).includes(l))
    ) {
      throw new BadRequestException({ code: 'language_mismatch', field: 'languages' });
    }
    const languages = [...wanted].sort((a, b) => (a === authoritative ? -1 : b === authoritative ? 1 : 0)) as Locale[];
    const control = version.control;
    const standing: Standing | null = control.inForce
      ? null
      : document.status === 'retired'
        ? 'retired'
        : version.status === 'superseded'
          ? 'superseded'
          : version.status === 'withdrawn'
            ? 'withdrawn'
            : 'unpublished';
    const zone = auth.tenant.timeZone;
    const dayIn = (at: Date | string | null) => (at ? dayOf(new Date(at), zone) : null);
    const name = (p: { name: Localized | null } | null) => (p?.name ? pickName(p.name, locale, auth.tenant.defaultLocale) : null);
    const site = (process.env.WEB_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/+$/, '');
    const imported = control.approvedBeforeTrustline;
    const html = documentPdfHtml({
      locale,
      defaultLocale: auth.tenant.defaultLocale,
      today: dayOf(new Date(), zone),
      languages,
      authoritative,
      link: `${site}/${locale}/policies/${document.id}`,
      number: document.number,
      title: document.title,
      version: version.version,
      originalRevision: control.originalRevision ?? null,
      owner: name(control.owner),
      ownerUnit: document.ownerUnit?.name ?? null,
      effectiveOn: control.effectiveOn,
      nextReviewOn: control.nextReviewOn,
      approvals: [
        ...(control.preparedBy ? [{ kind: 'prepare', signedBy: name(control.preparedBy), signedOn: dayIn(version.preparedAt) }] : []),
        ...control.approvals.map((a) => ({ kind: a.kind, signedBy: name(a.signedBy), signedOn: dayIn(a.signedAt) })),
      ],
      imported: imported
        ? {
            revisionLabel: imported.revisionLabel ?? null,
            approvedOn: imported.approvedOn ?? null,
            approvedBy: imported.approvedBy ?? null,
            originalKeptAt: (imported.originalKeptAt as Localized | null) ?? null,
            differences: typeof imported.differences === 'string' ? imported.differences : imported.differences ? JSON.stringify(imported.differences) : null,
          }
        : null,
      contentHash: version.contentHash,
      sections: version.sections.map((s) => ({ key: s.key, name: s.name })),
      content: version.content,
      states: Object.fromEntries(version.languageStatus.sections.map((s) => [s.key, s.locales])),
      standing,
      aiDraft: !!document.aiDraft && !document.aiDraft.ownedAt,
      fontFaces: this.renderer.fontFaces,
    });
    const pdf = await this.renderer.render(html);
    const sha256 = createHash('sha256').update(pdf).digest('hex');
    const pages = pagesOf(pdf);
    await this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'document_pdf_made', 'document', document.id, {
        versionId: version.id,
        version: version.version,
        languages,
        locale,
        pages,
        sha256,
      }, ip),
    );
    const safe = document.number.replace(/[^A-Za-z0-9-]/g, '-');
    return { pdf, sha256, pages, fileName: `${safe}-v${version.version}-${languages.join('-')}.pdf` };
  }
}

const pickName = (name: Localized, locale: string, fallback: string) => name[locale as Locale] ?? name[fallback as Locale] ?? Object.values(name)[0] ?? '';
