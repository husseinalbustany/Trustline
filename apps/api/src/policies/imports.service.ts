import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { contentHash, SignatureService } from '../approvals/signatures.js';
import type { Transaction } from '../database/client.js';
import { pgErrorCode } from '../database/errors.js';
import {
  documentImportBatches,
  documentImports,
  documents,
  documentTypes,
  documentVersions,
  type DocumentContent,
  type DocumentSection,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { AuthService, type AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import { fitsLanguages } from '../i18n/locales.js';
import { addMonths, dayOf, shiftDay } from '../i18n/time-zones.js';
import { OrgUnitsService } from '../organization/org-units.service.js';
import { contentSize, VERSION_MAX_CHARS } from './content.js';
import { DocumentNotifier } from './document-notifier.js';
import {
  assertReviewPeriod,
  authoritativeLocaleOf,
  documentSettingsOf,
} from './document-settings.js';
import { DocumentsService } from './documents.service.js';
import {
  IMPORT_MAX_CHARS,
  IMPORT_MAX_DOCUMENTS,
  importDocumentSchema,
  type ImportDocumentInput,
} from './input.js';
import {
  assertImportWindowOpen,
  importWindowOf,
  importWindowView,
  type ImportWindow,
} from './import-window.js';
import {
  advanceSeries,
  lettersOutside,
  mixesScripts,
  nextDocumentNumber,
  normalizeNumber,
  seriesOf,
} from './numbering.js';
import { Publisher } from './publisher.js';
import { checkedSection } from './section-input.js';
import { signedImport, type ImportedOriginal } from './signed-content.js';

/**
 * How long the owner of an imported document has to confirm it (business
 * decision 1), from the day it is imported, on the client's calendar.
 */
export const IMPORT_CONFIRM_DAYS = 30;

/** Why one document of a batch is refused: its code and details, and where it stands. */
export type ImportProblem = {
  index: number;
  number: string | null;
  code: string;
  [detail: string]: unknown;
};

/** A document of a batch once every check has passed. */
type Planned = {
  index: number;
  input: ImportDocumentInput;
  type: {
    id: string;
    numberPrefix: string;
    sections: DocumentSection[];
  };
  category: { id: string; code: string };
  content: DocumentContent;
  reviewMonths: number;
  effectiveOn: string;
  /** The number as given, spaces made one; null: Trustline numbers it. */
  given: string | null;
  series: { series: string; n: number } | null;
  /** Keys of the sections with no text in the authoritative language. */
  notWritten: string[];
  /** The authoritative language, recorded on the version. */
  authoritative: string;
};

/** The number a batch's problem names: as given, if it was. */
const numberOf = (raw: unknown): string | null => {
  const value = (raw as { number?: unknown } | null)?.number;
  return typeof value === 'string'
    ? value.slice(0, 200).trim().replace(/\s+/g, ' ') || null
    : null;
};

/** A refusal's code and details, from the exception that said it. */
function problemOf(e: HttpException) {
  const body = e.getResponse();
  return typeof body === 'object' && body && 'code' in body
    ? (body as { code: string } & Record<string, unknown>)
    : { code: 'invalid_document' };
}

const refused = (problems: ImportProblem[]) =>
  new BadRequestException({ code: 'batch_refused', problems });

/**
 * Imports an organization's existing documents as approved before
 * Trustline (business decision 1), one by one or in batches, for those who
 * manage documents for the whole organization.
 *
 * Each document becomes a new document whose version 1 is published at
 * once with source `imported`: the details of its approval before Trustline
 * as the original gives them (number, revision label, approval day and
 * approver, where the signed original is kept, the day it took effect and
 * its next review) are kept in `document_imports`, written once; and the
 * importer signs, with their password, that the text is the approved
 * original's (meaning `imported`, one signature per document over its
 * version and those details). It went through no route: it has no run,
 * no Trustline approval and is never shown as having one. Its readers are
 * asked to acknowledge it only if the importer says so. At its next review
 * it is re-issued: a new version, through the route, with signatures.
 *
 * A batch is all or nothing: one password re-entry covers the listed
 * documents, so either every one of them is imported, signed and audited,
 * or none is, and the answer says which were refused and why.
 */
@Injectable()
export class ImportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly signatures: SignatureService,
    private readonly auth: AuthService,
    private readonly notifier: DocumentNotifier,
    private readonly publisher: Publisher,
    private readonly orgUnits: OrgUnitsService,
    private readonly documents: DocumentsService,
  ) {}

  /**
   * Only for those who may import for the whole organization: the Quality
   * officer (business decision 1, `policies.import`).
   */
  private assertImporter(auth: AuthContext) {
    if (!covers(auth, 'policies.import', null)) {
      throw new ForbiddenException({
        code: 'missing_permission',
        permission: 'policies.import',
      });
    }
  }

  /** At most so many documents, and so much text, in one batch. */
  private assertBatchSize(list: unknown[]) {
    if (list.length > IMPORT_MAX_DOCUMENTS) {
      throw new BadRequestException({
        code: 'batch_too_large',
        maxDocuments: IMPORT_MAX_DOCUMENTS,
        maxCharacters: IMPORT_MAX_CHARS,
      });
    }
  }

  /**
   * Checks a batch without importing it or asking for the password: what
   * each document would be numbered from, and the sections it would come
   * without. 400 `batch_refused` with every document refused and why.
   */
  check(auth: AuthContext, list: unknown[]) {
    this.assertImporter(auth);
    this.assertBatchSize(list);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const planned = await this.plan(tx, auth, list);
      return {
        // When imports close, and the latest approval day accepted.
        window: importWindowView(await importWindowOf(tx, auth.tenant)),
        documents: planned.map((p) => ({
          index: p.index,
          // Normalised (numbering.ts): as it will be kept.
          number: p.given,
          numberFrom: p.given ? ('given' as const) : ('trustline' as const),
          // The series whose counter it advances (a number given in
          // Trustline's shape), or Trustline numbers it from.
          series: p.series?.series ?? (p.given ? null : `${p.type.numberPrefix}-${p.category.code}`),
          sectionsNotWritten: this.notWrittenView(p),
          acknowledgementRequired: p.input.acknowledgementRequired,
        })),
      };
    });
  }

  /** One document, imported on its own; answered as the document. */
  async importOne(
    auth: AuthContext,
    input: { password: string } & Record<string, unknown>,
    ip: string | null,
  ) {
    const { password, ...document } = input;
    try {
      return await this.run(auth, password, [document], ip, true);
    } catch (e) {
      // On its own, a document's refusal is its own answer.
      if (e instanceof BadRequestException) {
        const body = e.getResponse() as { code?: string; problems?: ImportProblem[] };
        if (body.code === 'batch_refused' && body.problems?.length === 1) {
          const { index: _index, number: _number, status, ...problem } = body.problems[0];
          throw new HttpException(problem, typeof status === 'number' ? status : 400);
        }
      }
      throw e;
    }
  }

  /** A batch, under one password re-entry. */
  importBatch(
    auth: AuthContext,
    input: { password: string; documents: unknown[] },
    ip: string | null,
  ) {
    return this.run(auth, input.password, input.documents, ip, false);
  }

  /**
   * Everything is checked before the password, so that a batch refused for
   * another reason neither asks for it nor counts it; then again, with the
   * counters of the numbers given held, before anything is written.
   */
  private async run(
    auth: AuthContext,
    password: string,
    list: unknown[],
    ip: string | null,
    single: boolean,
  ) {
    this.assertImporter(auth);
    this.assertBatchSize(list);
    const { tenant, user } = auth;
    const checked = await this.tenantDb.withTenant(tenant.id, (tx) =>
      this.plan(tx, auth, list),
    );
    await this.auth.confirmPassword(auth, password, 'import', ip);
    try {
      return await this.tenantDb.withTenant(tenant.id, async (tx) => {
        // Every counter the batch uses, held first and in one order, so
        // that two imports at once take turns rather than wait for each
        // other: those of the numbers given in Trustline's shape, raised
        // past them, so that the numbers Trustline gives come after them;
        // and those it numbers from. Then everything is checked again
        // under that hold.
        const held = this.preview(list);
        for (const p of checked) {
          const series = `${p.type.numberPrefix}-${p.category.code}`;
          if (!p.given && !held.has(series)) held.set(series, 0);
        }
        const counters = new Map<string, { from: number; to: number }>();
        for (const [series, n] of [...held].sort(([a], [b]) => (a < b ? -1 : 1))) {
          counters.set(series, await advanceSeries(tx, tenant.id, series, n));
        }
        const planned = await this.plan(tx, auth, list);
        const now = new Date();
        const today = dayOf(now, tenant.timeZone);
        const written: {
          planned: Planned;
          documentId: string;
          versionId: string;
          number: string;
          original: ImportedOriginal;
          signature: Awaited<ReturnType<SignatureService['sign']>>;
          asked: number;
        }[] = [];
        for (const p of planned) {
          written.push(await this.write(tx, auth, p, now, today));
        }
        // The listed set the one password re-entry covered, in order.
        const list_ = written.map((w) => ({
          index: w.planned.index,
          documentId: w.documentId,
          number: w.number,
          versionId: w.versionId,
          contentHash: w.signature.contentHash,
        }));
        const listHash = contentHash(list_);
        const [batch] = await tx
          .insert(documentImportBatches)
          .values({
            tenantId: tenant.id,
            importedBy: user.id,
            importedAt: now,
            size: written.length,
            listHash,
          })
          .returning({ id: documentImportBatches.id });
        for (const w of written) {
          await tx.insert(documentImports).values({
            tenantId: tenant.id,
            batchId: batch.id,
            batchIndex: w.planned.index,
            documentId: w.documentId,
            versionId: w.versionId,
            ...w.original,
            sectionsNotWritten: w.planned.notWritten,
            signatureId: w.signature.id,
            importedBy: user.id,
            importedAt: now,
            // The owner confirms it within IMPORT_CONFIRM_DAYS (business
            // decision 1); an importer who is the owner confirms it by
            // importing it.
            confirmationDueOn: shiftDay(today, IMPORT_CONFIRM_DAYS),
            ...(w.planned.input.ownerId === user.id && {
              confirmedAt: now,
              confirmedBy: user.id,
              confirmedByImport: true,
            }),
          });
          const series = w.planned.series
            ? (counters.get(w.planned.series.series) ?? null)
            : null;
          await this.provisioning.audit(
            tx,
            tenant.id,
            user.id,
            'document_imported',
            'document',
            w.documentId,
            {
              number: w.number,
              numberFrom: w.planned.given ? 'given' : 'trustline',
              ...(w.planned.series && {
                counter: { series: w.planned.series.series, ...series },
              }),
              typeId: w.planned.type.id,
              categoryId: w.planned.category.id,
              ownerId: w.planned.input.ownerId,
              ownerUnitId: w.planned.input.ownerUnitId,
              confidentiality: w.planned.input.confidentiality,
              audience: w.planned.input.audience,
              reviewMonths: w.planned.reviewMonths,
              versionId: w.versionId,
              original: w.original,
              sectionsNotWritten: w.planned.notWritten,
              acknowledgementRequired: w.planned.input.acknowledgementRequired,
              acknowledgementsAsked: w.asked,
              signatureId: w.signature.id,
              contentHash: w.signature.contentHash,
              batchId: batch.id,
              batchIndex: w.planned.index,
              batchSize: written.length,
            },
          );
        }
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'document_import_signed',
          'tenant',
          tenant.id,
          {
            batchId: batch.id,
            size: written.length,
            listHash,
            documents: list_,
          },
        );
        if (single) return this.documents.detailOf(tx, auth, written[0].documentId);
        return {
          batch: { id: batch.id, size: written.length, importedAt: now, listHash },
          documents: written.map((w) => ({
            index: w.planned.index,
            id: w.documentId,
            number: w.number,
            numberFrom: w.planned.given ? ('given' as const) : ('trustline' as const),
            versionId: w.versionId,
            sectionsNotWritten: this.notWrittenView(w.planned),
            acknowledgementsAsked: w.asked,
            signature: {
              id: w.signature.id,
              meaning: w.signature.meaning,
              signedAt: w.signature.signedAt,
              contentHash: w.signature.contentHash,
            },
          })),
        };
      });
    } catch (e) {
      // A number taken by someone else between the check and the write.
      if (pgErrorCode(e) === '23505') {
        throw new ConflictException({ code: 'number_taken' });
      }
      throw e;
    }
  }

  private notWrittenView(p: Planned) {
    const missing = new Set(p.notWritten);
    return p.type.sections
      .filter((s) => missing.has(s.key))
      .map((s) => ({ key: s.key, required: s.required }));
  }

  /**
   * The series the given numbers belong to and the highest place each
   * takes, read from the request as it is, before it is checked: what the
   * counters are held and raised to. Anything refused later rolls back.
   */
  private preview(list: unknown[]) {
    const highest = new Map<string, number>();
    for (const raw of list) {
      const number = numberOf(raw);
      const found = number ? seriesOf(normalizeNumber(number)) : null;
      if (found && found !== 'tooLong') {
        highest.set(found.series, Math.max(highest.get(found.series) ?? 0, found.n));
      }
    }
    return highest;
  }

  /**
   * Every check of every document of the batch, without writing anything:
   * 400 `batch_refused` with each document refused (`index`, `number` as
   * given, and the `code` and details it would be refused with alone).
   */
  private async plan(tx: Transaction, auth: AuthContext, list: unknown[]) {
    const { tenant } = auth;
    const today = dayOf(new Date(), tenant.timeZone);
    // Only while the window is open (403 `import_window_closed`), checked
    // again in the transaction that writes.
    const window = await importWindowOf(tx, tenant);
    assertImportWindowOpen(window);
    const authoritative = await authoritativeLocaleOf(tx, tenant);
    const { maxReviewMonths } = await documentSettingsOf(tx);
    const problems: ImportProblem[] = [];
    const planned: Planned[] = [];
    // Each number once in the batch, whatever its capitals and zeros.
    const seen = new Map<string, number>();
    let characters = 0;
    for (const [index, raw] of list.entries()) {
      const number = numberOf(raw);
      const parsed = importDocumentSchema.safeParse(raw);
      if (!parsed.success) {
        problems.push({
          index,
          number,
          code: 'invalid_document',
          status: 400,
          // Which fields, never what they hold.
          fields: [
            ...new Set(
              parsed.error.issues.flatMap((i) =>
                i.code === 'unrecognized_keys'
                  ? i.keys.map((k) => [...i.path, k].join('.'))
                  : [i.path.join('.') || '(document)'],
              ),
            ),
          ],
        });
        continue;
      }
      try {
        const p = await this.planOne(tx, auth, index, parsed.data, {
          today,
          authoritative,
          maxReviewMonths,
          window,
        });
        const key = p.series
          ? `${p.series.series}-${p.series.n}`
          : p.given?.toUpperCase();
        if (key) {
          const first = seen.get(key);
          if (first !== undefined) {
            throw new BadRequestException({ code: 'duplicate_in_batch', sameAs: first });
          }
          seen.set(key, index);
        }
        characters += contentSize(p.content);
        planned.push(p);
      } catch (e) {
        if (!(e instanceof HttpException)) throw e;
        problems.push({ index, number, ...problemOf(e), status: e.getStatus() });
      }
    }
    if (problems.length > 0) throw refused(problems);
    if (characters > IMPORT_MAX_CHARS) {
      throw new BadRequestException({
        code: 'batch_too_large',
        maxDocuments: IMPORT_MAX_DOCUMENTS,
        maxCharacters: IMPORT_MAX_CHARS,
      });
    }
    return planned;
  }

  /** One document's checks, each refusal as it would be answered alone. */
  private async planOne(
    tx: Transaction,
    auth: AuthContext,
    index: number,
    input: ImportDocumentInput,
    at: {
      today: string;
      authoritative: string;
      maxReviewMonths: number;
      window: ImportWindow;
    },
  ): Promise<Planned> {
    const { tenant } = auth;
    if (!fitsLanguages(input.title, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch', field: 'title' });
    }
    if (!fitsLanguages(input.originalKeptAt, tenant)) {
      throw new BadRequestException({
        code: 'language_mismatch',
        field: 'originalKeptAt',
      });
    }
    if (input.differences && !fitsLanguages(input.differences, tenant)) {
      throw new BadRequestException({
        code: 'language_mismatch',
        field: 'differences',
      });
    }
    // The days, on the client's calendar: approved and in force already,
    // and a next review after the approval and no further away than the
    // longest review period from today. One already past is accepted, and
    // shown overdue: that is where the original stands.
    const effectiveOn = input.effectiveOn ?? input.approvedOn;
    if (input.approvedOn > at.today) {
      throw new BadRequestException({ code: 'approved_in_future' });
    }
    // Approved before Trustline: before the module was first switched on.
    // Anything later goes through the route.
    if (input.approvedOn >= at.window.startedOn) {
      throw new BadRequestException({
        code: 'approved_after_start',
        latestApprovedOn: at.window.latestApprovedOn,
        startedOn: at.window.startedOn,
      });
    }
    if (effectiveOn < input.approvedOn) {
      throw new BadRequestException({ code: 'effective_before_approval' });
    }
    if (effectiveOn > at.today) {
      throw new BadRequestException({ code: 'effective_in_future' });
    }
    // Last reviewed on the original: after its approval, and not ahead of
    // today (quality review 3, M2).
    const lastReviewedOn = input.lastReviewedOn ?? null;
    if (lastReviewedOn && lastReviewedOn < input.approvedOn) {
      throw new BadRequestException({ code: 'reviewed_before_approval' });
    }
    if (lastReviewedOn && lastReviewedOn > at.today) {
      throw new BadRequestException({ code: 'reviewed_in_future' });
    }
    // The next review comes after the later of the two, and no further from
    // it than the longest review period: an old document cannot be given a
    // fresh review date by being imported, which would hide that its review
    // has passed. One already past is accepted, and shown overdue.
    const reviewedFrom = lastReviewedOn ?? input.approvedOn;
    if (input.nextReviewOn <= input.approvedOn) {
      throw new BadRequestException({ code: 'review_before_approval' });
    }
    if (lastReviewedOn && input.nextReviewOn <= lastReviewedOn) {
      throw new BadRequestException({ code: 'review_before_last_review' });
    }
    const latestReview = addMonths(reviewedFrom, at.maxReviewMonths);
    if (input.nextReviewOn > latestReview) {
      throw new BadRequestException({
        code: 'review_date_too_far',
        latest: latestReview,
        maxReviewMonths: at.maxReviewMonths,
        // The day it is counted from: the approval, or the last review.
        from: reviewedFrom,
      });
    }

    const [type] = await tx
      .select({
        id: documentTypes.id,
        numberPrefix: documentTypes.numberPrefix,
        sections: documentTypes.sections,
        defaultReviewMonths: documentTypes.defaultReviewMonths,
      })
      .from(documentTypes)
      .where(and(eq(documentTypes.id, input.typeId), eq(documentTypes.active, true)))
      .for('share');
    if (!type) throw new BadRequestException({ code: 'unknown_type' });
    const reviewMonths = input.reviewMonths ?? type.defaultReviewMonths;
    await assertReviewPeriod(tx, reviewMonths);
    const category = await this.documents.assertCategory(tx, input.categoryId);
    await this.documents.assertOwner(tx, input.ownerId);
    await this.orgUnits.assertActive(tx, [
      input.ownerUnitId,
      ...input.audience.orgUnitIds,
    ]);
    await this.documents.assertRoles(tx, input.audience.roleIds);

    // The text, as every version's: the client's languages, the sections
    // of its type, the small markup, the sizes. Sections may be left
    // without text, required ones too (an original rarely has the type's
    // sections), and are marked as not written; but some of it is in the
    // authoritative language.
    const keys = new Set(type.sections.map((s) => s.key));
    const content: DocumentContent = {};
    for (const [locale, sections] of Object.entries(input.content)) {
      if (!tenant.locales.includes(locale)) {
        throw new BadRequestException({ code: 'language_mismatch', field: 'content' });
      }
      for (const [key, raw] of Object.entries(sections)) {
        const value = checkedSection(locale, key, raw, keys);
        if (value) content[locale] = { ...content[locale], [key]: value };
      }
    }
    if (contentSize(content) > VERSION_MAX_CHARS) {
      throw new BadRequestException({
        code: 'content_too_large',
        max: VERSION_MAX_CHARS,
      });
    }
    const notWritten = type.sections
      .filter((s) => !content[at.authoritative]?.[s.key])
      .map((s) => s.key);
    if (notWritten.length === type.sections.length) {
      throw new BadRequestException({
        code: 'content_required',
        locale: at.authoritative,
      });
    }

    // The number: kept as given when it is free, refused when another
    // document has it (in any capitals, and in Trustline's shape with any
    // zeros before its place); none given, Trustline numbers it.
    const given = input.number ?? null;
    let series: Planned['series'] = null;
    // Letters only of the scripts of the client's languages, and of one of
    // them (security reviews 7 and 9).
    if (given && lettersOutside(given, tenant.locales)) {
      throw new BadRequestException({ code: 'invalid_number', reason: 'script' });
    }
    if (given && mixesScripts(given)) {
      throw new BadRequestException({ code: 'invalid_number', reason: 'mixed_scripts' });
    }
    if (given) {
      const found = seriesOf(given);
      if (found === 'tooLong') {
        throw new BadRequestException({ code: 'invalid_number' });
      }
      series = found;
      const [taken] = await tx
        .select({ number: documents.number })
        .from(documents)
        .where(
          series
            ? sql`(upper(${documents.number}) = upper(${given}) or upper(${documents.number}) ~ ${`^${series.series}-0*${series.n}$`})`
            : sql`upper(${documents.number}) = upper(${given})`,
        )
        .limit(1);
      if (taken) {
        throw new ConflictException({ code: 'number_taken', takenBy: taken.number });
      }
    }
    return {
      index,
      input,
      type,
      category,
      content,
      reviewMonths,
      effectiveOn,
      given,
      series,
      notWritten,
      authoritative: at.authoritative,
    };
  }

  /**
   * Writes one checked document: the document, numbered; its version 1,
   * published with source `imported`; the importer's signature; and the
   * readers asked to acknowledge it if the importer said so. Its
   * `document_imports` row and audit entry follow once the batch has its
   * own row.
   */
  private async write(
    tx: Transaction,
    auth: AuthContext,
    p: Planned,
    now: Date,
    today: string,
  ) {
    const { tenant, user } = auth;
    const input = p.input;
    const number =
      p.given ??
      (await nextDocumentNumber(tx, tenant.id, p.type.numberPrefix, p.category.code));
    const [doc] = await tx
      .insert(documents)
      .values({
        tenantId: tenant.id,
        number,
        typeId: p.type.id,
        categoryId: p.category.id,
        title: input.title,
        ownerId: input.ownerId,
        ownerUnitId: input.ownerUnitId,
        confidentiality: input.confidentiality,
        keywords: input.keywords,
        references: input.references,
        reviewMonths: p.reviewMonths,
        source: 'imported',
        createdBy: user.id,
        createdAt: now,
      })
      .returning({
        id: documents.id,
        number: documents.number,
        ownerId: documents.ownerId,
        ownerUnitId: documents.ownerUnitId,
        confidentiality: documents.confidentiality,
      });
    await this.documents.setAudience(tx, tenant.id, doc.id, input.audience);
    const [version] = await tx
      .insert(documentVersions)
      .values({
        tenantId: tenant.id,
        documentId: doc.id,
        version: 1,
        status: 'published',
        source: 'imported',
        sections: p.type.sections,
        content: p.content,
        preparedBy: user.id,
        preparedAt: now,
        contributors: [user.id],
        effectiveOn: p.effectiveOn,
        publishedAt: now,
        publishedBy: user.id,
        acknowledgementRequired: input.acknowledgementRequired,
        acknowledgeWithinDays: input.acknowledgeWithinDays,
        // Recorded, and signed with the text (security review 7, finding 3).
        authoritativeLocale: p.authoritative,
        signsAuthoritativeLocale: true,
      })
      .returning();
    // In force, with the next review the original gives. Never reviewed
    // in Trustline: its last review is its re-issue, to come.
    await tx
      .update(documents)
      .set({
        status: 'active',
        publishedVersionId: version.id,
        nextReviewOn: input.nextReviewOn,
        lastReviewedOn: null,
        revision: sql`${documents.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(documents.id, doc.id));
    const original: ImportedOriginal = {
      numberAsGiven: p.given,
      revisionLabel: input.revisionLabel ?? null,
      approvedOn: input.approvedOn,
      approvedBy: input.approvedBy,
      originalKeptAt: input.originalKeptAt,
      effectiveOn: p.effectiveOn,
      nextReviewOn: input.nextReviewOn,
      lastReviewedOn: input.lastReviewedOn ?? null,
      differences: input.differences ?? null,
    };
    const signature = await this.signatures.sign(tx, tenant.id, {
      userId: user.id,
      meaning: 'imported',
      subjectType: 'document_version',
      subjectId: version.id,
      content: signedImport(doc, version, original),
    });
    // Its owner is told that its periodic review, and its re-issue, are
    // theirs now (quality review 3, S1): nobody else would tell them.
    await this.notifier.send(
      tx,
      tenant.id,
      { ...doc, status: 'active' },
      user.id,
      [
        {
          kind: 'document_owner_assigned',
          // With the day their confirmation is due (business decision 1).
          data: {
            version: 1,
            versionId: version.id,
            confirmationDueOn: shiftDay(today, IMPORT_CONFIRM_DAYS),
          },
          to: [doc.ownerId],
          about: 'published',
        },
      ],
    );
    let asked = 0;
    if (input.acknowledgementRequired) {
      const dueOn = shiftDay(today, input.acknowledgeWithinDays);
      const added = await this.publisher.assignAcknowledgements(
        tx,
        tenant.id,
        doc.id,
        version.id,
        dueOn,
        now,
      );
      asked = added.length;
      await this.notifier.send(
        tx,
        tenant.id,
        { ...doc, status: 'active' },
        user.id,
        [
          {
            kind: 'document_published',
            data: { version: 1, versionId: version.id, dueOn },
            to: added,
            about: 'published',
          },
        ],
      );
    }
    return {
      planned: p,
      documentId: doc.id,
      versionId: version.id,
      number,
      original,
      signature,
      asked,
    };
  }
}
