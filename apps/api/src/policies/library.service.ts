import {
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
  inArray,
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
  documents,
  documentTypes,
  documentVersions,
  orgUnits,
  roleAssignments,
  roles,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { dayOf, shiftDay } from '../i18n/time-zones.js';
import { loadDocument } from './document-access.js';
import { REVIEW_DUE_DAYS } from './documents.service.js';
import type { ListInput } from './input.js';
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

/** The business's measures (docs/specs/policies-and-procedures.md). */
export const MEASURES = {
  /** Documents past their review date: under this share, in percent. */
  pastReviewBelow: 5,
  /** Acknowledgement completion: at least this share, in percent. */
  acknowledgedAtLeast: 90,
};

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

  list(auth: AuthContext, input: ListInput) {
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const viewer = await viewerOf(tx, auth, this.engine);
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
      const [{ total }] = await tx
        .select({ total: count() })
        .from(documents)
        .where(where);
      const rows = await tx
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
        .limit(input.pageSize)
        .offset((input.page - 1) * input.pageSize);
      const items = rows.map(({ full, awaiting, myDueOn, ...row }) => ({
        ...row,
        review:
          row.status === 'active' && row.nextReviewOn
            ? row.nextReviewOn < today
              ? ('overdue' as const)
              : row.nextReviewOn <= shiftDay(today, REVIEW_DUE_DAYS)
                ? ('due' as const)
                : null
            : null,
        access: full ? ('full' as const) : ('other' as const),
        // For the reader: an "Acknowledge" mark when it is theirs to give.
        myAcknowledgement: awaiting
          ? {
              dueOn: myDueOn,
              overdue: !!myDueOn && myDueOn < today,
            }
          : null,
      }));
      return { items, total };
    });
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
      // the share who have. People no longer active are not counted.
      const figures = viewer.fullReach === 'all' || viewer.fullReach.length > 0;
      let acknowledgement = null;
      if (figures) {
        const [row] = await tx
          .select({
            targeted: count(),
            acknowledged: sql<number>`count(${documentAcknowledgements.acknowledgedAt})`.mapWith(
              Number,
            ),
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
          targeted: row.targeted,
          acknowledged: row.acknowledged,
          percent: percent(row.acknowledged, row.targeted),
          target: MEASURES.acknowledgedAtLeast,
          met:
            row.targeted === 0
              ? null
              : (100 * row.acknowledged) / row.targeted >=
                MEASURES.acknowledgedAtLeast,
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
   * version they did not prepare. Oldest due first.
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
    input: { state?: 'pending' | 'acknowledged' | 'overdue'; page: number; pageSize: number },
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
      const asked = and(
        eq(documentAcknowledgements.versionId, version.id),
        eq(users.status, 'active'),
      );
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
        .where(and(asked, state));
      const unit = alias(orgUnits, 'unit');
      const people = await tx
        .select({
          user: { id: users.id, name: users.name },
          orgUnit: { id: unit.id, name: unit.name },
          assignedAt: documentAcknowledgements.assignedAt,
          dueOn: documentAcknowledgements.dueOn,
          acknowledgedAt: documentAcknowledgements.acknowledgedAt,
        })
        .from(documentAcknowledgements)
        .innerJoin(users, eq(users.id, documentAcknowledgements.userId))
        .leftJoin(unit, eq(unit.id, users.orgUnitId))
        .where(and(asked, state))
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
          })),
          total: matching,
        },
      };
    });
  }
}

