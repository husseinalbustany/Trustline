import { eq, sql } from 'drizzle-orm';
import type { ApprovalEngine } from '../approvals/approval-engine.service.js';
import type { Transaction } from '../database/client.js';
import { documents } from '../database/schema.js';
import {
  assignedVersion,
  fullSight,
  manages,
  readsPublished,
  type Viewer,
} from './visibility.js';

/** A document's own columns, as the services read them. */
export const documentFields = {
  id: documents.id,
  number: documents.number,
  typeId: documents.typeId,
  categoryId: documents.categoryId,
  title: documents.title,
  ownerId: documents.ownerId,
  ownerUnitId: documents.ownerUnitId,
  confidentiality: documents.confidentiality,
  keywords: documents.keywords,
  references: documents.references,
  reviewMonths: documents.reviewMonths,
  nextReviewOn: documents.nextReviewOn,
  lastReviewedOn: documents.lastReviewedOn,
  status: documents.status,
  source: documents.source,
  publishedVersionId: documents.publishedVersionId,
  retiredAt: documents.retiredAt,
  retiredBy: documents.retiredBy,
  retireReason: documents.retireReason,
  createdBy: documents.createdBy,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  revision: documents.revision,
};

/** What one viewer may do with one document, worked out in the database. */
export type DocumentAccess = {
  /** Everything: every version, drafts, history, figures. */
  full: boolean;
  /** May create versions, edit, publish, retire. */
  manages: boolean;
  /** Reads the published version. */
  reads: boolean;
  /** The version in review whose run has a step for the viewer. */
  assignedVersionId: string | null;
  owner: boolean;
};

export type LoadedDocument = Pick<
  typeof documents.$inferSelect,
  keyof typeof documentFields
> & { access: DocumentAccess };

/**
 * One document with what the viewer may do with it, or null if they may not
 * see it at all (which a route answers with 404, as for a document that does
 * not exist). With `lock`, the document's row is held until the transaction
 * ends: every change to a document or one of its versions takes this lock
 * first, so two changes to one document take turns, and the second reads
 * what the first left.
 */
export async function loadDocument(
  tx: Transaction,
  viewer: Viewer,
  engine: ApprovalEngine,
  id: string,
  { lock = false } = {},
): Promise<LoadedDocument | null> {
  const query = tx
    .select({
      ...documentFields,
      full: sql<boolean>`${fullSight(viewer)}`,
      manages: sql<boolean>`${manages(viewer)}`,
      reads: sql<boolean>`coalesce(${readsPublished(viewer)}, false)`,
      assignedVersionId: sql<string | null>`${assignedVersion(viewer, engine)}`,
    })
    .from(documents)
    .where(eq(documents.id, id));
  const [row] = lock ? await query.for('update') : await query;
  if (!row) return null;
  const { full, manages: manager, reads, assignedVersionId, ...doc } = row;
  const access: DocumentAccess = {
    full,
    manages: manager,
    reads,
    assignedVersionId,
    owner: doc.ownerId === viewer.userId,
  };
  if (!access.full && !access.reads && !access.assignedVersionId) return null;
  return { ...doc, access };
}
