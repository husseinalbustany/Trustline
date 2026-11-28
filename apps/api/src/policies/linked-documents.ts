import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { ApprovalEngine } from '../approvals/approval-engine.service.js';
import type { Transaction } from '../database/client.js';
import { documents, documentVersions } from '../database/schema.js';
import type { AuthContext } from '../identity/auth.service.js';
import type { Localized } from '../i18n/locales.js';
import { dayOf } from '../i18n/time-zones.js';
import { viewerOf, visible } from './visibility.js';

/**
 * A controlled document as another module shows it where it links to one
 * (a risk's control, the risk management framework), for anyone who may
 * see the record that links to it:
 *
 * - to someone who may read the document (policies/visibility.ts): its
 *   number, status, version in force, review state and title;
 * - to someone who may not, of a document open to all staff: the same
 *   without the title;
 * - to someone who may not, of a restricted document: only that it is a
 *   restricted document (`restricted: true`), nothing else of it
 *   (security review 15, L1, as the business decided).
 */
export type LinkedDocument = {
  id: string;
  restricted: boolean;
  number: string | null;
  status: 'draft' | 'active' | 'retired' | null;
  version: number | null;
  nextReviewOn: string | null;
  /** Its next review day has passed. */
  pastReview: boolean;
  /** Null when the reader may not open the document. */
  title: Localized | null;
};

/**
 * What the policies module tells other modules of its documents, in their
 * transaction: they read its tables only through here.
 */
/** What another module does when a document it links to is retired. */
export type RetiredListener = (
  tx: Transaction,
  tenant: { id: string; modules: readonly string[] },
  documentId: string,
  actorId: string,
) => Promise<void>;

@Injectable()
export class LinkedDocuments {
  private readonly listeners: RetiredListener[] = [];

  constructor(private readonly engine: ApprovalEngine) {}

  /**
   * Called once by a module that links to documents (the risks module, for
   * its controls), to be told in the transaction that retires one.
   */
  onRetired(listener: RetiredListener) {
    this.listeners.push(listener);
  }

  /** Tells the modules that link to documents that this one was retired. */
  async retired(
    tx: Transaction,
    tenant: { id: string; modules: readonly string[] },
    documentId: string,
    actorId: string,
  ) {
    for (const listener of this.listeners) await listener(tx, tenant, documentId, actorId);
  }

  /**
   * Whether `auth` may link to this document now: it is in force
   * (published, not retired) and they may read it. Its number, or null; a
   * document they may not read is answered as one that does not exist.
   */
  async linkable(tx: Transaction, auth: AuthContext, id: string) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const [row] = await tx
      .select({ id: documents.id, number: documents.number })
      .from(documents)
      .where(and(eq(documents.id, id), eq(documents.status, 'active'), visible(viewer, this.engine)));
    return row ?? null;
  }

  /** Whether `auth` may read this document, whatever its status. */
  async readable(tx: Transaction, auth: AuthContext, id: string) {
    const viewer = await viewerOf(tx, auth, this.engine);
    const [row] = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, id), visible(viewer, this.engine)));
    return !!row;
  }

  /** These documents, by id, as `auth` may be told of them. */
  async describe(
    tx: Transaction,
    auth: AuthContext,
    ids: string[],
  ): Promise<Record<string, LinkedDocument>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return {};
    const viewer = await viewerOf(tx, auth, this.engine);
    const rows = await tx
      .select({
        id: documents.id,
        number: documents.number,
        status: documents.status,
        confidentiality: documents.confidentiality,
        version: documentVersions.version,
        nextReviewOn: documents.nextReviewOn,
        title: documents.title,
        readable: visible(viewer, this.engine).mapWith(Boolean),
      })
      .from(documents)
      .leftJoin(
        documentVersions,
        eq(documentVersions.id, documents.publishedVersionId),
      )
      .where(inArray(documents.id, wanted));
    const today = dayOf(new Date(), auth.tenant.timeZone);
    return Object.fromEntries(
      rows.map((r) => {
        if (!r.readable && r.confidentiality === 'restricted') {
          const hidden: LinkedDocument = {
            id: r.id,
            restricted: true,
            number: null,
            status: null,
            version: null,
            nextReviewOn: null,
            pastReview: false,
            title: null,
          };
          return [r.id, hidden];
        }
        const shown: LinkedDocument = {
          id: r.id,
          restricted: r.confidentiality === 'restricted',
          number: r.number,
          status: r.status,
          version: r.status === 'active' ? (r.version ?? null) : null,
          nextReviewOn: r.nextReviewOn,
          pastReview:
            r.status === 'active' && !!r.nextReviewOn && r.nextReviewOn < today,
          title: r.readable ? r.title : null,
        };
        return [r.id, shown];
      }),
    );
  }
}
