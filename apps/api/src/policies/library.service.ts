import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  count,
  eq,
  ilike,
  desc,
  inArray,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { ApprovalEngine } from '../approvals/approval-engine.service.js';
import type { Transaction } from '../database/client.js';
import {
  approvalRuns,
  approvalRunSteps,
  documentAcknowledgements,
  documentCategories,
  documentImportBatches,
  documentImports,
  documents,
  documentTypes,
  documentVersions,
  orgUnits,
  roleAssignments,
  roles,
  signatures,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import {
  pickText,
  SUPPORTED_LOCALES,
  type Locale,
  type Localized,
} from '../i18n/locales.js';
import {
  dayOf,
  daysBetween,
  momentIn,
  shiftDay,
} from '../i18n/time-zones.js';
import { inChunks } from '../incidents/notifier.js';
import { csv, csvFileName } from './csv.js';
import { loadDocument } from './document-access.js';
import { REVIEW_DUE_DAYS, reviewState } from './documents.service.js';
import {
  ACKNOWLEDGEMENT_HEADINGS,
  DOCUMENT_LIST_HEADINGS,
  IMPORT_REGISTER_HEADINGS,
  EXPORT_VALUES,
  type ExportValue,
} from './export-wording.js';
import type { LibraryFilters, ListInput } from './input.js';
import {
  APPROVE_PERMISSION,
  assignedVersion,
  fullSight,
  inAudience,
  readsPublished,
  viewerOf,
  visible,
  within,
  type Viewer,
} from './visibility.js';

/**
 * The library's filters as the audit log keeps them: all but the free-text
 * search, which is reduced to whether there was one and its length.
 */
export function auditedFilters({ q, ...rest }: LibraryFilters) {
  return { ...rest, search: q ? { used: true, length: q.length } : { used: false } };
}

/** The business's measures (docs/specs/policies-and-procedures.md). */
export const MEASURES = {
  /** Documents past their review date: under this share, in percent. */
  pastReviewBelow: 5,
  /** Acknowledgement completion: at least this share, in percent. */
  acknowledgedAtLeast: 90,
};

/**
 * How far ahead of its review an imported document counts as due for its
 * re-issue (the `reissueDue` filter): the time its owner is reminded from.
 */
export const REISSUE_DUE_DAYS = 60;

/** The most rows a file holds: far more than any client's library. */
export const EXPORT_MAX_ROWS = 50_000;

/** A share in percent, to one decimal; null when there is nothing to share. */
const percent = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((1000 * part) / whole) / 10;

/** LIKE's own characters, written so that they mean themselves. */
const literal = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** A unit and every unit beneath it, as a query of ids. */
const unitAndBelow = (table: typeof orgUnits | typeof documentCategories, id: string) => sql`(
  with recursive below (id) as (
    select ${id}::uuid
    union
    select c.id from ${table} c join below b on c.parent_id = b.id
  ) select id from below)`;

/**
 * What the library lists and counts, always within what the viewer may see
 * (visibility.ts): the list, its search, the summary for the dashboard,
 * "awaiting me", the reviews due, and the acknowledgement figures.
 */
@Injectable()
export class LibraryService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly engine: ApprovalEngine,
    private readonly provisioning: ProvisioningService,
  ) {}

  /** The published version requires acknowledgement and the viewer has not given it. */
  private awaitingMine(viewer: Viewer): SQL {
    const row = sql`(select a.acknowledged_at is null from ${documentAcknowledgements} a
      where a.version_id = ${documents.publishedVersionId} and a.user_id = ${viewer.userId})`;
    return sql`(${documents.status} = 'active' and ${readsPublished(viewer)} and exists (
      select from ${documentVersions} pv
      where pv.id = ${documents.publishedVersionId} and pv.acknowledgement_required)
      and coalesce(${row}, ${viewer.readsLibrary ? inAudience(viewer) : sql`false`}))`;
  }

  /**
   * Where the search text appears: the number, the title in any language,
   * a keyword, or the text of a version the viewer may read (the published
   * one for its readers; with full sight, the one in progress too; for an
   * assignee, the version under their review). Never in a version the
   * viewer may not open, so a search cannot tell them what a draft says.
   */
  private matches(viewer: Viewer, q: string): SQL {
    const pattern = `%${literal(q)}%`;
    const sees = fullSight(viewer);
    return or(
      ilike(documents.number, pattern),
      sql`exists (select from jsonb_each_text(${documents.title}) t where t.value ilike ${pattern})`,
      sql`exists (select from unnest(${documents.keywords}) k where k ilike ${pattern})`,
      sql`exists (
        select from ${documentVersions} sv,
          jsonb_each(sv.content) l,
          jsonb_each_text(l.value) t
        where sv.document_id = ${documents.id}
          and jsonb_typeof(l.value) = 'object'
          and t.value ilike ${pattern}
          and (
            (sv.id = ${documents.publishedVersionId} and (${sees} or ${readsPublished(viewer)}))
            or (${sees} and sv.status in ('draft', 'in_review', 'approved'))
            or sv.id = ${assignedVersion(viewer, this.engine)}
          ))`,
    )!;
  }

  /**
   * The documents of the library the viewer may see, filtered and ordered
   * as asked: one query for the screen, a page at a time, and for the
   * export, all of it.
   */
  private libraryRows(
    tx: Transaction,
    auth: AuthContext,
    viewer: Viewer,
    input: LibraryFilters,
    today: string,
    page: { limit: number; offset: number },
  ) {
    const sees = fullSight(viewer);
    const where = and(
      visible(viewer, this.engine),
      input.q ? this.matches(viewer, input.q) : undefined,
      input.typeId ? eq(documents.typeId, input.typeId) : undefined,
      input.categoryId
        ? sql`${documents.categoryId} in ${unitAndBelow(documentCategories, input.categoryId)}`
        : undefined,
      input.ownerUnitId
        ? sql`${documents.ownerUnitId} in ${unitAndBelow(orgUnits, input.ownerUnitId)}`
        : undefined,
      input.status ? eq(documents.status, input.status) : undefined,
      input.review === 'overdue'
        ? sql`${documents.status} = 'active' and ${documents.nextReviewOn} < ${today}`
        : input.review === 'due'
          ? sql`${documents.status} = 'active' and ${documents.nextReviewOn} between ${today} and ${shiftDay(today, REVIEW_DUE_DAYS)}`
          : undefined,
      input.appliesToMe ? inAudience(viewer) : undefined,
      input.awaitingMyAcknowledgement ? this.awaitingMine(viewer) : undefined,
      input.source
        ? sql`exists (select from ${documentVersions} pv
            where pv.id = ${documents.publishedVersionId} and pv.source = ${input.source})`
        : undefined,
      input.reissueDue
        ? sql`${documents.status} = 'active'
            and ${documents.nextReviewOn} <= ${shiftDay(today, REISSUE_DUE_DAYS)}
            and exists (select from ${documentVersions} pv
              where pv.id = ${documents.publishedVersionId} and pv.source = 'imported')`
        : undefined,
    );
    const published = alias(documentVersions, 'published');
    const title = sql`coalesce(${documents.title} ->> ${auth.tenant.defaultLocale}, ${documents.number})`;
    const order = {
      number: [asc(documents.number)],
      title: [asc(title), asc(documents.number)],
      next_review: [
        sql`${documents.nextReviewOn} asc nulls last`,
        asc(documents.number),
      ],
      recently_published: [
        sql`${published.publishedAt} desc nulls last`,
        asc(documents.number),
      ],
    }[input.sort];
    const total = async () =>
      (
        await tx.select({ total: count() }).from(documents).where(where)
      )[0].total;
    const rows = tx
      .select({
        id: documents.id,
        number: documents.number,
        title: documents.title,
        type: {
          id: documentTypes.id,
          code: documentTypes.code,
          name: documentTypes.name,
        },
        category: {
          id: documentCategories.id,
          code: documentCategories.code,
          name: documentCategories.name,
        },
        ownerUnit: { id: orgUnits.id, name: orgUnits.name },
        status: documents.status,
        confidentiality: documents.confidentiality,
        version: published.version,
        effectiveOn: published.effectiveOn,
        publishedAt: published.publishedAt,
        nextReviewOn: documents.nextReviewOn,
        full: sql<boolean>`${sees}`,
        inProgress: sql<{
          id: string;
          version: number;
          status: string;
        } | null>`(select json_build_object('id', iv.id, 'version', iv.version, 'status', iv.status)
          from ${documentVersions} iv
          where iv.document_id = ${documents.id}
            and iv.status in ('draft', 'in_review', 'approved')
            and (${sees} or iv.id = ${assignedVersion(viewer, this.engine)}))`,
        awaiting: sql<boolean>`coalesce(${this.awaitingMine(viewer)}, false)`,
        myDueOn: sql<string | null>`(select a.due_on::text from ${documentAcknowledgements} a
          where a.version_id = ${documents.publishedVersionId} and a.user_id = ${viewer.userId})`,
        // For the export.
        ownerId: documents.ownerId,
        lastReviewedOn: documents.lastReviewedOn,
        reviewMonths: documents.reviewMonths,
        acknowledgementRequired: published.acknowledgementRequired,
        // Where the version in force came from: `imported` is approved
        // before Trustline, and is re-issued at its review.
        source: published.source,
        // For the export: what the original said, of the version in force.
        originalLastReviewedOn: sql<string | null>`(select di.last_reviewed_on::text
          from ${documentImports} di where di.version_id = ${documents.publishedVersionId})`,
        differences: sql<Localized | null>`(select di.differences
          from ${documentImports} di where di.version_id = ${documents.publishedVersionId})`,
      })
      .from(documents)
      .innerJoin(documentTypes, eq(documentTypes.id, documents.typeId))
      .innerJoin(
        documentCategories,
        eq(documentCategories.id, documents.categoryId),
      )
      .innerJoin(orgUnits, eq(orgUnits.id, documents.ownerUnitId))
      .leftJoin(published, eq(published.id, documents.publishedVersionId))
      .where(where)
      .orderBy(...order)
      .limit(page.limit)
      .offset(page.offset);
    return { rows, total };
  }

  list(auth: AuthContext, input: ListInput) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const { rows, total } = this.libraryRows(tx, auth, viewer, input, today, {
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      });
      const items = (await rows).map(
        ({
          full,
          awaiting,
          myDueOn,
          ownerId: _owner,
          lastReviewedOn: _last,
          reviewMonths: _months,
          acknowledgementRequired: _ack,
          originalLastReviewedOn: _original,
          differences: _differences,
          ...row
        }) => ({
          ...row,
          review: reviewState(row, today),
          access: full ? ('full' as const) : ('other' as const),
          // For the reader: an "Acknowledge" mark when it is theirs to give.
          myAcknowledgement: awaiting
            ? {
                dueOn: myDueOn,
                overdue: !!myDueOn && myDueOn < today,
              }
            : null,
        }),
      );
      return { items, total: await total() };
    });
  }

  /**
   * The language a file is written in: the one asked for, if the client
   * works in it (400 `language_mismatch` otherwise); else the caller's own,
   * if the client works in it; else the client's default.
   */
  private async fileLocale(
    tx: Transaction,
    auth: AuthContext,
    asked: Locale | undefined,
  ): Promise<Locale> {
    const ours = (l: string | null | undefined): l is Locale =>
      !!l &&
      auth.tenant.locales.includes(l) &&
      (SUPPORTED_LOCALES as readonly string[]).includes(l);
    if (asked) {
      if (!ours(asked)) {
        throw new BadRequestException({ code: 'language_mismatch' });
      }
      return asked;
    }
    const [me] = await tx
      .select({ locale: users.preferredLocale })
      .from(users)
      .where(eq(users.id, auth.user.id));
    if (ours(me?.locale)) return me.locale;
    return ours(auth.tenant.defaultLocale) ? auth.tenant.defaultLocale : 'en';
  }

  /**
   * The master list of controlled documents as a CSV file: every document
   * of the library the caller may see, with the library's filters and
   * order, in the caller's language. Whoever sees a document in full also
   * gets its version in progress. Audited: who took which list out.
   */
  exportDocuments(
    auth: AuthContext,
    input: LibraryFilters & { locale?: Locale },
  ) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const locale = await this.fileLocale(tx, auth, input.locale);
      const { locale: _locale, ...filters } = input;
      const rows = await this.libraryRows(tx, auth, viewer, filters, today, {
        limit: EXPORT_MAX_ROWS,
        offset: 0,
      }).rows;
      const owners = await this.namesOf(
        tx,
        rows.map((r) => r.ownerId),
      );
      const words = EXPORT_VALUES[locale];
      const h = DOCUMENT_LIST_HEADINGS[locale];
      const name = (text: Localized | null | undefined) =>
        pickText(text, locale, auth.tenant.defaultLocale);
      const body = csv(
        [
          h.number,
          h.title,
          h.type,
          h.category,
          h.responsibleArea,
          h.owner,
          h.status,
          h.confidentiality,
          h.version,
          h.effectiveOn,
          h.nextReviewOn,
          h.reviewState,
          h.lastReviewedOn,
          h.reviewMonths,
          h.acknowledgementRequired,
          h.inProgressVersion,
          h.inProgressStatus,
          // Last, so that the columns of files taken before keep their place.
          h.approvedBeforeTrustline,
          h.originalLastReviewedOn,
          h.differences,
        ],
        rows.map((r) => {
          const review = reviewState(r, today);
          const progress = r.full ? r.inProgress : null;
          return [
            r.number,
            name(r.title),
            name(r.type.name),
            name(r.category.name),
            name(r.ownerUnit.name),
            name(owners.get(r.ownerId)),
            words[`status.${r.status}`],
            words[`confidentiality.${r.confidentiality}`],
            r.version,
            r.effectiveOn,
            r.nextReviewOn,
            review ? words[`review.${review}`] : null,
            r.lastReviewedOn,
            r.reviewMonths,
            r.version === null
              ? null
              : words[r.acknowledgementRequired ? 'yes' : 'no'],
            progress?.version ?? null,
            progress
              ? (words[`version.${progress.status}` as ExportValue] ?? progress.status)
              : null,
            r.version === null
              ? null
              : words[r.source === 'imported' ? 'yes' : 'no'],
            r.originalLastReviewedOn,
            r.differences ? name(r.differences) : null,
          ];
        }),
      );
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'documents_exported',
        'tenant',
        auth.tenant.id,
        {
          // The search text itself is not kept: it may name a person or a
          // patient, and the audit log is kept for ever (security review,
          // finding 4). Only that there was one, and how long.
          filters: auditedFilters(filters),
          locale,
          rows: rows.length,
        },
      );
      return { body, fileName: csvFileName('documents', today) };
    });
  }

  private async namesOf(tx: Transaction, ids: string[]) {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map<string, Localized>();
    const found: { id: string; name: Localized }[] = [];
    for (const chunk of inChunks(wanted)) {
      found.push(
        ...(await tx
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, chunk))),
      );
    }
    return new Map(found.map((u) => [u.id, u.name]));
  }

  /**
   * The dashboard: documents past review and due within 30 days, what
   * awaits the caller's approval and acknowledgement, and the two measures
   * the business named, over what the caller may see.
   */
  summary(auth: AuthContext) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const number = (condition: SQL) =>
        sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
      const isActive = sql`${documents.status} = 'active'`;
      const [counts] = await tx
        .select({
          active: number(isActive),
          pastReview: number(
            sql`${isActive} and ${documents.nextReviewOn} < ${today}`,
          ),
          dueWithin30Days: number(
            sql`${isActive} and ${documents.nextReviewOn} between ${today} and ${shiftDay(today, REVIEW_DUE_DAYS)}`,
          ),
          awaitingMyAcknowledgement: number(this.awaitingMine(viewer)),
        })
        .from(documents)
        .where(visible(viewer, this.engine));
      const awaitingMyApproval = (await this.pendingFor(tx, viewer)).length;
      // Acknowledgement completion: of the people asked to acknowledge the
      // published version of each active document the caller sees in full
      // (the figures are for those who manage documents or see them all),
      // whose due date has passed, the share who have (quality review
      // condition 6: someone whose time has not run out is not yet behind).
      // People no longer active are not counted. `live` is the same over
      // everyone asked, due or not: the figure as it stands today.
      const figures = viewer.fullReach === 'all' || viewer.fullReach.length > 0;
      let acknowledgement = null;
      if (figures) {
        const due = sql`${documentAcknowledgements.dueOn} < ${today}`;
        const given = sql`${documentAcknowledgements.acknowledgedAt} is not null`;
        const [row] = await tx
          .select({
            targeted: number(due),
            acknowledged: number(sql`${due} and ${given}`),
            liveTargeted: count(),
            liveAcknowledged: number(given),
          })
          .from(documentAcknowledgements)
          .innerJoin(
            documents,
            eq(documents.publishedVersionId, documentAcknowledgements.versionId),
          )
          .innerJoin(
            users,
            and(
              eq(users.id, documentAcknowledgements.userId),
              eq(users.status, 'active'),
            ),
          )
          .where(and(eq(documents.status, 'active'), fullSight(viewer)));
        acknowledgement = {
          basis: 'due_date_passed' as const,
          targeted: row.targeted,
          acknowledged: row.acknowledged,
          percent: percent(row.acknowledged, row.targeted),
          target: MEASURES.acknowledgedAtLeast,
          met:
            row.targeted === 0
              ? null
              : (100 * row.acknowledged) / row.targeted >=
                MEASURES.acknowledgedAtLeast,
          live: {
            targeted: row.liveTargeted,
            acknowledged: row.liveAcknowledged,
            percent: percent(row.liveAcknowledged, row.liveTargeted),
          },
        };
      }
      return {
        today,
        active: counts.active,
        pastReview: {
          count: counts.pastReview,
          of: counts.active,
          percent: percent(counts.pastReview, counts.active),
          target: MEASURES.pastReviewBelow,
          met:
            counts.active === 0
              ? null
              : (100 * counts.pastReview) / counts.active <
                MEASURES.pastReviewBelow,
        },
        dueWithin30Days: counts.dueWithin30Days,
        awaitingMyApproval,
        awaitingMyAcknowledgement: counts.awaitingMyAcknowledgement,
        acknowledgement,
      };
    });
  }

  /**
   * The steps the viewer may decide now: the current step of a run in
   * progress on a version in review, for which they are an assignee, of a
   * version they did not prepare, in a run none of whose earlier steps they
   * decided. Oldest due first.
   */
  private pendingFor(tx: Transaction, viewer: Viewer) {
    return tx
      .select({
        stepId: approvalRunSteps.id,
        position: approvalRunSteps.position,
        kind: approvalRunSteps.kind,
        dueAt: approvalRunSteps.dueAt,
        activatedAt: approvalRunSteps.activatedAt,
        document: {
          id: documents.id,
          number: documents.number,
          title: documents.title,
        },
        type: {
          id: documentTypes.id,
          code: documentTypes.code,
          name: documentTypes.name,
        },
        version: {
          id: documentVersions.id,
          version: documentVersions.version,
          revision: documentVersions.revision,
        },
      })
      .from(approvalRunSteps)
      .innerJoin(
        approvalRuns,
        and(
          eq(approvalRuns.id, approvalRunSteps.runId),
          eq(approvalRuns.status, 'in_progress'),
          eq(approvalRuns.subjectType, 'document_version'),
        ),
      )
      .innerJoin(
        documentVersions,
        and(
          eq(documentVersions.id, approvalRuns.subjectId),
          eq(documentVersions.status, 'in_review'),
        ),
      )
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .innerJoin(documentTypes, eq(documentTypes.id, documents.typeId))
      .where(
        and(
          eq(approvalRunSteps.status, 'pending'),
          this.engine.assignedTo(viewer.assignment, documents.ownerUnitId),
          sql`not (${viewer.userId}::uuid = any(${documentVersions.contributors}))`,
          sql`not exists (select from approval_run_steps decided where decided.run_id = ${approvalRunSteps.runId} and decided.decided_by = ${viewer.userId})`,
        ),
      )
      .orderBy(asc(approvalRunSteps.dueAt), asc(documents.number));
  }

  /** "Awaiting me": the approval steps that are the caller's to decide. */
  myApprovals(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const rows = await this.pendingFor(tx, viewer);
      const now = Date.now();
      return {
        items: rows.map((r) => ({
          ...r,
          overdue: !!r.dueAt && r.dueAt.getTime() < now,
        })),
        total: rows.length,
      };
    });
  }

  /**
   * The periodic reviews coming up within 60 days, or past, of the active
   * documents the caller owns or manages. Soonest first.
   */
  reviewsDue(auth: AuthContext) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const rows = await tx
        .select({
          id: documents.id,
          number: documents.number,
          title: documents.title,
          ownerId: documents.ownerId,
          ownerUnit: { id: orgUnits.id, name: orgUnits.name },
          nextReviewOn: documents.nextReviewOn,
          revision: documents.revision,
          // In force as approved before Trustline: its review is a re-issue
          // through the route, not a confirmation.
          reissue: sql<boolean>`exists (select from ${documentVersions} pv
            where pv.id = ${documents.publishedVersionId} and pv.source = 'imported')`,
        })
        .from(documents)
        .innerJoin(orgUnits, eq(orgUnits.id, documents.ownerUnitId))
        .where(
          and(
            eq(documents.status, 'active'),
            sql`${documents.nextReviewOn} <= ${shiftDay(today, 60)}`,
            or(
              eq(documents.ownerId, viewer.userId),
              within(viewer.manageReach, documents.ownerUnitId),
            ),
          ),
        )
        .orderBy(asc(documents.nextReviewOn), asc(documents.number));
      return {
        items: rows.map((r) => ({
          ...r,
          mine: r.ownerId === viewer.userId,
          state: r.nextReviewOn! < today ? 'overdue' : 'due',
        })),
        total: rows.length,
      };
    });
  }

  /**
   * Who can be chosen as a document's owner or named in an approval step:
   * active staff, by name, with `approvers` those who hold
   * `policies.approve` somewhere. For those who manage documents. Names and
   * units only.
   */
  people(auth: AuthContext, input: { q?: string; approvers: boolean }) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const pattern = input.q ? `%${literal(input.q)}%` : null;
      return tx
        .select({ id: users.id, name: users.name, orgUnitId: users.orgUnitId })
        .from(users)
        .where(
          and(
            eq(users.status, 'active'),
            pattern
              ? sql`exists (select from jsonb_each_text(${users.name}) n where n.value ilike ${pattern})`
              : undefined,
            input.approvers
              ? sql`exists (select from ${roleAssignments} ra join ${roles} r on r.id = ra.role_id where ra.user_id = ${users.id} and ${APPROVE_PERMISSION} = any(r.permissions))`
              : undefined,
          ),
        )
        .orderBy(sql`${users.name} ->> ${auth.tenant.defaultLocale}`, asc(users.id))
        .limit(50);
    });
  }

  /**
   * Who has and has not acknowledged a version, with counts in total and by
   * unit, and the people page by page. Only with full sight of the
   * document; anyone else who may see it is refused with 403.
   */
  acknowledgements(
    auth: AuthContext,
    id: string,
    versionId: string,
    input: {
      state?: 'pending' | 'acknowledged' | 'overdue';
      includeLeft: boolean;
      page: number;
      pageSize: number;
    },
  ) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await loadDocument(tx, viewer, this.engine, id);
      if (!doc) throw new NotFoundException();
      if (!doc.access.full) {
        throw new ForbiddenException({
          code: 'missing_permission',
          permission: 'policies.view_all',
        });
      }
      const [version] = await tx
        .select({
          id: documentVersions.id,
          version: documentVersions.version,
          status: documentVersions.status,
          acknowledgementRequired: documentVersions.acknowledgementRequired,
        })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.id, versionId),
            eq(documentVersions.documentId, doc.id),
          ),
        );
      if (!version) throw new NotFoundException();
      // The figures count those still active; the list of people may
      // show those who left too, marked, as evidence of what they had done.
      const asked = and(
        eq(documentAcknowledgements.versionId, version.id),
        eq(users.status, 'active'),
      );
      const listed = input.includeLeft
        ? eq(documentAcknowledgements.versionId, version.id)
        : asked;
      const done = sql`${documentAcknowledgements.acknowledgedAt} is not null`;
      const late = sql`${documentAcknowledgements.acknowledgedAt} is null and ${documentAcknowledgements.dueOn} < ${today}`;
      const number = (condition: SQL) =>
        sql<number>`count(*) filter (where ${condition})`.mapWith(Number);
      const base = () =>
        tx
          .select({
            unitId: users.orgUnitId,
            total: count(),
            acknowledged: number(done),
            overdue: number(late),
          })
          .from(documentAcknowledgements)
          .innerJoin(users, eq(users.id, documentAcknowledgements.userId))
          .where(asked);
      const byUnitRows = await base().groupBy(users.orgUnitId);
      const unitIds = byUnitRows
        .map((r) => r.unitId)
        .filter((x): x is string => !!x);
      const unitNames =
        unitIds.length > 0
          ? new Map(
              (
                await tx
                  .select({ id: orgUnits.id, name: orgUnits.name })
                  .from(orgUnits)
                  .where(inArray(orgUnits.id, unitIds))
              ).map((u) => [u.id, u.name]),
            )
          : new Map();
      const totals = byUnitRows.reduce(
        (sum, r) => ({
          total: sum.total + r.total,
          acknowledged: sum.acknowledged + r.acknowledged,
          overdue: sum.overdue + r.overdue,
        }),
        { total: 0, acknowledged: 0, overdue: 0 },
      );
      const state =
        input.state === 'acknowledged'
          ? done
          : input.state === 'overdue'
            ? late
            : input.state === 'pending'
              ? sql`${documentAcknowledgements.acknowledgedAt} is null`
              : undefined;
      const [{ matching }] = await tx
        .select({ matching: count() })
        .from(documentAcknowledgements)
        .innerJoin(users, eq(users.id, documentAcknowledgements.userId))
        .where(and(listed, state));
      const unit = alias(orgUnits, 'unit');
      const people = await tx
        .select({
          user: { id: users.id, name: users.name },
          account: users.status,
          orgUnit: { id: unit.id, name: unit.name },
          assignedAt: documentAcknowledgements.assignedAt,
          dueOn: documentAcknowledgements.dueOn,
          acknowledgedAt: documentAcknowledgements.acknowledgedAt,
        })
        .from(documentAcknowledgements)
        .innerJoin(users, eq(users.id, documentAcknowledgements.userId))
        .leftJoin(unit, eq(unit.id, users.orgUnitId))
        .where(and(listed, state))
        .orderBy(
          sql`${documentAcknowledgements.acknowledgedAt} is not null`,
          asc(documentAcknowledgements.dueOn),
          sql`${users.name} ->> ${auth.tenant.defaultLocale}`,
          asc(users.id),
        )
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      return {
        versionId: version.id,
        version: version.version,
        status: version.status,
        acknowledgementRequired: version.acknowledgementRequired,
        targeted: totals.total,
        acknowledged: totals.acknowledged,
        pending: totals.total - totals.acknowledged,
        overdue: totals.overdue,
        percent: percent(totals.acknowledged, totals.total),
        byUnit: byUnitRows
          .map((r) => ({
            orgUnit: r.unitId
              ? { id: r.unitId, name: unitNames.get(r.unitId) ?? null }
              : null,
            targeted: r.total,
            acknowledged: r.acknowledged,
            overdue: r.overdue,
            percent: percent(r.acknowledged, r.total),
          }))
          .sort((a, b) => b.targeted - a.targeted),
        people: {
          items: people.map((p) => ({
            ...p,
            orgUnit: p.orgUnit?.id ? p.orgUnit : null,
            overdue: !p.acknowledgedAt && p.dueOn < today,
            // No longer an active user: kept as evidence, not counted.
            left: p.account !== 'active',
          })),
          total: matching,
        },
      };
    });
  }

  /**
   * Who was asked to acknowledge one version, and whether and when they
   * did, as a CSV file: any version of the document (one in force on a
   * given day included), and everyone asked, those who have left included
   * and marked. Only with full sight of the document (403 otherwise, 404
   * for one the caller may not see at all). The employee number is filled
   * only for people within the caller's `users.manage`. Audited.
   */
  exportAcknowledgements(
    auth: AuthContext,
    id: string,
    versionId: string,
    input: { locale?: Locale },
  ) {
    const { timeZone, defaultLocale } = auth.tenant;
    const today = dayOf(new Date(), timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const doc = await loadDocument(tx, viewer, this.engine, id);
      if (!doc) throw new NotFoundException();
      if (!doc.access.full) {
        throw new ForbiddenException({
          code: 'missing_permission',
          permission: 'policies.view_all',
        });
      }
      const [version] = await tx
        .select({
          id: documentVersions.id,
          version: documentVersions.version,
          status: documentVersions.status,
        })
        .from(documentVersions)
        .where(
          and(
            eq(documentVersions.id, versionId),
            eq(documentVersions.documentId, doc.id),
          ),
        );
      if (!version) throw new NotFoundException();
      const locale = await this.fileLocale(tx, auth, input.locale);
      const unit = alias(orgUnits, 'unit');
      const rows = await tx
        .select({
          name: users.name,
          employeeNumber: users.employeeNumber,
          orgUnitId: users.orgUnitId,
          account: users.status,
          unitName: unit.name,
          assignedAt: documentAcknowledgements.assignedAt,
          dueOn: documentAcknowledgements.dueOn,
          acknowledgedAt: documentAcknowledgements.acknowledgedAt,
          contentHash: signatures.contentHash,
        })
        .from(documentAcknowledgements)
        .innerJoin(users, eq(users.id, documentAcknowledgements.userId))
        .leftJoin(unit, eq(unit.id, users.orgUnitId))
        .leftJoin(
          signatures,
          eq(signatures.id, documentAcknowledgements.signatureId),
        )
        .where(eq(documentAcknowledgements.versionId, version.id))
        .orderBy(
          sql`${unit.name} ->> ${defaultLocale} nulls last`,
          sql`${users.name} ->> ${defaultLocale}`,
          asc(users.id),
        )
        .limit(EXPORT_MAX_ROWS);
      const words = EXPORT_VALUES[locale];
      const h = ACKNOWLEDGEMENT_HEADINGS[locale];
      const name = (text: Localized | null | undefined) =>
        pickText(text, locale, defaultLocale);
      const body = csv(
        [
          h.number,
          h.version,
          h.versionStatus,
          h.person,
          h.employeeNumber,
          h.area,
          h.account,
          h.assignedOn,
          h.dueOn,
          h.state,
          h.acknowledgedAt,
          h.signatureFingerprint,
        ],
        rows.map((r) => [
          doc.number,
          version.version,
          words[`version.${version.status}`],
          name(r.name),
          // The employee number only for people whose accounts the caller
          // manages: full sight of a document is not sight of the staff
          // register (security review, finding 1).
          covers(auth, 'users.manage', r.orgUnitId) ? r.employeeNumber : null,
          r.unitName ? name(r.unitName) : null,
          words[
            r.account === 'active'
              ? 'account.active'
              : r.account === 'invited'
                ? 'account.invited'
                : 'account.left'
          ],
          dayOf(r.assignedAt, timeZone),
          r.dueOn,
          words[
            r.acknowledgedAt
              ? 'ack.acknowledged'
              : r.dueOn < today
                ? 'ack.overdue'
                : 'ack.pending'
          ],
          r.acknowledgedAt ? momentIn(r.acknowledgedAt, timeZone) : null,
          r.contentHash,
        ]),
      );
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'acknowledgements_exported',
        'document',
        doc.id,
        { versionId: version.id, version: version.version, locale, rows: rows.length },
      );
      return {
        body,
        fileName: csvFileName(
          `acknowledgements-${doc.number}-v${version.version}`,
          today,
        ),
      };
    });
  }

  /**
   * The acknowledgements overdue among the people the caller has the
   * figures for (their own unit within the reach of the caller's
   * `policies.manage` or `policies.view_all`), on the version in force of
   * each active document: where the weekly digest leads. Most overdue
   * first. Each names its document and version only while the caller may
   * open it; otherwise both are `null`, and the row keeps the person, the
   * due date and its place in the count.
   */
  overdueAcknowledgements(
    auth: AuthContext,
    input: { page: number; pageSize: number },
  ) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const { total, rows } = await this.overdueRows(tx, auth, viewer, today, {
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      });
      return {
        today,
        items: rows.map(({ title, canOpen: open, document, version, employeeNumber: _n, ...r }) => ({
          ...r,
          orgUnit: r.orgUnit?.id ? r.orgUnit : null,
          // A document the caller may not open is not named at all: not its
          // number, id or version (security review, finding 2). The person,
          // the due date and the count stay, so the figures still add up.
          document: open ? { ...document, title, canOpen: true } : null,
          version: open ? version : null,
          daysOverdue: daysBetween(r.dueOn, today),
        })),
        total,
      };
    });
  }

  /** The overdue acknowledgements of `overdueAcknowledgements`, a page of them. */
  private async overdueRows(
    tx: Transaction,
    auth: AuthContext,
    viewer: Viewer,
    today: string,
    page: { limit: number; offset: number },
  ) {
    const unit = alias(orgUnits, 'unit');
    const where = and(
      sql`${documentAcknowledgements.acknowledgedAt} is null`,
      sql`${documentAcknowledgements.dueOn} < ${today}`,
      eq(documents.status, 'active'),
      eq(users.status, 'active'),
      within(viewer.fullReach, users.orgUnitId),
    );
    const [{ total }] = await tx
      .select({ total: count() })
      .from(documentAcknowledgements)
      .innerJoin(
        documents,
        eq(documents.publishedVersionId, documentAcknowledgements.versionId),
      )
      .innerJoin(users, eq(users.id, documentAcknowledgements.userId))
      .where(where);
    const canOpen = visible(viewer, this.engine);
    const rows = await tx
      .select({
        user: { id: users.id, name: users.name },
        employeeNumber: users.employeeNumber,
        orgUnit: { id: unit.id, name: unit.name },
        document: {
          id: documents.id,
          number: documents.number,
        },
        title: sql<Localized | null>`case when ${canOpen} then ${documents.title} end`,
        canOpen: sql<boolean>`${canOpen}`,
        version: {
          id: documentVersions.id,
          version: documentVersions.version,
        },
        dueOn: documentAcknowledgements.dueOn,
      })
      .from(documentAcknowledgements)
      .innerJoin(
        documents,
        eq(documents.publishedVersionId, documentAcknowledgements.versionId),
      )
      .innerJoin(
        documentVersions,
        eq(documentVersions.id, documentAcknowledgements.versionId),
      )
      .innerJoin(users, eq(users.id, documentAcknowledgements.userId))
      .leftJoin(unit, eq(unit.id, users.orgUnitId))
      .where(where)
      .orderBy(
        asc(documentAcknowledgements.dueOn),
        // Documents the caller may not open sort after the others of the
        // same day, by nothing of theirs: the order tells no number.
        sql`case when ${canOpen} then ${documents.number} end nulls last`,
        sql`${users.name} ->> ${auth.tenant.defaultLocale}`,
        asc(users.id),
        asc(documentAcknowledgements.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    return { total, rows };
  }

  /**
   * The late acknowledgements list as a CSV file (quality review 3, S5):
   * every row of `overdueAcknowledgements`, in the caller's language. A
   * document the caller may not open is not named, as on screen; the
   * employee number only for people whose accounts the caller manages.
   * Audited.
   */
  exportOverdueAcknowledgements(auth: AuthContext, input: { locale?: Locale }) {
    const { timeZone, defaultLocale } = auth.tenant;
    const today = dayOf(new Date(), timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const locale = await this.fileLocale(tx, auth, input.locale);
      const { rows } = await this.overdueRows(tx, auth, viewer, today, {
        limit: EXPORT_MAX_ROWS,
        offset: 0,
      });
      const h = ACKNOWLEDGEMENT_HEADINGS[locale];
      const name = (text: Localized | null | undefined) =>
        pickText(text, locale, defaultLocale);
      const body = csv(
        [h.person, h.employeeNumber, h.area, h.number, h.title, h.version, h.dueOn, h.daysOverdue],
        rows.map((r) => [
          name(r.user.name),
          covers(auth, 'users.manage', r.orgUnit?.id ?? null) ? r.employeeNumber : null,
          r.orgUnit?.id ? name(r.orgUnit.name) : null,
          r.canOpen ? r.document.number : null,
          r.canOpen ? name(r.title) : null,
          r.canOpen ? r.version.version : null,
          r.dueOn,
          daysBetween(r.dueOn, today),
        ]),
      );
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'overdue_acknowledgements_exported',
        'tenant',
        auth.tenant.id,
        { locale, rows: rows.length },
      );
      return { body, fileName: csvFileName('acknowledgements-overdue', today) };
    });
  }

  /**
   * One person's acknowledgement record (quality review 3, S5): every
   * document version they were asked to acknowledge, with when it was due,
   * when they acknowledged it and whether that was late. For those who
   * manage documents for the person's own unit (or the whole organization,
   * for a person with none); anyone else gets 404, as for a person who is
   * not there. People who have left are included, as their records stand.
   * A document the caller may not open is not named, as on the late list.
   */
  personAcknowledgements(
    auth: AuthContext,
    userId: string,
    input: { page: number; pageSize: number },
  ) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const person = await this.personInReach(tx, viewer, userId);
      const { total, rows } = await this.recordRows(tx, viewer, person.id, {
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      });
      return {
        today,
        person: {
          id: person.id,
          name: person.name,
          status: person.status,
          orgUnit: person.orgUnitId ? { id: person.orgUnitId, name: person.unitName } : null,
        },
        items: rows.map((r) => this.recordItem(r, today, auth.tenant.timeZone)),
        total,
      };
    });
  }

  /** The record of `personAcknowledgements` as a CSV file. Audited. */
  exportPersonAcknowledgements(
    auth: AuthContext,
    userId: string,
    input: { locale?: Locale },
  ) {
    const { timeZone, defaultLocale } = auth.tenant;
    const today = dayOf(new Date(), timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const person = await this.personInReach(tx, viewer, userId);
      const locale = await this.fileLocale(tx, auth, input.locale);
      const { rows } = await this.recordRows(tx, viewer, person.id, {
        limit: EXPORT_MAX_ROWS,
        offset: 0,
      });
      const words = EXPORT_VALUES[locale];
      const h = ACKNOWLEDGEMENT_HEADINGS[locale];
      const name = (text: Localized | null | undefined) =>
        pickText(text, locale, defaultLocale);
      const account =
        person.status === 'active'
          ? 'account.active'
          : person.status === 'invited'
            ? 'account.invited'
            : 'account.left';
      const body = csv(
        [
          h.person,
          h.employeeNumber,
          h.area,
          h.account,
          h.number,
          h.title,
          h.version,
          h.versionStatus,
          h.assignedOn,
          h.dueOn,
          h.state,
          h.acknowledgedAt,
          h.late,
          h.signatureFingerprint,
        ],
        rows.map((r) => {
          const item = this.recordItem(r, today, timeZone);
          return [
            name(person.name),
            covers(auth, 'users.manage', person.orgUnitId) ? person.employeeNumber : null,
            person.unitName ? name(person.unitName) : null,
            words[account],
            item.document?.number ?? null,
            item.document ? name(item.document.title) : null,
            item.version?.version ?? null,
            item.version ? words[`version.${item.version.status}` as ExportValue] : null,
            dayOf(r.assignedAt, timeZone),
            r.dueOn,
            words[`ack.${item.state}`],
            r.acknowledgedAt
              ? r.canOpen
                ? momentIn(r.acknowledgedAt, timeZone)
                : dayOf(r.acknowledgedAt, timeZone)
              : null,
            words[item.late ? 'yes' : 'no'],
            r.opensVersion ? r.contentHash : null,
          ];
        }),
      );
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'person_acknowledgements_exported',
        'user',
        person.id,
        { locale, rows: rows.length },
      );
      return { body, fileName: csvFileName('acknowledgements-person', today) };
    });
  }

  /**
   * The person, if the caller manages documents for their unit (or for the
   * whole organization); 404 otherwise, as for a person who is not there.
   */
  private async personInReach(tx: Transaction, viewer: Viewer, userId: string) {
    const unit = alias(orgUnits, 'unit');
    const [person] = await tx
      .select({
        id: users.id,
        name: users.name,
        status: users.status,
        orgUnitId: users.orgUnitId,
        employeeNumber: users.employeeNumber,
        unitName: unit.name,
      })
      .from(users)
      .leftJoin(unit, eq(unit.id, users.orgUnitId))
      .where(and(eq(users.id, userId), within(viewer.manageReach, users.orgUnitId)));
    if (!person) throw new NotFoundException();
    return person;
  }

  /** A person's acknowledgements, newest asked first. */
  private async recordRows(
    tx: Transaction,
    viewer: Viewer,
    userId: string,
    page: { limit: number; offset: number },
  ) {
    const where = eq(documentAcknowledgements.userId, userId);
    const [{ total }] = await tx
      .select({ total: count() })
      .from(documentAcknowledgements)
      .where(where);
    const canOpen = visible(viewer, this.engine);
    const rows = await tx
      .select({
        documentId: documents.id,
        number: documents.number,
        title: documents.title,
        canOpen: sql<boolean>`coalesce(${canOpen}, false)`,
        // That version itself (security review of quality 3, L1): with full
        // sight of the document, or it is the one in force of a document
        // the caller may open. A superseded version is not a reader's.
        opensVersion: sql<boolean>`coalesce(${fullSight(viewer)} or (${documentVersions.id} = ${documents.publishedVersionId} and ${canOpen}), false)`,
        versionId: documentVersions.id,
        version: documentVersions.version,
        versionStatus: documentVersions.status,
        assignedAt: documentAcknowledgements.assignedAt,
        dueOn: documentAcknowledgements.dueOn,
        acknowledgedAt: documentAcknowledgements.acknowledgedAt,
        contentHash: signatures.contentHash,
      })
      .from(documentAcknowledgements)
      .innerJoin(
        documentVersions,
        eq(documentVersions.id, documentAcknowledgements.versionId),
      )
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .leftJoin(signatures, eq(signatures.id, documentAcknowledgements.signatureId))
      .where(where)
      .orderBy(
        desc(documentAcknowledgements.assignedAt),
        asc(documentAcknowledgements.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    return { total, rows };
  }

  private recordItem(
    r: Awaited<ReturnType<LibraryService['recordRows']>>['rows'][number],
    today: string,
    timeZone: string,
  ) {
    const acknowledgedOn = r.acknowledgedAt ? dayOf(r.acknowledgedAt, timeZone) : null;
    return {
      // Not named at all where the caller may not open it.
      document: r.canOpen
        ? { id: r.documentId, number: r.number, title: r.title }
        : null,
      // Only where the caller may open that version (L1).
      version: r.opensVersion
        ? { id: r.versionId, version: r.version, status: r.versionStatus }
        : null,
      // Of a document not named, the day only (N1): the moment could tell
      // which document it was, beside a list of publications.
      assignedAt: r.canOpen ? r.assignedAt : dayOf(r.assignedAt, timeZone),
      dueOn: r.dueOn,
      acknowledgedAt: r.canOpen ? r.acknowledgedAt : acknowledgedOn,
      state: (r.acknowledgedAt
        ? 'acknowledged'
        : r.dueOn < today
          ? 'overdue'
          : 'pending') as 'acknowledged' | 'overdue' | 'pending',
      // Acknowledged after the day it was due, or not and the day passed.
      late: acknowledgedOn ? acknowledgedOn > r.dueOn : r.dueOn < today,
    };
  }

  /**
   * The approval steps overdue on versions of documents the caller manages
   * (quality review 3, S2): for the managers' daily digest, as `myApprovals`
   * is for those who decide them. Numbers and versions only.
   */
  overdueSteps(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const { total, rows } = await this.overdueStepRows(tx, viewer, {
        limit: EXPORT_MAX_ROWS,
        offset: 0,
      });
      return {
        items: rows.map((r) => ({
          document: r.document,
          version: r.version,
          position: r.position,
          kind: r.kind,
          dueAt: r.dueAt,
        })),
        total,
      };
    });
  }

  /**
   * The list of overdue approval steps (language review 8, M6): where the
   * weekly email and notice lead when steps are overdue. The same steps and
   * scope as `overdueSteps`, a page at a time, most overdue first: the
   * document's number and version, the step's position and kind, who it is
   * assigned to (a person, or a role), its due time and how many days it is
   * overdue. The title only where the caller may open the document.
   */
  overdueStepsList(auth: AuthContext, input: { page: number; pageSize: number }) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
      const { total, rows } = await this.overdueStepRows(tx, viewer, {
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      });
      const people = await this.namesOf(
        tx,
        rows.flatMap((r) => (r.assigneeUserId ? [r.assigneeUserId] : [])),
      );
      return {
        today,
        items: rows.map(({ title, canOpen, assigneeUserId, assigneeRole, ...r }) => ({
          document: { ...r.document, title: canOpen ? title : null, canOpen },
          version: r.version,
          position: r.position,
          kind: r.kind,
          assignee: assigneeUserId
            ? { type: 'person' as const, id: assigneeUserId, name: people.get(assigneeUserId) ?? null }
            : assigneeRole?.id
              ? { type: 'role' as const, id: assigneeRole.id, name: assigneeRole.name }
              : null,
          dueAt: r.dueAt,
          dueOn: r.dueAt ? dayOf(r.dueAt, auth.tenant.timeZone) : null,
          daysOverdue: r.dueAt ? daysBetween(dayOf(r.dueAt, auth.tenant.timeZone), today) : 0,
        })),
        total,
      };
    });
  }

  /** The overdue steps of `overdueSteps` and `overdueStepsList`. */
  private async overdueStepRows(
    tx: Transaction,
    viewer: Viewer,
    page: { limit: number; offset: number },
  ) {
    const where = and(
      eq(approvalRunSteps.status, 'pending'),
      lt(approvalRunSteps.dueAt, new Date()),
      ne(documents.status, 'retired'),
      within(viewer.manageReach, documents.ownerUnitId),
    );
    const from = () =>
      tx
        .select({ total: count() })
        .from(approvalRunSteps)
        .innerJoin(
          approvalRuns,
          and(
            eq(approvalRuns.id, approvalRunSteps.runId),
            eq(approvalRuns.status, 'in_progress'),
            eq(approvalRuns.subjectType, 'document_version'),
          ),
        )
        .innerJoin(
          documentVersions,
          and(
            eq(documentVersions.id, approvalRuns.subjectId),
            eq(documentVersions.status, 'in_review'),
          ),
        )
        .innerJoin(documents, eq(documents.id, documentVersions.documentId))
        .where(where);
    const [{ total }] = await from();
    const canOpen = visible(viewer, this.engine);
    const role = alias(roles, 'assignee_role');
    const rows = await tx
      .select({
        document: { id: documents.id, number: documents.number },
        title: documents.title,
        canOpen: sql<boolean>`coalesce(${canOpen}, false)`,
        version: { id: documentVersions.id, version: documentVersions.version },
        position: approvalRunSteps.position,
        kind: approvalRunSteps.kind,
        assigneeUserId: approvalRunSteps.assigneeUserId,
        assigneeRole: { id: role.id, name: role.name },
        dueAt: approvalRunSteps.dueAt,
      })
      .from(approvalRunSteps)
      .innerJoin(
        approvalRuns,
        and(
          eq(approvalRuns.id, approvalRunSteps.runId),
          eq(approvalRuns.status, 'in_progress'),
          eq(approvalRuns.subjectType, 'document_version'),
        ),
      )
      .innerJoin(
        documentVersions,
        and(
          eq(documentVersions.id, approvalRuns.subjectId),
          eq(documentVersions.status, 'in_review'),
        ),
      )
      .innerJoin(documents, eq(documents.id, documentVersions.documentId))
      .leftJoin(role, eq(role.id, approvalRunSteps.assigneeRoleId))
      .where(where)
      .orderBy(
        asc(approvalRunSteps.dueAt),
        asc(documents.number),
        asc(approvalRunSteps.id),
      )
      .limit(page.limit)
      .offset(page.offset);
    return { total, rows };
  }

  /**
   * The register of imports (quality review 3, S1): every document imported
   * as approved before Trustline, with what its original says, who imported
   * it and when, and its batch with the fingerprint of the list the one
   * password re-entry covered. Newest first. For those who manage documents
   * for the whole organization, as importing is.
   */
  imports(auth: AuthContext, input: { page: number; pageSize: number }) {
    this.assertWholeOrganization(auth);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [{ total }] = await tx.select({ total: count() }).from(documentImports);
      const rows = await this.importRows(tx, {
        limit: input.pageSize,
        offset: (input.page - 1) * input.pageSize,
      });
      const people = await this.namesOf(tx, rows.map((r) => r.importedBy));
      return {
        items: rows.map(({ importedBy, ...r }) => ({
          ...r,
          importedBy: { id: importedBy, name: people.get(importedBy) ?? null },
        })),
        total,
      };
    });
  }

  /** The register of imports as a CSV file, in the caller's language. Audited. */
  exportImports(auth: AuthContext, input: { locale?: Locale }) {
    this.assertWholeOrganization(auth);
    const { timeZone, defaultLocale } = auth.tenant;
    const today = dayOf(new Date(), timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const locale = await this.fileLocale(tx, auth, input.locale);
      const rows = await this.importRows(tx, { limit: EXPORT_MAX_ROWS, offset: 0 });
      const people = await this.namesOf(tx, rows.map((r) => r.importedBy));
      const h = IMPORT_REGISTER_HEADINGS[locale];
      const name = (text: Localized | null | undefined) =>
        pickText(text, locale, defaultLocale);
      const body = csv(
        [
          h.number,
          h.title,
          h.originalNumber,
          h.revisionLabel,
          h.approvedOn,
          h.approvedBy,
          h.lastReviewedOn,
          h.originalKeptAt,
          h.differences,
          h.importedBy,
          h.importedAt,
          h.batch,
          h.batchListHash,
          h.signatureFingerprint,
        ],
        rows.map((r) => [
          r.number,
          name(r.title),
          r.numberAsGiven,
          r.revisionLabel,
          r.approvedOn,
          r.approvedBy,
          r.lastReviewedOn,
          name(r.originalKeptAt),
          r.differences ? name(r.differences) : null,
          name(people.get(r.importedBy)),
          momentIn(r.importedAt, timeZone),
          r.batch.id,
          r.batch.listHash,
          r.contentHash,
        ]),
      );
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'imports_exported',
        'tenant',
        auth.tenant.id,
        { locale, rows: rows.length },
      );
      return { body, fileName: csvFileName('imports', today) };
    });
  }

  private importRows(tx: Transaction, page: { limit: number; offset: number }) {
    return tx
      .select({
        documentId: documents.id,
        number: documents.number,
        title: documents.title,
        versionId: documentImports.versionId,
        numberAsGiven: documentImports.numberAsGiven,
        revisionLabel: documentImports.revisionLabel,
        approvedOn: documentImports.approvedOn,
        approvedBy: documentImports.approvedBy,
        lastReviewedOn: documentImports.lastReviewedOn,
        originalKeptAt: documentImports.originalKeptAt,
        differences: documentImports.differences,
        effectiveOn: documentImports.effectiveOn,
        nextReviewOn: documentImports.nextReviewOn,
        importedBy: documentImports.importedBy,
        importedAt: documentImports.importedAt,
        batch: {
          id: documentImportBatches.id,
          index: documentImports.batchIndex,
          size: documentImportBatches.size,
          listHash: documentImportBatches.listHash,
        },
        signatureId: documentImports.signatureId,
        contentHash: signatures.contentHash,
      })
      .from(documentImports)
      .innerJoin(documents, eq(documents.id, documentImports.documentId))
      .innerJoin(
        documentImportBatches,
        eq(documentImportBatches.id, documentImports.batchId),
      )
      .innerJoin(signatures, eq(signatures.id, documentImports.signatureId))
      .orderBy(
        desc(documentImports.importedAt),
        asc(documentImports.batchId),
        asc(documentImports.batchIndex),
      )
      .limit(page.limit)
      .offset(page.offset);
  }

  /** 403 unless the caller manages documents for the whole organization. */
  private assertWholeOrganization(auth: AuthContext) {
    if (!covers(auth, 'policies.manage', null)) {
      throw new ForbiddenException({
        code: 'missing_permission',
        permission: 'policies.manage',
      });
    }
  }
}
