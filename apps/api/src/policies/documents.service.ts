import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  sql,
} from 'drizzle-orm';
import {
  ApprovalEngine,
  type Run,
  type RunStep,
  type SubjectContext,
} from '../approvals/approval-engine.service.js';
import { contentHash, SignatureService } from '../approvals/signatures.js';
import type { Transaction } from '../database/client.js';
import {
  documentAcknowledgements,
  documentAudiences,
  documentCategories,
  documentImportBatches,
  documentImports,
  documentReviewApprovals,
  documentReviewRounds,
  documentReviews,
  documents,
  documentTypes,
  documentVersions,
  orgUnits,
  roles,
  users,
  type DocumentContent,
  type DocumentSection,
  signatures as signatureRows,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { AuthService, type AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import { fitsLanguages, sameText, type Localized } from '../i18n/locales.js';
import { addMonths, dayOf, shiftDay } from '../i18n/time-zones.js';
import { OrgUnitsService } from '../organization/org-units.service.js';
import {
  compareVersions,
  contentSize,
  languagesOf,
  missingSections,
  VERSION_MAX_CHARS,
} from './content.js';
import { checkedSection } from './section-input.js';
import { DocumentNotifier } from './document-notifier.js';
import { loadDocument, type LoadedDocument } from './document-access.js';
import {
  assertReviewPeriod,
  authoritativeLocaleOf,
} from './document-settings.js';
import {
  documentAuthoritative,
  languageStatus,
  versionAuthoritative,
} from './languages.js';
import type {
  AudienceInput,
  CreateInput,
  EditVersionInput,
  UpdateInput,
} from './input.js';
import { nextDocumentNumber } from './numbering.js';
import { Publisher } from './publisher.js';
import { signedVersion } from './signed-content.js';
import {
  APPROVE_PERMISSION,
  userInAudience,
  viewerOf,
  type Viewer,
} from './visibility.js';

export type VersionStatus = (typeof documentVersions.status.enumValues)[number];

/** A version that is still being worked on: at most one per document. */
export const IN_PROGRESS: VersionStatus[] = ['draft', 'in_review', 'approved'];

/** How far ahead a review counts as due in the library and the summary. */
export const REVIEW_DUE_DAYS = 30;
/**
 * How long before its due date a periodic review may be confirmed as
 * needing no change (quality review 3): from then on, or once it has
 * passed. Before, the review is not due (409 `review_not_due`).
 */
export const REVIEW_CONFIRM_DAYS = 60;

/**
 * When a document's periodic review may be confirmed as needing no change,
 * by the one rule every place asks (`moves`, `reviewable()`, the answer's
 * `reviewOpensOn`): from REVIEW_CONFIRM_DAYS before its due date. No date,
 * no review to confirm.
 */
export function reviewConfirmation(nextReviewOn: string | null, today: string) {
  if (!nextReviewOn) return { dueOn: null, opensOn: null, open: false };
  const opensOn = shiftDay(nextReviewOn, -REVIEW_CONFIRM_DAYS);
  return { dueOn: nextReviewOn, opensOn, open: today >= opensOn };
}

const versionFields = {
  id: documentVersions.id,
  documentId: documentVersions.documentId,
  version: documentVersions.version,
  status: documentVersions.status,
  sections: documentVersions.sections,
  content: documentVersions.content,
  changeSummary: documentVersions.changeSummary,
  preparedBy: documentVersions.preparedBy,
  preparedAt: documentVersions.preparedAt,
  contributors: documentVersions.contributors,
  effectiveOn: documentVersions.effectiveOn,
  scheduledBy: documentVersions.scheduledBy,
  approvedAt: documentVersions.approvedAt,
  publishedAt: documentVersions.publishedAt,
  publishedBy: documentVersions.publishedBy,
  supersededAt: documentVersions.supersededAt,
  withdrawnAt: documentVersions.withdrawnAt,
  withdrawnBy: documentVersions.withdrawnBy,
  acknowledgementRequired: documentVersions.acknowledgementRequired,
  acknowledgeWithinDays: documentVersions.acknowledgeWithinDays,
  source: documentVersions.source,
  authoritativeLocale: documentVersions.authoritativeLocale,
  signsAuthoritativeLocale: documentVersions.signsAuthoritativeLocale,
  revision: documentVersions.revision,
  createdAt: documentVersions.createdAt,
  updatedAt: documentVersions.updatedAt,
};

type VersionRow = Pick<
  typeof documentVersions.$inferSelect,
  keyof typeof versionFields
>;

/** Whether the review of an active document is due or past, today. */
export function reviewState(
  doc: { status: string; nextReviewOn: string | null },
  today: string,
): 'due' | 'overdue' | null {
  if (doc.status !== 'active' || !doc.nextReviewOn) return null;
  if (doc.nextReviewOn < today) return 'overdue';
  if (doc.nextReviewOn <= shiftDay(today, REVIEW_DUE_DAYS)) return 'due';
  return null;
}

/**
 * Whether two values a document holds are the same: a per-language text is
 * the same whatever order its languages come in (the database keeps its
 * own), a list only in the same order.
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((x, i) => sameValue(x, b[i]))
    );
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) =>
        sameValue(
          (a as Record<string, unknown>)[k],
          (b as Record<string, unknown>)[k],
        ),
      )
    );
  }
  return a === b;
}

/**
 * What stays open in the module while the client's subscription is
 * suspended: acknowledging (safety work about oneself), and publishing an
 * approved version and retiring a document (safety work: a corrected
 * procedure goes out, an unsafe one is withdrawn from readers). Every other
 * write is refused by SessionGuard, so `moves` offers none of them.
 */
const OPEN_WHILE_SUSPENDED = new Set(['publish', 'retire', 'acknowledge']);

const openNow = (auth: AuthContext, moves: string[]) =>
  auth.tenant.subscription.status === 'suspended'
    ? moves.filter((m) => OPEN_WHILE_SUSPENDED.has(m))
    : moves;

/** The fields of a document whose changes its history shows, in order. */
const HISTORY_FIELDS = [
  'title',
  'categoryId',
  'ownerId',
  'ownerUnitId',
  'audience',
  'confidentiality',
  'reviewMonths',
  'nextReviewOn',
  'keywords',
  'references',
] as const;

const refuse = {
  outsideScope: () => new ForbiddenException({ code: 'outside_scope' }),
  staleDocument: () => new ConflictException({ code: 'stale_document' }),
  staleVersion: () => new ConflictException({ code: 'stale_version' }),
  retired: () => new ConflictException({ code: 'document_retired' }),
  // An imported document is re-issued at its review, through the route.
  reissueRequired: () => new ConflictException({ code: 'reissue_required' }),
};

/**
 * Controlled documents and their versions, from the first draft to
 * retirement: who may see and do what (visibility.ts), the approval of each
 * version through the approval engine, publishing, acknowledgement and the
 * periodic review. Every change is audited in its own transaction, and
 * every approval, review sign-off and acknowledgement is a signature,
 * written only after the signer re-entered their password in the same
 * request.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly engine: ApprovalEngine,
    private readonly signatures: SignatureService,
    private readonly auth: AuthService,
    private readonly notifier: DocumentNotifier,
    private readonly publisher: Publisher,
    private readonly orgUnits: OrgUnitsService,
  ) {}

  // Reading.

  get(auth: AuthContext, id: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await this.find(tx, viewer, id);
      return this.detail(tx, auth, viewer, doc);
    });
  }

  /** The document if the viewer may see it; 404 otherwise. */
  private async find(
    tx: Transaction,
    viewer: Viewer,
    id: string,
    lock = false,
  ) {
    const doc = await loadDocument(tx, viewer, this.engine, id, { lock });
    if (!doc) throw new NotFoundException();
    return doc;
  }

  /** As `find`, locked, for a change that only a manager of it may make. */
  private async forManager(tx: Transaction, viewer: Viewer, id: string) {
    const doc = await this.find(tx, viewer, id, true);
    if (!doc.access.manages) throw refuse.outsideScope();
    return doc;
  }

  private async names(tx: Transaction, ids: (string | null)[]) {
    const wanted = [...new Set(ids.filter((id): id is string => !!id))];
    if (wanted.length === 0) return new Map<string, Localized>();
    const found = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, wanted));
    return new Map(found.map((u) => [u.id, u.name]));
  }

  /** One document as this viewer may see it, with what they may do. */
  private async detail(
    tx: Transaction,
    auth: AuthContext,
    viewer: Viewer,
    doc: LoadedDocument,
  ) {
    const { access } = doc;
    const today = dayOf(new Date(), auth.tenant.timeZone);
    const [typeRow] = await tx
      .select({
        id: documentTypes.id,
        code: documentTypes.code,
        name: documentTypes.name,
        noChangeNeedsApproval: documentTypes.noChangeNeedsApproval,
      })
      .from(documentTypes)
      .where(eq(documentTypes.id, doc.typeId));
    const { noChangeNeedsApproval, ...type } = typeRow;
    const [category] = await tx
      .select({
        id: documentCategories.id,
        code: documentCategories.code,
        name: documentCategories.name,
      })
      .from(documentCategories)
      .where(eq(documentCategories.id, doc.categoryId));
    const [ownerUnit] = await tx
      .select({ id: orgUnits.id, name: orgUnits.name })
      .from(orgUnits)
      .where(eq(orgUnits.id, doc.ownerUnitId));
    const people = await this.names(tx, [doc.ownerId, doc.retiredBy]);
    const audience = await this.audienceOf(tx, doc.id);
    const versions = await tx
      .select({
        id: documentVersions.id,
        version: documentVersions.version,
        status: documentVersions.status,
        effectiveOn: documentVersions.effectiveOn,
        publishedAt: documentVersions.publishedAt,
        acknowledgementRequired: documentVersions.acknowledgementRequired,
        source: documentVersions.source,
      })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, doc.id))
      .orderBy(desc(documentVersions.version));
    const published = versions.find((v) => v.id === doc.publishedVersionId);
    // In force as approved before Trustline: its next review is a re-issue
    // through the route, not a confirmation that nothing changed.
    const reissueRequired =
      doc.status === 'active' && published?.source === 'imported';
    const inProgress = versions.find((v) => IN_PROGRESS.includes(v.status));
    const shownInProgress =
      access.full || (inProgress && inProgress.id === access.assignedVersionId)
        ? inProgress
        : undefined;
    const acknowledgement =
      published && access.reads
        ? await this.acknowledgementOf(tx, viewer, doc, published, today)
        : null;
    // A "no change" review awaiting the Approving authority, or the last
    // one decided (business decision 6), and the import's confirmation by
    // its owner (business decision 1).
    const reviewApproval = await this.latestReviewApproval(tx, doc);
    const pendingReview = reviewApproval?.status === 'pending' ? reviewApproval : null;
    const decidesReview =
      !!pendingReview &&
      pendingReview.requestedBy.id !== viewer.userId &&
      (await reviewApproversOf(tx, doc.ownerUnitId, pendingReview.requestedBy.id)).includes(viewer.userId);
    const importConfirmation =
      published?.source === 'imported'
        ? await this.importConfirmationOf(tx, published.id, today)
        : null;
    const moves: string[] = [];
    if (access.manages && doc.status !== 'retired') {
      moves.push('edit');
      if (!inProgress) moves.push('new_version');
      moves.push('retire');
    }
    if (
      (access.manages || access.owner) &&
      doc.status === 'active' &&
      !reissueRequired &&
      !pendingReview &&
      reviewConfirmation(doc.nextReviewOn, today).open
    ) {
      moves.push('confirm_review');
    }
    if (decidesReview && doc.status === 'active') {
      moves.push('approve_review', 'return_review');
    }
    if (
      access.owner &&
      doc.status === 'active' &&
      importConfirmation &&
      importConfirmation.state !== 'confirmed' &&
      (!importConfirmation.dueFrom || importConfirmation.dueFrom.id === viewer.userId) &&
      // Never to the importer, owner or not (security review 11): offered
      // only as `confirmImport` would take it.
      !(await this.importedBy(tx, published!.id, viewer.userId))
    ) {
      moves.push('confirm_import');
    }
    // Who may see the review's comments: its owner, its managers, its
    // approvers.
    const seesReview = access.manages || access.owner || decidesReview || access.full;
    return {
      id: doc.id,
      number: doc.number,
      title: doc.title,
      // The client's day, which screens and prints date things by.
      today,
      type,
      category,
      owner: { id: doc.ownerId, name: people.get(doc.ownerId) ?? null },
      ownerUnit,
      confidentiality: doc.confidentiality,
      audience,
      keywords: doc.keywords,
      references: doc.references,
      reviewMonths: doc.reviewMonths,
      nextReviewOn: doc.nextReviewOn,
      // The day "confirm no change" opens for it, by the same rule as
      // `moves` and the route (null with no review date).
      reviewOpensOn: reviewConfirmation(doc.nextReviewOn, today).opensOn,
      lastReviewedOn: doc.lastReviewedOn,
      review: reviewState(doc, today),
      reissueRequired,
      // Whether its type has a "no change" review signed by the Approving
      // authority as well (business decision 6), and where the last such
      // review stands.
      reviewNeedsApproval: noChangeNeedsApproval,
      reviewApproval: reviewApproval
        ? {
            ...reviewApproval,
            comment: seesReview ? reviewApproval.comment : null,
            decisionComment: seesReview ? reviewApproval.decisionComment : null,
          }
        : null,
      // In force as imported: whether its owner has confirmed it (business
      // decision 1).
      importConfirmation,
      // Its own language that applies, or null for the organization's
      // (business decision 5).
      authoritativeLocale: doc.authoritativeLocale,
      status: doc.status,
      // How it came into Trustline: `written`, or `imported` as approved
      // before Trustline (its first version).
      source: doc.source,
      retiredAt: doc.retiredAt,
      retiredBy:
        access.full && doc.retiredBy
          ? { id: doc.retiredBy, name: people.get(doc.retiredBy) ?? null }
          : null,
      retireReason: access.full ? doc.retireReason : null,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      revision: doc.revision,
      // How much of it the caller sees: everything, the published version
      // as a reader, or one version as an assignee of its review.
      access: access.full
        ? ('full' as const)
        : access.reads
          ? ('reader' as const)
          : ('assignee' as const),
      published: published
        ? {
            id: published.id,
            version: published.version,
            effectiveOn: published.effectiveOn,
            publishedAt: published.publishedAt,
            acknowledgementRequired: published.acknowledgementRequired,
            source: published.source,
            approvedBeforeTrustline: published.source === 'imported',
          }
        : null,
      inProgress: shownInProgress
        ? {
            id: shownInProgress.id,
            version: shownInProgress.version,
            status: shownInProgress.status,
          }
        : null,
      myAcknowledgement: acknowledgement,
      moves: openNow(auth, moves),
    };
  }

  private async audienceOf(tx: Transaction, documentId: string) {
    const rows = await tx
      .select({
        orgUnitId: documentAudiences.orgUnitId,
        roleId: documentAudiences.roleId,
      })
      .from(documentAudiences)
      .where(eq(documentAudiences.documentId, documentId));
    const unitIds = [...new Set(rows.map((r) => r.orgUnitId))];
    const roleIds = [
      ...new Set(rows.map((r) => r.roleId).filter((id) => id !== null)),
    ];
    const units = unitIds.some((id) => id)
      ? await tx
          .select({ id: orgUnits.id, name: orgUnits.name })
          .from(orgUnits)
          .where(
            inArray(
              orgUnits.id,
              unitIds.filter((id) => id !== null),
            ),
          )
          .orderBy(asc(orgUnits.code))
      : [];
    const roleList =
      roleIds.length > 0
        ? await tx
            .select({ id: roles.id, name: roles.name })
            .from(roles)
            .where(inArray(roles.id, roleIds))
            .orderBy(asc(roles.code))
        : [];
    return {
      wholeOrganization: unitIds.includes(null),
      orgUnits: units,
      roles: roleList,
    };
  }

  /**
   * Where the viewer stands with acknowledging the published version: null
   * when it asks nothing of them. Asked when they were assigned it, or when
   * they are in its audience (someone who joined it since the daily check
   * last ran is asked already).
   */
  private async acknowledgementOf(
    tx: Transaction,
    viewer: Viewer,
    doc: LoadedDocument,
    published: { id: string; acknowledgementRequired: boolean },
    today: string,
  ) {
    if (!published.acknowledgementRequired || doc.status !== 'active') {
      return null;
    }
    const [row] = await tx
      .select({
        dueOn: documentAcknowledgements.dueOn,
        acknowledgedAt: documentAcknowledgements.acknowledgedAt,
      })
      .from(documentAcknowledgements)
      .where(
        and(
          eq(documentAcknowledgements.versionId, published.id),
          eq(documentAcknowledgements.userId, viewer.userId),
        ),
      );
    if (!row && !(await this.isMember(tx, viewer.userId, doc.id))) return null;
    return {
      versionId: published.id,
      dueOn: row?.dueOn ?? null,
      acknowledgedAt: row?.acknowledgedAt ?? null,
      overdue: !row?.acknowledgedAt && !!row?.dueOn && row.dueOn < today,
    };
  }

  private async isMember(tx: Transaction, userId: string, documentId: string) {
    const [found] = await tx
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, userId),
          userInAudience(sql`${documentId}::uuid`),
        ),
      );
    return !!found;
  }

  /**
   * The versions of a document the viewer may see, newest first, and its
   * periodic reviews for those with full sight. A reader sees the published
   * version; an assignee that and the one under review.
   */
  history(auth: AuthContext, id: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await this.find(tx, viewer, id);
      const list = await tx
        .select({
          id: documentVersions.id,
          version: documentVersions.version,
          status: documentVersions.status,
          changeSummary: documentVersions.changeSummary,
          preparedAt: documentVersions.preparedAt,
          effectiveOn: documentVersions.effectiveOn,
          publishedAt: documentVersions.publishedAt,
          supersededAt: documentVersions.supersededAt,
          withdrawnAt: documentVersions.withdrawnAt,
          source: documentVersions.source,
        })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id))
        .orderBy(desc(documentVersions.version));
      const versions = list.filter((v) => this.mayReadVersion(doc, v));
      const reviews = doc.access.full
        ? await tx
            .select({
              id: documentReviews.id,
              dueOn: documentReviews.dueOn,
              outcome: documentReviews.outcome,
              comment: documentReviews.comment,
              reviewedBy: documentReviews.reviewedBy,
              reviewedAt: documentReviews.reviewedAt,
              nextReviewOn: documentReviews.nextReviewOn,
              signatureId: documentReviews.signatureId,
            })
            .from(documentReviews)
            .where(eq(documentReviews.documentId, doc.id))
            .orderBy(desc(documentReviews.reviewedAt))
        : [];
      const people = await this.names(
        tx,
        reviews.map((r) => r.reviewedBy),
      );
      return {
        versions,
        reviews: reviews.map(({ reviewedBy, ...r }) => ({
          ...r,
          reviewedBy: { id: reviewedBy, name: people.get(reviewedBy) ?? null },
        })),
      };
    });
  }

  /**
   * The history of a document's own details (title, category, owner,
   * owning unit, audience, confidentiality, review period and the next
   * review date it moved, keywords, references): who changed what, when,
   * from what to what, and why where a reason was given. From the audit
   * log, newest first, a page at a time, with the number of changes in all,
   * and names as they are now. For those with full sight; anyone else who
   * may see the document is refused with 403.
   */
  changes(
    auth: AuthContext,
    id: string,
    paging: { page: number; pageSize: number },
  ) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await this.find(tx, viewer, id);
      if (!doc.access.full) {
        throw new ForbiddenException({
          code: 'missing_permission',
          permission: 'policies.view_all',
        });
      }
      const { items: entries, total } = await this.provisioning.trailOf(
        tx,
        'document',
        doc.id,
        ['document_updated'],
        paging,
      );
      type Audience = {
        orgUnitIds?: string[];
        roleIds?: string[];
        wholeOrganization?: boolean;
      };
      type Change = { from: unknown; to: unknown };
      const fieldsOf = (changes: unknown) =>
        (changes && typeof changes === 'object'
          ? (changes as Record<string, unknown>)
          : {}) as Record<string, Change | string | undefined>;
      // Every id the entries name, to name them.
      const userIds = new Set<string>();
      const unitIds = new Set<string>();
      const categoryIds = new Set<string>();
      const roleIds = new Set<string>();
      const add = (set: Set<string>, value: unknown) => {
        if (typeof value === 'string') set.add(value);
      };
      for (const entry of entries) {
        if (entry.actorId) userIds.add(entry.actorId);
        const fields = fieldsOf(entry.changes);
        for (const side of ['from', 'to'] as const) {
          const of = (field: string) =>
            (fields[field] as Change | undefined)?.[side];
          add(userIds, of('ownerId'));
          add(unitIds, of('ownerUnitId'));
          add(categoryIds, of('categoryId'));
          const audience = of('audience') as Audience | undefined;
          audience?.orgUnitIds?.forEach((u) => add(unitIds, u));
          audience?.roleIds?.forEach((r) => add(roleIds, r));
        }
      }
      const people = await this.names(tx, [...userIds]);
      const named = async <T extends { id: string }>(
        ids: Set<string>,
        load: (list: string[]) => Promise<T[]>,
      ) => new Map((ids.size > 0 ? await load([...ids]) : []).map((r) => [r.id, r]));
      const units = await named(unitIds, (list) =>
        tx
          .select({ id: orgUnits.id, name: orgUnits.name })
          .from(orgUnits)
          .where(inArray(orgUnits.id, list)),
      );
      const categories = await named(categoryIds, (list) =>
        tx
          .select({
            id: documentCategories.id,
            code: documentCategories.code,
            name: documentCategories.name,
          })
          .from(documentCategories)
          .where(inArray(documentCategories.id, list)),
      );
      const roleList = await named(roleIds, (list) =>
        tx
          .select({ id: roles.id, name: roles.name })
          .from(roles)
          .where(inArray(roles.id, list)),
      );
      const value = (field: (typeof HISTORY_FIELDS)[number], v: unknown) => {
        if (v === null || v === undefined) return null;
        switch (field) {
          case 'ownerId':
            return { id: v, name: people.get(v as string) ?? null };
          case 'ownerUnitId':
            return units.get(v as string) ?? { id: v, name: null };
          case 'categoryId':
            return categories.get(v as string) ?? { id: v, code: null, name: null };
          case 'audience': {
            const a = v as Audience;
            const unitList = a.orgUnitIds ?? [];
            return {
              wholeOrganization: a.wholeOrganization ?? unitList.length === 0,
              orgUnits: unitList.map((u) => units.get(u) ?? { id: u, name: null }),
              roles: (a.roleIds ?? []).map((r) => roleList.get(r) ?? { id: r, name: null }),
            };
          }
          default:
            return v;
        }
      };
      const label = {
        title: 'title',
        categoryId: 'category',
        ownerId: 'owner',
        ownerUnitId: 'ownerUnit',
        audience: 'audience',
        confidentiality: 'confidentiality',
        reviewMonths: 'reviewMonths',
        nextReviewOn: 'nextReviewOn',
        keywords: 'keywords',
        references: 'references',
      } as const;
      const items = entries.map((entry) => {
        const fields = fieldsOf(entry.changes);
        const reason = fields.reason;
        return {
          id: entry.id,
          at: entry.occurredAt,
          by: entry.actorId
            ? { id: entry.actorId, name: people.get(entry.actorId) ?? null }
            : null,
          reason: typeof reason === 'string' ? reason : null,
          changes: HISTORY_FIELDS.filter(
            (f) => fields[f] && typeof fields[f] === 'object',
          ).map((f) => {
            const change = fields[f] as Change;
            return {
              field: label[f],
              from: value(f, change.from),
              to: value(f, change.to),
            };
          }),
        };
      });
      return { items, total };
    });
  }

  private mayReadVersion(doc: LoadedDocument, version: { id: string }) {
    return (
      doc.access.full ||
      (version.id === doc.publishedVersionId &&
        (doc.access.reads || !!doc.access.assignedVersionId)) ||
      version.id === doc.access.assignedVersionId
    );
  }

  /** One version as the viewer may see it, or 404. */
  getVersion(auth: AuthContext, id: string, versionId: string) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await this.find(tx, viewer, id);
      const version = await this.versionOf(tx, doc, versionId);
      return this.versionView(tx, auth, viewer, doc, version);
    });
  }

  /** A version of this document the viewer may see; 404 otherwise. */
  private async versionOf(
    tx: Transaction,
    doc: LoadedDocument,
    versionId: string,
    lock = false,
  ) {
    const query = tx
      .select(versionFields)
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.id, versionId),
          eq(documentVersions.documentId, doc.id),
        ),
      );
    const [version] = lock ? await query.for('update') : await query;
    if (!version || !this.mayReadVersion(doc, version)) {
      throw new NotFoundException();
    }
    return version;
  }

  private async versionView(
    tx: Transaction,
    auth: AuthContext,
    viewer: Viewer,
    doc: LoadedDocument,
    version: VersionRow,
  ) {
    const { access } = doc;
    const today = dayOf(new Date(), auth.tenant.timeZone);
    const runs = await this.engine.runsOf(tx, 'document_version', [version.id]);
    const latest = runs[0] ?? null;
    // The run whose signatures stand behind the version: the one that
    // approved it, or, while it is in review, the one in progress.
    const standing =
      runs.find((r) => r.status === 'approved') ??
      runs.find((r) => r.status === 'in_progress') ??
      null;
    const signed = await this.signatures.of(tx, 'document_version', [
      version.id,
    ]);
    const decided = [
      ...new Set(
        runs.flatMap((r) => r.steps.map((s) => s.decidedBy)),
      ),
    ];
    const roleIds = [
      ...new Set(
        runs.flatMap((r) =>
          r.steps.map((s) => s.assigneeRoleId).filter((x) => x !== null),
        ),
      ),
    ];
    const people = await this.names(tx, [
      version.preparedBy,
      version.publishedBy,
      version.scheduledBy,
      ...decided,
      ...runs.flatMap((r) => r.steps.map((s) => s.assigneeUserId)),
    ]);
    const roleNames =
      roleIds.length > 0
        ? new Map(
            (
              await tx
                .select({ id: roles.id, name: roles.name })
                .from(roles)
                .where(inArray(roles.id, roleIds))
            ).map((r) => [r.id, r.name]),
          )
        : new Map<string, Localized>();
    const person = (id: string | null) =>
      id ? { id, name: people.get(id) ?? null } : null;
    const signatureById = new Map(signed.map((s) => [s.id, s]));
    // The control block: who approved it and when, from the signatures of
    // the run that stands behind it. Shown to every reader.
    const approvals = (standing?.steps ?? [])
      .filter((s) => s.status === 'approved' && s.signatureId)
      .map((s) => {
        const signature = signatureById.get(s.signatureId!);
        return {
          position: s.position,
          kind: s.kind,
          meaning: signature?.meaning ?? null,
          signedBy: person(s.decidedBy),
          signedAt: signature?.signedAt ?? s.decidedAt,
          contentHash: signature?.contentHash ?? null,
        };
      });
    // Everything about the runs is for those with full sight, and for the
    // assignees of the version under review.
    const seesRuns = access.full || access.assignedVersionId === version.id;
    const runView = (run: Run) => ({
      id: run.id,
      status: run.status,
      currentPosition: run.currentPosition,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      steps: run.steps.map((s) => ({
        position: s.position,
        kind: s.kind,
        assignee: s.assigneeUserId
          ? { type: 'user' as const, user: person(s.assigneeUserId) }
          : {
              type: 'role' as const,
              role: {
                id: s.assigneeRoleId!,
                name: roleNames.get(s.assigneeRoleId!) ?? null,
              },
            },
        status: s.status,
        dueAt: s.dueAt,
        overdue:
          s.status === 'pending' && !!s.dueAt && s.dueAt.getTime() < Date.now(),
        decidedBy: person(s.decidedBy),
        decidedAt: s.decidedAt,
        comment: s.comment,
      })),
    });
    // What it was returned with, while it is a draft again.
    const returned =
      seesRuns && version.status === 'draft' && latest?.status === 'returned'
        ? latest.steps
            .filter((s) => s.status === 'returned')
            .map((s) => ({
              position: s.position,
              comment: s.comment,
              by: person(s.decidedBy),
              at: s.decidedAt,
            }))
        : [];
    // Compared with the published version, section by section, for a
    // version that is not the published one.
    const base =
      doc.publishedVersionId && doc.publishedVersionId !== version.id
        ? (
            await tx
              .select({ content: documentVersions.content })
              .from(documentVersions)
              .where(eq(documentVersions.id, doc.publishedVersionId))
          )[0]
        : null;
    const comparison =
      version.id === doc.publishedVersionId
        ? null
        : compareVersions(version, base ?? null, auth.tenant.locales);

    // Where each section stands in each language, against the
    // authoritative one and the version published before this one: written,
    // shown in the authoritative language instead, or not updated since it
    // changed there. For every reader of the version.
    const [previous] = await tx
      .select({
        id: documentVersions.id,
        version: documentVersions.version,
        content: documentVersions.content,
      })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, doc.id),
          isNotNull(documentVersions.publishedAt),
          lt(documentVersions.version, version.version),
        ),
      )
      .orderBy(desc(documentVersions.version))
      .limit(1);
    // A draft against the setting as it stands; any other version against
    // the language recorded when it was sent (or imported).
    const authoritative = versionAuthoritative(
      version,
      documentAuthoritative(doc, auth.tenant, await authoritativeLocaleOf(tx, auth.tenant)),
    );
    const languageView = languageStatus(
      version,
      previous ?? null,
      auth.tenant.locales,
      authoritative,
    );

    // Every round of review, and what the version held when it was sent
    // (`snapshot`): earlier rounds and their comments stay visible after it
    // is sent again. And, while it is in progress, what it holds now
    // compared with what it held when it was last returned: whether the
    // comments were dealt with. For those who see its runs.
    const snapshotted = new Set(
      seesRuns
        ? (
            await tx
              .select({ runId: documentReviewRounds.runId })
              .from(documentReviewRounds)
              .where(eq(documentReviewRounds.versionId, version.id))
          ).map((r) => r.runId)
        : [],
    );
    const lastReturned = seesRuns
      ? (runs.find((r) => r.status === 'returned') ?? null)
      : null;
    let sinceReturned = null;
    if (
      lastReturned &&
      snapshotted.has(lastReturned.id) &&
      IN_PROGRESS.includes(version.status)
    ) {
      const [round] = await tx
        .select({
          content: documentReviewRounds.content,
          changeSummary: documentReviewRounds.changeSummary,
        })
        .from(documentReviewRounds)
        .where(
          and(
            eq(documentReviewRounds.runId, lastReturned.id),
            eq(documentReviewRounds.versionId, version.id),
          ),
        );
      sinceReturned = {
        runId: lastReturned.id,
        returnedAt: lastReturned.completedAt,
        changeSummaryChanged: !sameText(round.changeSummary, version.changeSummary),
        comparison: compareVersions(version, round, auth.tenant.locales),
      };
    }

    // What the original of an imported version says of its approval before
    // Trustline, the importer's signature that this is its text, and the
    // sections it came without. For every reader of the version: it is
    // what its control block stands on.
    const original =
      version.source === 'imported'
        ? await this.importedOriginal(tx, version)
        : null;
    // With where its owner's confirmation stands (business decision 1).
    const imported = original
      ? { ...original, confirmation: await this.importConfirmationOf(tx, version.id, today) }
      : null;

    // What the viewer may do with it.
    const pending = latest ? this.engine.pendingStep(latest) : null;
    // The one who prepared the version, or who decided an earlier step of
    // the run, decides no step of it.
    const samePerson =
      version.contributors.includes(viewer.userId) ||
      (!!latest && this.engine.decidersOf(latest).includes(viewer.userId));
    const myStep =
      pending &&
      version.status === 'in_review' &&
      this.engine.isAssignee(viewer.assignment, pending, doc.ownerUnitId)
        ? pending
        : null;
    const moves: string[] = [];
    const live = doc.status !== 'retired';
    if (access.manages && live) {
      if (version.status === 'draft') moves.push('edit', 'submit');
      if (version.status === 'in_review') moves.push('recall');
      if (version.status === 'approved') moves.push('publish');
      if (IN_PROGRESS.includes(version.status)) moves.push('withdraw');
    }
    if (myStep && !samePerson) moves.push('approve', 'return');
    let acknowledgement = null;
    if (version.id === doc.publishedVersionId && access.reads) {
      acknowledgement = await this.acknowledgementOf(
        tx,
        viewer,
        doc,
        version,
        today,
      );
      if (acknowledgement && !acknowledgement.acknowledgedAt) {
        moves.push('acknowledge');
      }
    }
    return {
      id: version.id,
      documentId: doc.id,
      number: doc.number,
      title: doc.title,
      version: version.version,
      status: version.status,
      sections: version.sections,
      content: version.content,
      // The languages it has text in, the authoritative one first; a
      // reader whose language is missing a section is shown the
      // authoritative text there, with a note (`languageStatus`).
      languages: languagesOf(version.content, [
        authoritative,
        ...auth.tenant.locales.filter((l) => l !== authoritative),
      ]),
      languageStatus: languageView,
      // Recorded when it was sent for review or imported, and kept: null
      // on a draft, which follows the client's setting.
      authoritativeLocale:
        version.status === 'draft' ? null : version.authoritativeLocale,
      source: version.source,
      today,
      contentHash: contentHash(signedVersion(doc, version)),
      changeSummary: version.changeSummary,
      preparedBy: person(version.preparedBy),
      preparedAt: version.preparedAt,
      effectiveOn: version.effectiveOn,
      // Approved and waiting for the day it was scheduled for.
      scheduledFor:
        version.status === 'approved' ? version.effectiveOn : null,
      scheduledBy: version.status === 'approved' ? person(version.scheduledBy) : null,
      approvedAt: version.approvedAt,
      publishedAt: version.publishedAt,
      publishedBy: person(version.publishedBy),
      supersededAt: version.supersededAt,
      withdrawnAt: version.withdrawnAt,
      acknowledgementRequired: version.acknowledgementRequired,
      acknowledgeWithinDays: version.acknowledgeWithinDays,
      // The control block, with the document's own.
      control: {
        number: doc.number,
        title: doc.title,
        version: version.version,
        status: version.status,
        documentStatus: doc.status,
        // The published version of an active document, on or after its
        // effective day: the one copy a print may call controlled.
        inForce:
          version.id === doc.publishedVersionId &&
          doc.status === 'active' &&
          !!version.effectiveOn &&
          version.effectiveOn <= today,
        owner: { id: doc.ownerId, name: (await this.names(tx, [doc.ownerId])).get(doc.ownerId) ?? null },
        // An imported version was not prepared in Trustline: whoever
        // imported it is named as such, in `approvedBeforeTrustline`.
        preparedBy: imported ? null : person(version.preparedBy),
        effectiveOn: version.effectiveOn,
        nextReviewOn:
          version.id === doc.publishedVersionId ? doc.nextReviewOn : null,
        // How this version is approved: through Trustline's route, with
        // its signatures in `approvals`; or before Trustline, as the
        // original says, never shown as a Trustline approval (`approvals`
        // is empty).
        approvedThrough: imported
          ? ('before_trustline' as const)
          : ('trustline_route' as const),
        approvals: imported ? [] : approvals,
        approvedBeforeTrustline: imported
          ? {
              numberAsGiven: imported.numberAsGiven,
              revisionLabel: imported.revisionLabel,
              approvedOn: imported.approvedOn,
              approvedBy: imported.approvedBy,
              originalKeptAt: imported.originalKeptAt,
              effectiveOn: imported.effectiveOn,
              nextReviewOn: imported.nextReviewOn,
              // Quality review 3: the original's last review (M2), and
              // where the text differs from it (M3), which the import
              // signature covers.
              lastReviewedOn: imported.lastReviewedOn,
              differences: imported.differences,
              // The sections the original came without, in the version's
              // order: the reader's view and the print say so.
              sectionsNotInOriginal: imported.sectionsNotWritten,
              importedBy: imported.importedBy,
              importedAt: imported.importedAt,
              // Business decision 1: whether its owner has confirmed it.
              ownerConfirmation: imported.confirmation
                ? {
                    state: imported.confirmation.state,
                    dueOn: imported.confirmation.dueOn,
                    confirmedAt: imported.confirmation.confirmedAt,
                    confirmedBy: imported.confirmation.confirmedBy,
                    byImport: imported.confirmation.byImport,
                  }
                : null,
            }
          : null,
        // For the print header: "Version 1 (Rev. 4 on the original)".
        originalRevision: imported?.revisionLabel ?? null,
      },
      imported,
      run: seesRuns && latest ? runView(latest) : null,
      rounds: seesRuns
        ? runs.map((r) => ({ ...runView(r), snapshot: snapshotted.has(r.id) }))
        : [],
      returned,
      comparison,
      sinceReturned,
      myStep: myStep
        ? {
            position: myStep.position,
            kind: myStep.kind,
            dueAt: myStep.dueAt,
            samePerson,
          }
        : null,
      myAcknowledgement: acknowledgement,
      revision: version.revision,
      moves: openNow(auth, moves),
    };
  }

  /**
   * What the import of a version kept of its original, its importer's
   * signature, its batch, and the sections it came without (in the
   * version's own order, with whether each is required).
   */
  private async importedOriginal(tx: Transaction, version: VersionRow) {
    const [row] = await tx
      .select({
        batchId: documentImports.batchId,
        batchIndex: documentImports.batchIndex,
        batchSize: documentImportBatches.size,
        numberAsGiven: documentImports.numberAsGiven,
        revisionLabel: documentImports.revisionLabel,
        approvedOn: documentImports.approvedOn,
        approvedBy: documentImports.approvedBy,
        originalKeptAt: documentImports.originalKeptAt,
        effectiveOn: documentImports.effectiveOn,
        nextReviewOn: documentImports.nextReviewOn,
        lastReviewedOn: documentImports.lastReviewedOn,
        differences: documentImports.differences,
        sectionsNotWritten: documentImports.sectionsNotWritten,
        signatureId: documentImports.signatureId,
        importedBy: documentImports.importedBy,
        importedAt: documentImports.importedAt,
      })
      .from(documentImports)
      .innerJoin(
        documentImportBatches,
        eq(documentImportBatches.id, documentImports.batchId),
      )
      .where(eq(documentImports.versionId, version.id));
    if (!row) return null;
    const [signature] = (
      await this.signatures.of(tx, 'document_version', [version.id])
    ).filter((s) => s.id === row.signatureId);
    const people = await this.names(tx, [row.importedBy]);
    const missing = new Set(row.sectionsNotWritten);
    return {
      batch: { id: row.batchId, index: row.batchIndex, size: row.batchSize },
      numberAsGiven: row.numberAsGiven,
      revisionLabel: row.revisionLabel,
      approvedOn: row.approvedOn,
      approvedBy: row.approvedBy,
      originalKeptAt: row.originalKeptAt,
      effectiveOn: row.effectiveOn,
      nextReviewOn: row.nextReviewOn,
      lastReviewedOn: row.lastReviewedOn,
      differences: row.differences,
      sectionsNotWritten: version.sections
        .filter((s) => missing.has(s.key))
        .map((s) => ({ key: s.key, required: s.required })),
      importedBy: { id: row.importedBy, name: people.get(row.importedBy) ?? null },
      importedAt: row.importedAt,
      signature: signature
        ? {
            id: signature.id,
            meaning: signature.meaning,
            signedBy: {
              id: signature.userId,
              name: people.get(signature.userId) ?? null,
            },
            signedAt: signature.signedAt,
            contentHash: signature.contentHash,
          }
        : null,
    };
  }

  /** A document as `GET /documents/:id` answers it, in the caller's transaction. */
  async detailOf(tx: Transaction, auth: AuthContext, id: string) {
    const viewer = await viewerOf(tx, auth, this.engine);
    return this.detail(tx, auth, viewer, await this.find(tx, viewer, id));
  }

  // Creating and editing documents.

  create(auth: AuthContext, input: CreateInput) {
    const { tenant, user } = auth;
    if (!covers(auth, 'policies.manage', input.ownerUnitId)) {
      throw refuse.outsideScope();
    }
    if (!fitsLanguages(input.title, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const [type] = await tx
        .select({
          id: documentTypes.id,
          numberPrefix: documentTypes.numberPrefix,
          sections: documentTypes.sections,
          defaultReviewMonths: documentTypes.defaultReviewMonths,
        })
        .from(documentTypes)
        .where(
          and(
            eq(documentTypes.id, input.typeId),
            eq(documentTypes.active, true),
          ),
        )
        .for('share');
      if (!type) throw new BadRequestException({ code: 'unknown_type' });
      await assertReviewPeriod(
        tx,
        input.reviewMonths ?? type.defaultReviewMonths,
      );
      const category = await this.assertCategory(tx, input.categoryId);
      await this.assertOwner(tx, input.ownerId);
      await this.orgUnits.assertActive(tx, [
        input.ownerUnitId,
        ...input.audience.orgUnitIds,
      ]);
      await this.assertRoles(tx, input.audience.roleIds);

      const number = await nextDocumentNumber(
        tx,
        tenant.id,
        type.numberPrefix,
        category.code,
      );
      const [doc] = await tx
        .insert(documents)
        .values({
          tenantId: tenant.id,
          number,
          typeId: type.id,
          categoryId: category.id,
          title: input.title,
          ownerId: input.ownerId,
          ownerUnitId: input.ownerUnitId,
          confidentiality: input.confidentiality,
          keywords: input.keywords,
          references: input.references,
          reviewMonths: input.reviewMonths ?? type.defaultReviewMonths,
          createdBy: user.id,
        })
        .returning({ id: documents.id });
      await this.setAudience(tx, tenant.id, doc.id, input.audience);
      const [version] = await tx
        .insert(documentVersions)
        .values({
          tenantId: tenant.id,
          documentId: doc.id,
          version: 1,
          sections: type.sections,
          preparedBy: user.id,
          contributors: [user.id],
          acknowledgementRequired: input.acknowledgementRequired,
          acknowledgeWithinDays: input.acknowledgeWithinDays,
        })
        .returning({ id: documentVersions.id });
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_created',
        'document',
        doc.id,
        {
          number,
          typeId: type.id,
          categoryId: category.id,
          ownerId: input.ownerId,
          ownerUnitId: input.ownerUnitId,
          confidentiality: input.confidentiality,
          audience: input.audience,
          versionId: version.id,
        },
      );
      const viewer = await viewerOf(tx, auth, this.engine);
      return this.detail(tx, auth, viewer, await this.find(tx, viewer, doc.id));
    });
  }

  async assertCategory(tx: Transaction, id: string) {
    const [category] = await tx
      .select({ id: documentCategories.id, code: documentCategories.code })
      .from(documentCategories)
      .where(
        and(
          eq(documentCategories.id, id),
          eq(documentCategories.active, true),
        ),
      )
      .for('share');
    if (!category) throw new BadRequestException({ code: 'unknown_category' });
    return category;
  }

  /** The owner is an active member of the client's staff. */
  async assertOwner(tx: Transaction, id: string) {
    const [owner] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), eq(users.status, 'active')))
      .for('share');
    if (!owner) throw new BadRequestException({ code: 'unknown_owner' });
  }

  async assertRoles(tx: Transaction, ids: string[]) {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return;
    const found = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(inArray(roles.id, wanted))
      .for('share');
    if (found.length !== wanted.length) {
      throw new BadRequestException({ code: 'unknown_role' });
    }
  }

  /** Replaces the audience: each unit (or the whole organization) × role. */
  async setAudience(
    tx: Transaction,
    tenantId: string,
    documentId: string,
    audience: AudienceInput,
  ) {
    await tx
      .delete(documentAudiences)
      .where(eq(documentAudiences.documentId, documentId));
    const units = audience.orgUnitIds.length
      ? [...new Set(audience.orgUnitIds)]
      : [null];
    const roleIds = audience.roleIds.length
      ? [...new Set(audience.roleIds)]
      : [null];
    await tx.insert(documentAudiences).values(
      units.flatMap((orgUnitId) =>
        roleIds.map((roleId) => ({ tenantId, documentId, orgUnitId, roleId })),
      ),
    );
  }

  update(auth: AuthContext, id: string, input: UpdateInput) {
    const { tenant, user } = auth;
    if (input.title && !fitsLanguages(input.title, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await this.forManager(tx, viewer, id);
      if (
        input.ownerUnitId &&
        !covers(auth, 'policies.manage', input.ownerUnitId)
      ) {
        throw refuse.outsideScope();
      }
      if (input.revision !== doc.revision) throw refuse.staleDocument();
      if (doc.status === 'retired') throw refuse.retired();
      if (input.categoryId) await this.assertCategory(tx, input.categoryId);
      if (input.ownerId) await this.assertOwner(tx, input.ownerId);
      await this.orgUnits.assertActive(tx, [
        input.ownerUnitId ?? null,
        ...(input.audience?.orgUnitIds ?? []),
      ]);
      if (input.audience) await this.assertRoles(tx, input.audience.roleIds);
      if (
        input.authoritativeLocale &&
        !tenant.locales.includes(input.authoritativeLocale)
      ) {
        throw new BadRequestException({
          code: 'language_mismatch',
          field: 'authoritativeLocale',
        });
      }

      const set: Partial<typeof documents.$inferInsert> = {};
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const fields = [
        'categoryId',
        'title',
        'ownerId',
        'ownerUnitId',
        'confidentiality',
        'keywords',
        'references',
        'reviewMonths',
        'authoritativeLocale',
      ] as const;
      for (const field of fields) {
        const to = input[field];
        if (to === undefined) continue;
        if (sameValue(to, doc[field])) continue;
        (set as Record<string, unknown>)[field] = to;
        changes[field] = { from: doc[field], to };
      }
      await this.assertMayChange(tx, doc.id, changes);
      // A new review period needs a reason, and stays within the client's
      // maximum: it moves the next review date, and with it the measure of
      // documents past their review.
      if ('reviewMonths' in changes) {
        if (!input.reason) {
          throw new BadRequestException({
            code: 'reason_required',
            field: 'reviewMonths',
          });
        }
        await assertReviewPeriod(tx, input.reviewMonths!);
      }
      if (input.audience) {
        const before = await this.audienceOf(tx, doc.id);
        await this.setAudience(tx, tenant.id, doc.id, input.audience);
        changes.audience = {
          from: {
            orgUnitIds: before.orgUnits.map((u) => u.id),
            wholeOrganization: before.wholeOrganization,
            roleIds: before.roles.map((r) => r.id),
          },
          to: input.audience,
        };
      }
      // A new owner of a document in force as imported, while its owner's
      // confirmation is awaited (security review 11): never the importer,
      // and the confirmation is then due from the new owner, who is told.
      let confirmationTo: { importId: string; dueOn: string | null } | null = null;
      if ('ownerId' in changes && doc.publishedVersionId) {
        const [awaiting] = await tx
          .select({
            id: documentImports.id,
            importedBy: documentImports.importedBy,
            dueOn: documentImports.confirmationDueOn,
            dueFrom: documentImports.confirmationDueFrom,
          })
          .from(documentImports)
          .where(
            and(
              eq(documentImports.versionId, doc.publishedVersionId),
              isNull(documentImports.confirmedAt),
            ),
          )
          .for('update');
        if (awaiting) {
          if (awaiting.importedBy === input.ownerId) {
            throw new ConflictException({ code: 'owner_is_importer', field: 'ownerId' });
          }
          await tx
            .update(documentImports)
            .set({ confirmationDueFrom: input.ownerId })
            .where(eq(documentImports.id, awaiting.id));
          (changes as Record<string, unknown>).confirmationDueFrom = {
            from: awaiting.dueFrom,
            to: input.ownerId,
          };
          confirmationTo = { importId: awaiting.id, dueOn: awaiting.dueOn };
        }
      }
      // A language of its own (business decision 5): as the organization's
      // setting, it changes no version; drafts follow it from now on, and
      // the answer and the audit entry say how many versions are in
      // progress, when the language that stands for it changes.
      let versionsInProgress: Record<string, number> | null = null;
      if ('authoritativeLocale' in changes) {
        const organization = await authoritativeLocaleOf(tx, tenant);
        const from = documentAuthoritative(doc, tenant, organization);
        const to = documentAuthoritative(
          { authoritativeLocale: input.authoritativeLocale ?? null },
          tenant,
          organization,
        );
        if (from !== to) {
          changes.authoritative = { from, to };
          const counts = await tx
            .select({ status: documentVersions.status, count: count() })
            .from(documentVersions)
            .where(
              and(
                eq(documentVersions.documentId, doc.id),
                inArray(documentVersions.status, ['draft', 'in_review', 'approved']),
              ),
            )
            .groupBy(documentVersions.status);
          versionsInProgress = { draft: 0, in_review: 0, approved: 0 };
          for (const row of counts) versionsInProgress[row.status] = row.count;
          (changes as Record<string, unknown>).versionsInProgress = versionsInProgress;
        }
      }
      // A new review period counts from the last review.
      if (set.reviewMonths && doc.status === 'active' && doc.lastReviewedOn) {
        set.nextReviewOn = addMonths(doc.lastReviewedOn, set.reviewMonths);
        set.reviewNoticeRank = null;
        set.reviewNoticeFor = null;
        changes.nextReviewOn = { from: doc.nextReviewOn, to: set.nextReviewOn };
      }
      if (Object.keys(changes).length > 0) {
        await tx
          .update(documents)
          .set({
            ...set,
            revision: sql`${documents.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(documents.id, doc.id));
        // The document's history of changes (`changes()`) reads this.
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'document_updated',
          'document',
          doc.id,
          { ...changes, ...(input.reason && { reason: input.reason }) },
        );
      }
      if (confirmationTo) {
        await this.notifier.send(tx, tenant.id, { ...doc, ownerId: input.ownerId! }, user.id, [
          {
            kind: 'document_owner_assigned',
            data: {
              version: 1,
              versionId: doc.publishedVersionId!,
              confirmationDueOn: confirmationTo.dueOn ?? '',
            },
            to: [input.ownerId!],
            about: 'published',
          },
        ]);
      }
      const after = await viewerOf(tx, auth, this.engine);
      const fresh = await loadDocument(tx, after, this.engine, doc.id);
      // A manager who moved it out of their own reach no longer sees it.
      if (!fresh) return { id: doc.id, moved: true };
      return {
        ...(await this.detail(tx, auth, after, fresh)),
        ...(versionsInProgress && { versionsInProgress }),
      };
    });
  }

  /**
   * What of a document may not change while one of its versions is on its
   * way: the owning unit while a version is in review, since it decides who
   * may decide a step (409 `in_review`); the title while a version is in
   * review or approved and not yet published, since the approvers were
   * shown it (409 `in_review`, or `awaiting_publication`). Each with the
   * `field` and the `version`. The document is locked by the caller, and
   * every change of a version's status takes the same lock.
   */
  private async assertMayChange(
    tx: Transaction,
    documentId: string,
    changes: Record<string, unknown>,
  ) {
    if (!('title' in changes) && !('ownerUnitId' in changes)) return;
    const [open] = await tx
      .select({ version: documentVersions.version, status: documentVersions.status })
      .from(documentVersions)
      .where(
        and(
          eq(documentVersions.documentId, documentId),
          inArray(documentVersions.status, ['in_review', 'approved']),
        ),
      );
    if (!open) return;
    const refused = (field: string, code: string) =>
      new ConflictException({ code, field, version: open.version });
    if (open.status === 'in_review') {
      if ('ownerUnitId' in changes) throw refused('ownerUnitId', 'in_review');
      if ('title' in changes) throw refused('title', 'in_review');
    }
    if (open.status === 'approved' && 'title' in changes) {
      throw refused('title', 'awaiting_publication');
    }
  }

  retire(auth: AuthContext, id: string, input: { reason: string; revision: number }) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await this.forManager(tx, viewer, id);
      if (input.revision !== doc.revision) throw refuse.staleDocument();
      if (doc.status === 'retired') throw refuse.retired();
      const now = new Date();
      // A version still being worked on is withdrawn with it.
      const [open] = await tx
        .select({ id: documentVersions.id, version: documentVersions.version })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.documentId, doc.id),
            inArray(documentVersions.status, IN_PROGRESS),
          ),
        )
        .for('update');
      if (open) await this.withdrawVersion(tx, open.id, user.id, now);
      if (doc.status === 'active') {
        await tx.insert(documentReviews).values({
          tenantId: tenant.id,
          documentId: doc.id,
          dueOn: doc.nextReviewOn,
          outcome: 'retired',
          comment: input.reason,
          reviewedBy: user.id,
          reviewedAt: now,
        });
      }
      await tx
        .update(documents)
        .set({
          status: 'retired',
          retiredAt: now,
          retiredBy: user.id,
          retireReason: input.reason,
          revision: sql`${documents.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(documents.id, doc.id));
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_retired',
        'document',
        doc.id,
        {
          status: { from: doc.status, to: 'retired' },
          reason: input.reason,
          withdrawnVersionId: open?.id ?? null,
        },
      );
      return this.detail(tx, auth, viewer, await this.find(tx, viewer, doc.id));
    });
  }

  /** Withdraws a version in progress, ending its run if it has one. */
  private async withdrawVersion(
    tx: Transaction,
    versionId: string,
    userId: string,
    now: Date,
  ) {
    const run = await this.engine.current(tx, 'document_version', versionId, {
      lock: true,
    });
    if (run) await this.engine.cancel(tx, run, now);
    await tx
      .update(documentVersions)
      .set({
        status: 'withdrawn',
        withdrawnAt: now,
        withdrawnBy: userId,
        effectiveOn: null,
        scheduledBy: null,
        revision: sql`${documentVersions.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(documentVersions.id, versionId));
    return run;
  }

  // Versions.

  /**
   * A new version of a document: the next number, the type's sections as
   * they are now, and the text of the published version (or, for a
   * document never published, of its latest version) for the sections it
   * still has. Text copied from a version that was never published (one
   * withdrawn) is still its writers' text: they stay contributors of the
   * new version, and may decide no step of it. Text copied from the
   * published version went through approval already: whoever starts the
   * new version is its only contributor so far.
   */
  createVersion(auth: AuthContext, id: string) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await this.forManager(tx, viewer, id);
      if (doc.status === 'retired') throw refuse.retired();
      const all = await tx
        .select(versionFields)
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id))
        .orderBy(desc(documentVersions.version));
      if (all.some((v) => IN_PROGRESS.includes(v.status))) {
        throw new ConflictException({ code: 'version_in_progress' });
      }
      const base = all.find((v) => v.id === doc.publishedVersionId) ?? all[0];
      // Text that went through Trustline's approval is nobody's to keep
      // out. Text imported as approved before Trustline was put here by its
      // importer and approved by nobody in Trustline: its re-issue is its
      // first approval here, which its importer decides no step of.
      const kept =
        base && (base.id !== doc.publishedVersionId || base.source === 'imported')
          ? base.contributors
          : [];
      const contributors = [...new Set([...kept, user.id])];
      const [type] = await tx
        .select({ sections: documentTypes.sections })
        .from(documentTypes)
        .where(eq(documentTypes.id, doc.typeId));
      const keys = new Set(type.sections.map((s) => s.key));
      const content: DocumentContent = {};
      for (const [locale, sections] of Object.entries(base?.content ?? {})) {
        const kept = Object.fromEntries(
          Object.entries(sections ?? {}).filter(([key]) => keys.has(key)),
        );
        if (Object.keys(kept).length > 0) content[locale] = kept;
      }
      const [{ last }] = await tx
        .select({ last: max(documentVersions.version) })
        .from(documentVersions)
        .where(eq(documentVersions.documentId, doc.id));
      const [created] = await tx
        .insert(documentVersions)
        .values({
          tenantId: tenant.id,
          documentId: doc.id,
          version: (last ?? 0) + 1,
          sections: type.sections,
          content,
          preparedBy: user.id,
          contributors,
          acknowledgementRequired: base?.acknowledgementRequired ?? false,
          acknowledgeWithinDays: base?.acknowledgeWithinDays ?? 14,
        })
        .returning(versionFields);
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_version_created',
        'document',
        doc.id,
        {
          versionId: created.id,
          version: created.version,
          copiedFromVersionId: base?.id ?? null,
          contributors,
        },
      );
      const fresh = await this.find(tx, viewer, doc.id);
      return this.versionView(tx, auth, viewer, fresh, created);
    });
  }

  /** Locks a document a manager is changing, and its version. */
  private async managedVersion(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    versionId: string,
    revision: number,
  ) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const doc = await this.forManager(tx, viewer, id);
    const version = await this.versionOf(tx, doc, versionId, true);
    if (version.revision !== revision) throw refuse.staleVersion();
    if (doc.status === 'retired') throw refuse.retired();
    return { viewer, doc, version };
  }

  editVersion(
    auth: AuthContext,
    id: string,
    versionId: string,
    input: EditVersionInput,
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, version } = await this.managedVersion(
        tx,
        auth,
        id,
        versionId,
        input.revision,
      );
      if (version.status !== 'draft') {
        throw new ConflictException({ code: 'not_draft' });
      }
      const content = structuredClone(version.content);
      const edited: string[] = [];
      const keys = new Set(version.sections.map((s: DocumentSection) => s.key));
      for (const [locale, sections] of Object.entries(input.content ?? {})) {
        if (!tenant.locales.includes(locale)) {
          throw new BadRequestException({ code: 'language_mismatch' });
        }
        for (const [key, raw] of Object.entries(sections)) {
          const value = checkedSection(locale, key, raw, keys);
          const before = content[locale]?.[key] ?? '';
          if (before === value) continue;
          edited.push(`${locale}.${key}`);
          const into = { ...content[locale] };
          if (value) into[key] = value;
          else delete into[key];
          if (Object.keys(into).length > 0) content[locale] = into;
          else delete content[locale];
        }
      }
      if (contentSize(content) > VERSION_MAX_CHARS) {
        throw new BadRequestException({
          code: 'content_too_large',
          max: VERSION_MAX_CHARS,
        });
      }
      if (
        input.changeSummary &&
        !fitsLanguages(input.changeSummary, tenant, { required: false })
      ) {
        throw new BadRequestException({ code: 'language_mismatch' });
      }
      const set: Partial<typeof documentVersions.$inferInsert> = {};
      const changes: Record<string, unknown> = {};
      if (edited.length > 0) {
        set.content = content;
        changes.sections = edited;
      }
      if (
        input.changeSummary !== undefined &&
        JSON.stringify(input.changeSummary) !==
          JSON.stringify(version.changeSummary)
      ) {
        set.changeSummary = input.changeSummary;
        changes.changeSummary = {
          from: version.changeSummary,
          to: input.changeSummary,
        };
      }
      for (const field of [
        'acknowledgementRequired',
        'acknowledgeWithinDays',
      ] as const) {
        const to = input[field];
        if (to !== undefined && to !== version[field]) {
          (set as Record<string, unknown>)[field] = to;
          changes[field] = { from: version[field], to };
        }
      }
      let saved = version;
      if (Object.keys(changes).length > 0) {
        [saved] = await tx
          .update(documentVersions)
          .set({
            ...set,
            contributors: [...new Set([...version.contributors, user.id])],
            revision: sql`${documentVersions.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(documentVersions.id, version.id))
          .returning(versionFields);
        // What changed, not the text: the version keeps that, and its hash
        // says what it was.
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'document_version_edited',
          'document',
          doc.id,
          {
            versionId: version.id,
            version: version.version,
            ...changes,
            contentHash: contentHash(signedVersion(doc, saved)),
          },
        );
      }
      return this.versionView(tx, auth, viewer, doc, saved);
    });
  }

  /**
   * Sends a draft for review: every required section written in the
   * client's authoritative language, a change summary in it from version
   * 2, and an
   * approval route for its type whose every step someone other than those
   * who prepared it could decide. The first step's assignees are told.
   */
  submit(auth: AuthContext, id: string, versionId: string, revision: number) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, version } = await this.managedVersion(
        tx,
        auth,
        id,
        versionId,
        revision,
      );
      if (version.status !== 'draft') {
        throw new ConflictException({ code: 'not_draft' });
      }
      // The document's own language, or the organization's (decision 5).
      const authoritative = documentAuthoritative(
        doc,
        tenant,
        await authoritativeLocaleOf(tx, tenant),
      );
      const missing = missingSections(
        version.sections,
        version.content,
        authoritative,
      );
      if (missing.length > 0) {
        throw new BadRequestException({
          code: 'missing_sections',
          locale: authoritative,
          sections: missing,
        });
      }
      if (
        version.version >= 2 &&
        !version.changeSummary?.[authoritative as 'en']
      ) {
        throw new BadRequestException({ code: 'change_summary_required' });
      }
      const route = await this.engine.routeFor(tx, 'document', doc.typeId);
      if (!route) throw new ConflictException({ code: 'no_route' });
      const contributors = [...new Set([...version.contributors, user.id])];
      const now = new Date();
      const { run, assignees } = await this.engine.start(tx, tenant.id, {
        routeId: route.id,
        subjectType: 'document_version',
        subjectId: version.id,
        startedBy: user.id,
        ctx: this.contextOf(doc),
        excluded: contributors,
        now,
        timeZone: tenant.timeZone,
      });
      const [saved] = await tx
        .update(documentVersions)
        .set({
          status: 'in_review',
          contributors,
          // The language it was checked against, kept with it from now on
          // and signed with its text (security review 7, finding 3).
          authoritativeLocale: authoritative,
          signsAuthoritativeLocale: true,
          revision: sql`${documentVersions.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(documentVersions.id, version.id))
        .returning(versionFields);
      // What its reviewers read in this round, kept: the database keeps a
      // version in review from changing, so this is what a return answers.
      await tx.insert(documentReviewRounds).values({
        tenantId: tenant.id,
        versionId: version.id,
        runId: run.id,
        sections: version.sections,
        content: version.content,
        changeSummary: version.changeSummary,
      });
      const first = run.steps[0];
      await this.notifier.send(tx, tenant.id, doc, user.id, [
        {
          kind: 'document_step_assigned',
          data: {
            version: version.version,
            versionId: version.id,
            position: first.position,
            step: first.kind,
          },
          to: assignees,
          about: 'in_progress',
          assignees,
        },
      ]);
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_submitted',
        'document',
        doc.id,
        {
          versionId: version.id,
          version: version.version,
          status: { from: 'draft', to: 'in_review' },
          runId: run.id,
          routeId: route.id,
          contentHash: contentHash(signedVersion(doc, saved)),
        },
      );
      return this.versionView(tx, auth, viewer, doc, saved);
    });
  }

  private contextOf(doc: { ownerUnitId: string }): SubjectContext {
    return { unitId: doc.ownerUnitId, permission: APPROVE_PERMISSION };
  }

  /**
   * The step the viewer is to decide on a version in review, refused in the
   * order a person would want to be told: not something they may see (404),
   * not in review (409 `not_in_review`), out of date (409 `stale_version`),
   * not theirs (403 `not_assignee`, or 409 `not_current_step` when theirs
   * comes later), or theirs but they prepared the version or decided an
   * earlier step of this run (403 `same_person`, with `reason` `prepared`
   * or `decided_earlier_step`): each step is decided by a different
   * person, none of whom wrote it.
   */
  private async decision(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    versionId: string,
    revision: number,
    lock: boolean,
  ) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const doc = await this.find(tx, viewer, id, lock);
    const version = await this.versionOf(tx, doc, versionId, lock);
    if (version.status !== 'in_review') {
      throw new ConflictException({ code: 'not_in_review' });
    }
    if (version.revision !== revision) throw refuse.staleVersion();
    const run = await this.engine.current(tx, 'document_version', version.id, {
      lock,
    });
    const step = run ? this.engine.pendingStep(run) : null;
    if (!run || !step) throw new ConflictException({ code: 'not_in_review' });
    const mine = (s: RunStep) =>
      this.engine.isAssignee(viewer.assignment, s, doc.ownerUnitId);
    if (!mine(step)) {
      if (run.steps.some((s) => s.status === 'waiting' && mine(s))) {
        throw new ConflictException({ code: 'not_current_step' });
      }
      throw new ForbiddenException({ code: 'not_assignee' });
    }
    if (version.contributors.includes(auth.user.id)) {
      throw new ForbiddenException({ code: 'same_person', reason: 'prepared' });
    }
    if (this.engine.decidersOf(run).includes(auth.user.id)) {
      throw new ForbiddenException({
        code: 'same_person',
        reason: 'decided_earlier_step',
      });
    }
    return { viewer, doc, version, run, step };
  }

  /**
   * Approves the current step with the approver's signature. Everything is
   * checked before the password, so that a refusal for another reason
   * neither asks for it nor counts it, and again, under the lock, after.
   */
  async approve(
    auth: AuthContext,
    id: string,
    versionId: string,
    input: { password: string; comment: string | null; revision: number },
    ip: string | null,
  ) {
    const { tenant, user } = auth;
    await this.tenantDb.withTenant(tenant.id, (tx) =>
      this.decision(tx, auth, id, versionId, input.revision, false),
    );
    await this.auth.confirmPassword(auth, input.password, 'approval', ip);
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, version, run, step } = await this.decision(
        tx,
        auth,
        id,
        versionId,
        input.revision,
        true,
      );
      const now = new Date();
      const signature = await this.signatures.sign(tx, tenant.id, {
        userId: user.id,
        meaning: step.kind === 'review' ? 'reviewed' : 'approved',
        subjectType: 'document_version',
        subjectId: version.id,
        content: signedVersion(doc, version),
      });
      const outcome = await this.engine.decide(tx, run, {
        userId: user.id,
        outcome: 'approved',
        comment: input.comment,
        signatureId: signature.id,
        ctx: this.contextOf(doc),
        excluded: version.contributors,
        now,
        timeZone: tenant.timeZone,
      });
      const approved = outcome.status === 'approved';
      const [saved] = await tx
        .update(documentVersions)
        .set({
          ...(approved && { status: 'approved' as const, approvedAt: now }),
          revision: sql`${documentVersions.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(documentVersions.id, version.id))
        .returning(versionFields);
      if (approved) {
        const holders = await this.managersOf(tx, doc.ownerUnitId);
        await this.notifier.send(tx, tenant.id, doc, user.id, [
          {
            kind: 'document_approved',
            data: { version: version.version, versionId: version.id },
            to: [version.preparedBy, ...version.contributors, ...holders],
            about: 'in_progress',
          },
        ]);
      } else if (outcome.next) {
        await this.notifier.send(tx, tenant.id, doc, user.id, [
          {
            kind: 'document_step_assigned',
            data: {
              version: version.version,
              versionId: version.id,
              position: outcome.next.position,
              step: outcome.next.kind,
            },
            to: outcome.nextAssignees,
            about: 'in_progress',
            assignees: outcome.nextAssignees,
          },
        ]);
      }
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_step_approved',
        'document',
        doc.id,
        {
          versionId: version.id,
          version: version.version,
          runId: run.id,
          position: step.position,
          kind: step.kind,
          signatureId: signature.id,
          contentHash: signature.contentHash,
          comment: input.comment,
          ...(approved && { status: { from: 'in_review', to: 'approved' } }),
        },
      );
      return this.versionView(tx, auth, viewer, doc, saved);
    });
  }

  /** The active people who manage documents of this unit. */
  private async managersOf(tx: Transaction, unitId: string) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      with recursive up (id, parent_id) as (
        select o.id, o.parent_id from ${orgUnits} o where o.id = ${unitId}
        union
        select o.id, o.parent_id from ${orgUnits} o join up on o.id = up.parent_id
      )
      select distinct ra.user_id as id
      from role_assignments ra
      join roles r on r.id = ra.role_id
      join users u on u.id = ra.user_id and u.status = 'active'
      where 'policies.manage' = any(r.permissions)
        and (ra.org_unit_id is null or ra.org_unit_id in (select id from up))`);
    return rows.map((r) => r.id);
  }

  /**
   * Returns the version to draft from the current step, with a comment.
   * Not a signature: nothing is approved. The run ends; the comment is
   * shown on the draft.
   */
  returnVersion(
    auth: AuthContext,
    id: string,
    versionId: string,
    input: { comment: string; revision: number },
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, version, run, step } = await this.decision(
        tx,
        auth,
        id,
        versionId,
        input.revision,
        true,
      );
      const now = new Date();
      await this.engine.decide(tx, run, {
        userId: user.id,
        outcome: 'returned',
        comment: input.comment,
        signatureId: null,
        ctx: this.contextOf(doc),
        excluded: version.contributors,
        now,
        timeZone: tenant.timeZone,
      });
      const [saved] = await tx
        .update(documentVersions)
        .set({
          status: 'draft',
          revision: sql`${documentVersions.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(documentVersions.id, version.id))
        .returning(versionFields);
      await this.notifier.send(tx, tenant.id, doc, user.id, [
        {
          kind: 'document_returned',
          data: {
            version: version.version,
            versionId: version.id,
            position: step.position,
          },
          to: [version.preparedBy, ...version.contributors],
          about: 'in_progress',
        },
      ]);
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_returned',
        'document',
        doc.id,
        {
          versionId: version.id,
          version: version.version,
          runId: run.id,
          position: step.position,
          kind: step.kind,
          status: { from: 'in_review', to: 'draft' },
          comment: input.comment,
        },
      );
      const fresh = await this.find(tx, viewer, doc.id);
      return this.versionView(tx, auth, viewer, fresh, saved);
    });
  }

  /** Takes a version out of review, back to draft, ending its run. */
  recall(auth: AuthContext, id: string, versionId: string, revision: number) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, version } = await this.managedVersion(
        tx,
        auth,
        id,
        versionId,
        revision,
      );
      if (version.status !== 'in_review') {
        throw new ConflictException({ code: 'not_in_review' });
      }
      const now = new Date();
      const run = await this.engine.current(
        tx,
        'document_version',
        version.id,
        { lock: true },
      );
      if (run) await this.engine.cancel(tx, run, now);
      const [saved] = await tx
        .update(documentVersions)
        .set({
          status: 'draft',
          revision: sql`${documentVersions.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(documentVersions.id, version.id))
        .returning(versionFields);
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_recalled',
        'document',
        doc.id,
        {
          versionId: version.id,
          version: version.version,
          runId: run?.id ?? null,
          status: { from: 'in_review', to: 'draft' },
        },
      );
      return this.versionView(tx, auth, viewer, doc, saved);
    });
  }

  withdraw(
    auth: AuthContext,
    id: string,
    versionId: string,
    input: { reason: string; revision: number },
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, version } = await this.managedVersion(
        tx,
        auth,
        id,
        versionId,
        input.revision,
      );
      if (!IN_PROGRESS.includes(version.status)) {
        throw new ConflictException({ code: 'not_in_progress' });
      }
      const now = new Date();
      const run = await this.withdrawVersion(tx, version.id, user.id, now);
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_version_withdrawn',
        'document',
        doc.id,
        {
          versionId: version.id,
          version: version.version,
          status: { from: version.status, to: 'withdrawn' },
          runId: run?.id ?? null,
          reason: input.reason,
        },
      );
      const fresh = await this.find(tx, viewer, doc.id);
      return this.versionView(
        tx,
        auth,
        viewer,
        fresh,
        await this.versionOf(tx, fresh, version.id),
      );
    });
  }

  /**
   * Publishes an approved version now, or schedules it for a later day on
   * the client's calendar (the daily check publishes it that day). Refused
   * if what was approved is not what the version holds now (409
   * `content_changed`), which no route allows but which is checked anyway:
   * a signature must stand behind what is published.
   */
  publish(
    auth: AuthContext,
    id: string,
    versionId: string,
    input: { effectiveOn?: string; revision: number },
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, version } = await this.managedVersion(
        tx,
        auth,
        id,
        versionId,
        input.revision,
      );
      if (version.status !== 'approved') {
        throw new ConflictException({ code: 'not_approved' });
      }
      await this.assertSigned(tx, doc, version);
      const now = new Date();
      const today = dayOf(now, tenant.timeZone);
      const day = input.effectiveOn ?? today;
      if (day < today) {
        throw new BadRequestException({ code: 'effective_in_past' });
      }
      if (day > today) {
        await tx
          .update(documentVersions)
          .set({
            effectiveOn: day,
            scheduledBy: user.id,
            revision: sql`${documentVersions.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(documentVersions.id, version.id));
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'document_publish_scheduled',
          'document',
          doc.id,
          {
            versionId: version.id,
            version: version.version,
            effectiveOn: { from: version.effectiveOn, to: day },
          },
        );
      } else {
        await this.publisher.publish(tx, tenant.id, doc, version, {
          actorId: user.id,
          effectiveOn: today,
          today,
          now,
        });
      }
      const fresh = await this.find(tx, viewer, doc.id);
      return this.versionView(
        tx,
        auth,
        viewer,
        fresh,
        await this.versionOf(tx, fresh, version.id),
      );
    });
  }

  /**
   * Every approval of the run that approved the version signed what it
   * holds now (`Publisher.isSigned`); 409 `content_changed` otherwise.
   */
  async assertSigned(
    tx: Transaction,
    doc: { id: string; number: string },
    version: VersionRow,
  ) {
    if (!(await this.publisher.isSigned(tx, doc, version))) {
      throw new ConflictException({ code: 'content_changed' });
    }
  }

  // Acknowledgement and periodic review.

  /**
   * What an acknowledgement needs, checked before the password and again
   * after it, under the lock: the published version of an active document,
   * which asks for acknowledgement, of someone it was assigned to or who is
   * in its audience, and who has not acknowledged it yet.
   */
  private async acknowledgeable(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    versionId: string,
    lock: boolean,
  ) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const doc = await this.find(tx, viewer, id, lock);
    const version = await this.versionOf(tx, doc, versionId);
    if (!doc.access.reads) throw new NotFoundException();
    if (version.id !== doc.publishedVersionId || doc.status !== 'active') {
      throw refuse.staleVersion();
    }
    if (!version.acknowledgementRequired) {
      throw new ConflictException({ code: 'acknowledgement_not_required' });
    }
    const query = tx
      .select({
        id: documentAcknowledgements.id,
        acknowledgedAt: documentAcknowledgements.acknowledgedAt,
      })
      .from(documentAcknowledgements)
      .where(
        and(
          eq(documentAcknowledgements.versionId, version.id),
          eq(documentAcknowledgements.userId, auth.user.id),
        ),
      );
    const [row] = lock ? await query.for('update') : await query;
    if (row?.acknowledgedAt) {
      throw new ConflictException({ code: 'already_acknowledged' });
    }
    if (!row && !(await this.isMember(tx, auth.user.id, doc.id))) {
      throw new ForbiddenException({ code: 'not_in_audience' });
    }
    return { doc, version, row: row ?? null };
  }

  async acknowledge(
    auth: AuthContext,
    id: string,
    versionId: string,
    password: string,
    ip: string | null,
  ) {
    const { tenant, user } = auth;
    await this.tenantDb.withTenant(tenant.id, (tx) =>
      this.acknowledgeable(tx, auth, id, versionId, false),
    );
    await this.auth.confirmPassword(auth, password, 'acknowledgement', ip);
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { doc, version, row } = await this.acknowledgeable(
        tx,
        auth,
        id,
        versionId,
        true,
      );
      const now = new Date();
      const signature = await this.signatures.sign(tx, tenant.id, {
        userId: user.id,
        meaning: 'acknowledged',
        subjectType: 'document_version',
        subjectId: version.id,
        content: signedVersion(doc, version),
      });
      const today = dayOf(now, tenant.timeZone);
      if (row) {
        await tx
          .update(documentAcknowledgements)
          .set({ acknowledgedAt: now, signatureId: signature.id })
          .where(
            and(
              eq(documentAcknowledgements.id, row.id),
              isNull(documentAcknowledgements.acknowledgedAt),
            ),
          );
      } else {
        await tx.insert(documentAcknowledgements).values({
          tenantId: tenant.id,
          versionId: version.id,
          userId: user.id,
          assignedAt: now,
          dueOn: shiftDay(today, version.acknowledgeWithinDays),
          acknowledgedAt: now,
          signatureId: signature.id,
        });
      }
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_acknowledged',
        'document',
        doc.id,
        {
          versionId: version.id,
          version: version.version,
          signatureId: signature.id,
          contentHash: signature.contentHash,
        },
      );
      return {
        versionId: version.id,
        acknowledgedAt: now,
        signature: {
          id: signature.id,
          meaning: signature.meaning,
          signedAt: signature.signedAt,
          contentHash: signature.contentHash,
        },
      };
    });
  }

  private async reviewable(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    revision: number,
    lock: boolean,
  ) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const doc = await this.find(tx, viewer, id, lock);
    if (!doc.access.manages && !doc.access.owner) {
      throw refuse.outsideScope();
    }
    if (doc.revision !== revision) throw refuse.staleDocument();
    if (doc.status !== 'active') {
      throw new ConflictException({ code: 'not_active' });
    }
    const [published] = await tx
      .select({ source: documentVersions.source })
      .from(documentVersions)
      .where(eq(documentVersions.id, doc.publishedVersionId!));
    if (published?.source === 'imported') throw refuse.reissueRequired();
    // Only within REVIEW_CONFIRM_DAYS of its due date, or after it: a
    // review confirmed the day after publishing would move the next one on
    // with nobody having looked.
    // With no review date there is no review to confirm, as `moves` says
    // (security review of quality 3, N3).
    const confirmation = reviewConfirmation(
      doc.nextReviewOn,
      dayOf(new Date(), auth.tenant.timeZone),
    );
    if (!confirmation.open) {
      throw new ConflictException({
        code: 'review_not_due',
        dueOn: confirmation.dueOn,
        opensOn: confirmation.opensOn,
      });
    }
    // One awaiting the Approving authority at a time (business decision 6).
    const [pending] = await tx
      .select({ id: documentReviewApprovals.id })
      .from(documentReviewApprovals)
      .where(
        and(
          eq(documentReviewApprovals.documentId, doc.id),
          eq(documentReviewApprovals.status, 'pending'),
        ),
      );
    if (pending) throw new ConflictException({ code: 'review_pending' });
    const [type] = await tx
      .select({ noChangeNeedsApproval: documentTypes.noChangeNeedsApproval })
      .from(documentTypes)
      .where(eq(documentTypes.id, doc.typeId));
    const approvers = type.noChangeNeedsApproval
      ? await reviewApproversOf(tx, doc.ownerUnitId, viewer.userId)
      : [];
    if (type.noChangeNeedsApproval && approvers.length === 0) {
      throw new ConflictException({ code: 'no_review_approver' });
    }
    return { viewer, doc, needsApproval: type.noChangeNeedsApproval, approvers };
  }

  /**
   * The owner, or a manager of the document, confirms at its periodic
   * review that it needs no change: a signature of the published version as
   * it is, a `document_reviews` row, and the next review date moved on by
   * the review period from today.
   */
  async confirmReview(
    auth: AuthContext,
    id: string,
    input: { password: string; comment: string; revision: number },
    ip: string | null,
  ) {
    const { tenant, user } = auth;
    await this.tenantDb.withTenant(tenant.id, (tx) =>
      this.reviewable(tx, auth, id, input.revision, false),
    );
    await this.auth.confirmPassword(auth, input.password, 'review', ip);
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, needsApproval, approvers } = await this.reviewable(
        tx,
        auth,
        id,
        input.revision,
        true,
      );
      const now = new Date();
      const today = dayOf(now, tenant.timeZone);
      const [published] = await tx
        .select(versionFields)
        .from(documentVersions)
        .where(eq(documentVersions.id, doc.publishedVersionId!));
      const nextReviewOn = addMonths(today, doc.reviewMonths);
      const signature = await this.signatures.sign(tx, tenant.id, {
        userId: user.id,
        meaning: 'reviewed_no_change',
        subjectType: 'document',
        subjectId: doc.id,
        content: {
          documentId: doc.id,
          number: doc.number,
          publishedVersionId: published.id,
          versionHash: contentHash(signedVersion(doc, published)),
          dueOn: doc.nextReviewOn,
          reviewedOn: today,
          // Where the Approving authority signs too, the next review is
          // set when they do (business decision 6).
          nextReviewOn: needsApproval ? null : nextReviewOn,
          ...(needsApproval && { awaitsApproval: true }),
          comment: input.comment,
        },
      });
      if (needsApproval) {
        await tx.insert(documentReviewApprovals).values({
          tenantId: tenant.id,
          documentId: doc.id,
          dueOn: doc.nextReviewOn,
          comment: input.comment,
          requestedBy: user.id,
          requestedAt: now,
          requestSignatureId: signature.id,
        });
        await tx
          .update(documents)
          .set({ revision: sql`${documents.revision} + 1`, updatedAt: now })
          .where(eq(documents.id, doc.id));
        await this.notifier.send(tx, tenant.id, doc, user.id, [
          {
            kind: 'review_approval_requested',
            data: { dueOn: doc.nextReviewOn ?? '' },
            to: approvers,
            about: 'published',
          },
        ]);
        await this.provisioning.audit(tx, tenant.id, user.id, 'document_review_requested', 'document', doc.id, {
          outcome: 'no_change',
          dueOn: doc.nextReviewOn,
          approvers,
          signatureId: signature.id,
          contentHash: signature.contentHash,
          comment: input.comment,
        });
        return this.detail(tx, auth, viewer, await this.find(tx, viewer, doc.id));
      }
      await tx.insert(documentReviews).values({
        tenantId: tenant.id,
        documentId: doc.id,
        dueOn: doc.nextReviewOn,
        outcome: 'no_change',
        comment: input.comment,
        reviewedBy: user.id,
        reviewedAt: now,
        signatureId: signature.id,
        nextReviewOn,
      });
      await tx
        .update(documents)
        .set({
          nextReviewOn,
          lastReviewedOn: today,
          reviewNoticeRank: null,
          reviewNoticeFor: null,
          revision: sql`${documents.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(documents.id, doc.id));
      await this.provisioning.audit(
        tx,
        tenant.id,
        user.id,
        'document_reviewed',
        'document',
        doc.id,
        {
          outcome: 'no_change',
          nextReviewOn: { from: doc.nextReviewOn, to: nextReviewOn },
          signatureId: signature.id,
          contentHash: signature.contentHash,
          comment: input.comment,
        },
      );
      return this.detail(tx, auth, viewer, await this.find(tx, viewer, doc.id));
    });
  }

  /** The latest "no change" review sent for approval, with names. */
  private async latestReviewApproval(tx: Transaction, doc: { id: string }) {
    const [row] = await tx
      .select({
        id: documentReviewApprovals.id,
        status: documentReviewApprovals.status,
        dueOn: documentReviewApprovals.dueOn,
        comment: documentReviewApprovals.comment,
        requestedBy: documentReviewApprovals.requestedBy,
        requestedAt: documentReviewApprovals.requestedAt,
        decidedBy: documentReviewApprovals.decidedBy,
        decidedAt: documentReviewApprovals.decidedAt,
        decisionComment: documentReviewApprovals.decisionComment,
      })
      .from(documentReviewApprovals)
      .where(eq(documentReviewApprovals.documentId, doc.id))
      .orderBy(desc(documentReviewApprovals.requestedAt))
      .limit(1);
    if (!row) return null;
    const people = await this.names(tx, [row.requestedBy, row.decidedBy]);
    return {
      ...row,
      requestedBy: { id: row.requestedBy, name: people.get(row.requestedBy) ?? null },
      decidedBy: row.decidedBy
        ? { id: row.decidedBy, name: people.get(row.decidedBy) ?? null }
        : null,
    };
  }

  /**
   * Where the owner's confirmation of an imported version stands (business
   * decision 1): `confirmed` (by their signature, or by the import itself
   * when they imported it), `awaiting` until its day, `overdue` after.
   */
  /** Whether this person imported this version. */
  private async importedBy(tx: Transaction, versionId: string, userId: string) {
    const [row] = await tx
      .select({ id: documentImports.id })
      .from(documentImports)
      .where(and(eq(documentImports.versionId, versionId), eq(documentImports.importedBy, userId)));
    return !!row;
  }

  async importConfirmationOf(tx: Transaction, versionId: string, today: string) {
    const [row] = await tx
      .select({
        dueOn: documentImports.confirmationDueOn,
        dueFrom: documentImports.confirmationDueFrom,
        confirmedAt: documentImports.confirmedAt,
        confirmedBy: documentImports.confirmedBy,
        byImport: documentImports.confirmedByImport,
        signatureId: documentImports.confirmationSignatureId,
      })
      .from(documentImports)
      .where(eq(documentImports.versionId, versionId));
    if (!row) return null;
    const people = await this.names(tx, [row.confirmedBy, row.dueFrom]);
    return {
      state: confirmationState(row, today),
      dueOn: row.dueOn,
      // Whom it is awaited from: the owner, moved with each new owner while
      // it awaits (security review 11). A confirmation given stays the one
      // given, by the owner then (`confirmedBy`).
      dueFrom: row.dueFrom ? { id: row.dueFrom, name: people.get(row.dueFrom) ?? null } : null,
      confirmedAt: row.confirmedAt,
      confirmedBy: row.confirmedBy
        ? { id: row.confirmedBy, name: people.get(row.confirmedBy) ?? null }
        : null,
      byImport: row.byImport,
      signatureId: row.signatureId,
    };
  }

  /**
   * The owner confirms an imported document (business decision 1): a
   * signature (meaning `import_confirmed`) over the imported version and
   * the importer's signature of it. Only its owner, only once, only while
   * it is in force as imported.
   */
  async confirmImport(
    auth: AuthContext,
    id: string,
    input: { password: string; revision: number },
    ip: string | null,
  ) {
    const { tenant, user } = auth;
    await this.tenantDb.withTenant(tenant.id, (tx) =>
      this.confirmable(tx, auth, id, input.revision, false),
    );
    await this.auth.confirmPassword(auth, input.password, 'import_confirmation', ip);
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, imported } = await this.confirmable(
        tx,
        auth,
        id,
        input.revision,
        true,
      );
      const now = new Date();
      const [importSignature] = await tx
        .select({ contentHash: signatureRows.contentHash })
        .from(signatureRows)
        .where(eq(signatureRows.id, imported.signatureId));
      const signature = await this.signatures.sign(tx, tenant.id, {
        userId: user.id,
        meaning: 'import_confirmed',
        subjectType: 'document_version',
        subjectId: imported.versionId,
        content: {
          documentId: doc.id,
          number: doc.number,
          versionId: imported.versionId,
          importSignatureHash: importSignature.contentHash,
          confirmedOn: dayOf(now, tenant.timeZone),
        },
      });
      await tx
        .update(documentImports)
        .set({ confirmedAt: now, confirmedBy: user.id, confirmationSignatureId: signature.id })
        .where(eq(documentImports.id, imported.id));
      await tx
        .update(documents)
        .set({ revision: sql`${documents.revision} + 1`, updatedAt: now })
        .where(eq(documents.id, doc.id));
      await this.provisioning.audit(tx, tenant.id, user.id, 'import_confirmed', 'document', doc.id, {
        versionId: imported.versionId,
        dueOn: imported.dueOn,
        signatureId: signature.id,
        contentHash: signature.contentHash,
      });
      return this.detail(tx, auth, viewer, await this.find(tx, viewer, doc.id));
    });
  }

  private async confirmable(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    revision: number,
    lock: boolean,
  ) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const doc = await this.find(tx, viewer, id, lock);
    if (!doc.access.owner) throw new ForbiddenException({ code: 'not_owner' });
    if (doc.revision !== revision) throw refuse.staleDocument();
    if (doc.status !== 'active') throw new ConflictException({ code: 'not_active' });
    const query = tx
      .select({
        id: documentImports.id,
        versionId: documentImports.versionId,
        signatureId: documentImports.signatureId,
        dueOn: documentImports.confirmationDueOn,
        dueFrom: documentImports.confirmationDueFrom,
        importedBy: documentImports.importedBy,
        confirmedAt: documentImports.confirmedAt,
      })
      .from(documentImports)
      .where(eq(documentImports.versionId, doc.publishedVersionId ?? sql`null`));
    const [imported] = lock ? await query.for('update') : await query;
    if (!imported) throw new ConflictException({ code: 'not_imported' });
    if (imported.confirmedAt) {
      throw new ConflictException({ code: 'import_already_confirmed' });
    }
    // Never by the one who imported it, even made its owner since
    // (security review 11); and only by whom it is due from.
    if (imported.importedBy === viewer.userId) {
      throw new ForbiddenException({ code: 'importer_cannot_confirm' });
    }
    if (imported.dueFrom && imported.dueFrom !== viewer.userId) {
      throw new ForbiddenException({ code: 'not_owner' });
    }
    return { viewer, doc, imported };
  }

  /**
   * The Approving authority signs a "no change" review its owner sent
   * (business decision 6, meaning `reviewed_no_change_approved`): only then
   * is the review recorded and the next review date moved, a review period
   * from today.
   */
  async approveReview(
    auth: AuthContext,
    id: string,
    input: { password: string; revision: number },
    ip: string | null,
  ) {
    const { tenant, user } = auth;
    await this.tenantDb.withTenant(tenant.id, (tx) =>
      this.decidableReview(tx, auth, id, input.revision, false),
    );
    await this.auth.confirmPassword(auth, input.password, 'review_approval', ip);
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, pending } = await this.decidableReview(
        tx,
        auth,
        id,
        input.revision,
        true,
      );
      const now = new Date();
      const today = dayOf(now, tenant.timeZone);
      const [published] = await tx
        .select(versionFields)
        .from(documentVersions)
        .where(eq(documentVersions.id, doc.publishedVersionId!));
      const [request] = await tx
        .select({ contentHash: signatureRows.contentHash })
        .from(signatureRows)
        .where(eq(signatureRows.id, pending.requestSignatureId));
      const nextReviewOn = addMonths(today, doc.reviewMonths);
      const signature = await this.signatures.sign(tx, tenant.id, {
        userId: user.id,
        meaning: 'reviewed_no_change_approved',
        subjectType: 'document',
        subjectId: doc.id,
        content: {
          documentId: doc.id,
          number: doc.number,
          publishedVersionId: published.id,
          versionHash: contentHash(signedVersion(doc, published)),
          requestHash: request.contentHash,
          dueOn: pending.dueOn,
          approvedOn: today,
          nextReviewOn,
        },
      });
      await tx
        .update(documentReviewApprovals)
        .set({ status: 'approved', decidedBy: user.id, decidedAt: now, decisionSignatureId: signature.id })
        .where(and(eq(documentReviewApprovals.id, pending.id), eq(documentReviewApprovals.status, 'pending')));
      await tx.insert(documentReviews).values({
        tenantId: tenant.id,
        documentId: doc.id,
        dueOn: pending.dueOn,
        outcome: 'no_change',
        comment: pending.comment,
        reviewedBy: pending.requestedBy,
        reviewedAt: pending.requestedAt,
        signatureId: pending.requestSignatureId,
        nextReviewOn,
        approvedBy: user.id,
        approvalSignatureId: signature.id,
      });
      await tx
        .update(documents)
        .set({
          nextReviewOn,
          lastReviewedOn: today,
          reviewNoticeRank: null,
          reviewNoticeFor: null,
          revision: sql`${documents.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(documents.id, doc.id));
      await this.provisioning.audit(tx, tenant.id, user.id, 'document_review_approved', 'document', doc.id, {
        outcome: 'no_change',
        requestedBy: pending.requestedBy,
        nextReviewOn: { from: doc.nextReviewOn, to: nextReviewOn },
        signatureId: signature.id,
        contentHash: signature.contentHash,
      });
      return this.detail(tx, auth, viewer, await this.find(tx, viewer, doc.id));
    });
  }

  /**
   * The Approving authority returns a "no change" review to its owner,
   * with why (business decision 6): the next review date stays, and the
   * owner may confirm it again, or start a new version.
   */
  returnReview(
    auth: AuthContext,
    id: string,
    input: { comment: string; revision: number },
  ) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const { viewer, doc, pending } = await this.decidableReview(
        tx,
        auth,
        id,
        input.revision,
        true,
      );
      const now = new Date();
      await tx
        .update(documentReviewApprovals)
        .set({ status: 'returned', decidedBy: user.id, decidedAt: now, decisionComment: input.comment })
        .where(and(eq(documentReviewApprovals.id, pending.id), eq(documentReviewApprovals.status, 'pending')));
      await tx
        .update(documents)
        .set({ revision: sql`${documents.revision} + 1`, updatedAt: now })
        .where(eq(documents.id, doc.id));
      await this.notifier.send(tx, tenant.id, doc, user.id, [
        {
          kind: 'review_returned',
          data: { dueOn: pending.dueOn ?? '' },
          to: [pending.requestedBy],
          about: 'published',
        },
      ]);
      await this.provisioning.audit(tx, tenant.id, user.id, 'document_review_returned', 'document', doc.id, {
        requestedBy: pending.requestedBy,
        comment: input.comment,
      });
      return this.detail(tx, auth, viewer, await this.find(tx, viewer, doc.id));
    });
  }

  /** The pending "no change" review the caller may decide, or why not. */
  private async decidableReview(
    tx: Transaction,
    auth: AuthContext,
    id: string,
    revision: number,
    lock: boolean,
  ) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const doc = await this.find(tx, viewer, id, lock);
    if (doc.revision !== revision) throw refuse.staleDocument();
    if (doc.status !== 'active') throw new ConflictException({ code: 'not_active' });
    const query = tx
      .select({
        id: documentReviewApprovals.id,
        dueOn: documentReviewApprovals.dueOn,
        comment: documentReviewApprovals.comment,
        requestedBy: documentReviewApprovals.requestedBy,
        requestedAt: documentReviewApprovals.requestedAt,
        requestSignatureId: documentReviewApprovals.requestSignatureId,
      })
      .from(documentReviewApprovals)
      .where(
        and(
          eq(documentReviewApprovals.documentId, doc.id),
          eq(documentReviewApprovals.status, 'pending'),
        ),
      );
    const [pending] = lock ? await query.for('update') : await query;
    if (!pending) throw new ConflictException({ code: 'no_review_pending' });
    if (pending.requestedBy === viewer.userId) {
      throw new ForbiddenException({ code: 'same_person', reason: 'requested' });
    }
    if (!(await reviewApproversOf(tx, doc.ownerUnitId, pending.requestedBy)).includes(viewer.userId)) {
      throw new ForbiddenException({ code: 'not_review_approver' });
    }
    return { viewer, doc, pending };
  }
}

/**
 * The "no change" reviews awaiting one person's signature (business
 * decision 6), for "Awaiting me" and the digest: numbers only.
 */
export async function reviewsAwaitingFor(tx: Transaction, userId: string) {
  const rows = await tx
    .select({
      documentId: documents.id,
      number: documents.number,
      title: documents.title,
      ownerUnitId: documents.ownerUnitId,
      dueOn: documentReviewApprovals.dueOn,
      requestedBy: documentReviewApprovals.requestedBy,
      requestedAt: documentReviewApprovals.requestedAt,
    })
    .from(documentReviewApprovals)
    .innerJoin(documents, eq(documents.id, documentReviewApprovals.documentId))
    .where(and(eq(documentReviewApprovals.status, 'pending'), eq(documents.status, 'active')))
    .orderBy(asc(documentReviewApprovals.requestedAt));
  const mine: typeof rows = [];
  for (const row of rows) {
    if (row.requestedBy === userId) continue;
    if ((await reviewApproversOf(tx, row.ownerUnitId, row.requestedBy)).includes(userId)) mine.push(row);
  }
  return mine;
}

/** Where an import's confirmation stands, on the client's day. */
export function confirmationState(
  row: { confirmedAt: Date | null; dueOn: string | null },
  today: string,
): 'confirmed' | 'awaiting' | 'overdue' {
  if (row.confirmedAt) return 'confirmed';
  return row.dueOn && row.dueOn < today ? 'overdue' : 'awaiting';
}

/**
 * Who signs a "no change" review of a document whose type asks for it
 * (business decision 6): the active holders of the built-in Approving
 * authority, granted for the whole organization or for the document's unit
 * or one above it; where there is none but `requester`, the Administrators
 * so granted (security review 11), as the starting route falls back to
 * them. Never `requester`.
 */
export async function reviewApproversOf(
  tx: Transaction,
  ownerUnitId: string,
  requester: string,
) {
  for (const code of ['approving_authority', 'administrator']) {
    const { rows } = await tx.execute<{ id: string }>(sql`
      with recursive up (id, parent_id) as (
        select o.id, o.parent_id from org_units o where o.id = ${ownerUnitId}
        union
        select o.id, o.parent_id from org_units o join up on o.id = up.parent_id
      )
      select distinct ra.user_id as id
      from role_assignments ra
      join roles r on r.id = ra.role_id and r.is_system and r.code = ${code}
      join users u on u.id = ra.user_id and u.status = 'active'
      where ra.org_unit_id is null or ra.org_unit_id in (select id from up)`);
    const others = rows.map((r) => r.id).filter((id) => id !== requester);
    if (others.length > 0) return others;
  }
  return [];
}
