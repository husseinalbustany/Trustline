import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { ApprovalEngine } from '../approvals/approval-engine.service.js';
import { contentHash, SignatureService } from '../approvals/signatures.js';
import type { Transaction } from '../database/client.js';
import {
  documentAcknowledgements,
  documentReviews,
  documents,
  documentVersions,
  users,
} from '../database/schema.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { addMonths, shiftDay } from '../i18n/time-zones.js';
import { DocumentNotifier, type NotifiedDocument } from './document-notifier.js';
import { signedVersion } from './signed-content.js';
import { userInAudience } from './visibility.js';

/** A document as publishing needs it, locked by the caller. */
export type PublishedDocument = NotifiedDocument & {
  publishedVersionId: string | null;
  reviewMonths: number;
  nextReviewOn: string | null;
};

/** A version as publishing needs it, locked by the caller. */
export type PublishedVersion = {
  id: string;
  version: number;
  preparedBy: string;
  scheduledBy: string | null;
  acknowledgementRequired: boolean;
  acknowledgeWithinDays: number;
};

/** A version as its signatures are checked against it. */
export type SignedVersionRow = Parameters<typeof signedVersion>[1];

/**
 * Publishes an approved version: by a manager now, or by the daily check on
 * the day it was scheduled for. One place, so that both do the same:
 *
 * - the version published before it is superseded;
 * - the document is active with this version, its next review date counted
 *   from the effective day, and the reminders of the review start again;
 * - a document that was already active records the publication as its
 *   periodic review answered by a revision (`document_reviews`, `revised`);
 * - if acknowledgement is required, everyone in the audience then is asked
 *   (one row each, due after the days allowed) and notified;
 * - it is audited, in the caller's transaction, with no actor when the
 *   check did it.
 */
@Injectable()
export class Publisher {
  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly notifier: DocumentNotifier,
    private readonly engine: ApprovalEngine,
    private readonly signatures: SignatureService,
  ) {}

  /**
   * Whether the run that approved the version stands behind what it holds
   * now: every step of it approved by the person who signed it, and every
   * signature of exactly this content. Checked before publishing now, when
   * scheduling, and again by the daily check on the day.
   */
  async isSigned(
    tx: Transaction,
    doc: { id: string; number: string },
    version: SignedVersionRow,
  ) {
    const runs = await this.engine.runsOf(tx, 'document_version', [version.id]);
    const approvedRun = runs.find((r) => r.status === 'approved');
    if (!approvedRun) return false;
    const signed = new Map(
      (await this.signatures.of(tx, 'document_version', [version.id])).map(
        (s) => [s.id, s],
      ),
    );
    const hash = contentHash(signedVersion(doc, version));
    return approvedRun.steps.every((step) => {
      const signature = step.signatureId ? signed.get(step.signatureId) : null;
      return (
        step.status === 'approved' &&
        !!signature &&
        signature.userId === step.decidedBy &&
        signature.contentHash === hash
      );
    });
  }

  async publish(
    tx: Transaction,
    tenantId: string,
    document: PublishedDocument,
    version: PublishedVersion,
    input: {
      actorId: string | null;
      /** The day it takes effect: today, or the day it was scheduled for. */
      effectiveOn: string;
      /** Today, on the client's calendar. */
      today: string;
      now: Date;
    },
  ) {
    const { actorId, effectiveOn, today, now } = input;
    const previous = document.publishedVersionId;
    if (previous) {
      await tx
        .update(documentVersions)
        .set({
          status: 'superseded',
          supersededAt: now,
          revision: sql`${documentVersions.revision} + 1`,
          updatedAt: now,
        })
        .where(eq(documentVersions.id, previous));
    }
    await tx
      .update(documentVersions)
      .set({
        status: 'published',
        effectiveOn,
        publishedAt: now,
        publishedBy: actorId,
        revision: sql`${documentVersions.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(documentVersions.id, version.id));
    const nextReviewOn = addMonths(effectiveOn, document.reviewMonths);
    if (document.status === 'active') {
      await tx.insert(documentReviews).values({
        tenantId,
        documentId: document.id,
        dueOn: document.nextReviewOn,
        outcome: 'revised',
        reviewedBy: actorId ?? version.scheduledBy ?? version.preparedBy,
        reviewedAt: now,
        nextReviewOn,
      });
    }
    await tx
      .update(documents)
      .set({
        status: 'active',
        publishedVersionId: version.id,
        nextReviewOn,
        lastReviewedOn: effectiveOn,
        reviewNoticeRank: null,
        reviewNoticeFor: null,
        revision: sql`${documents.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(documents.id, document.id));

    let asked = 0;
    let notified = 0;
    if (version.acknowledgementRequired) {
      const dueOn = shiftDay(today, version.acknowledgeWithinDays);
      const added = await this.assignAcknowledgements(
        tx,
        tenantId,
        document.id,
        version.id,
        dueOn,
        now,
      );
      asked = added.length;
      notified = await this.notifier.send(
        tx,
        tenantId,
        { ...document, status: 'active' },
        actorId,
        [
          {
            kind: 'document_published',
            data: { version: version.version, dueOn },
            to: added,
            about: 'published',
          },
        ],
      );
    }
    await this.provisioning.audit(
      tx,
      tenantId,
      actorId,
      'document_published',
      'document',
      document.id,
      {
        versionId: version.id,
        version: version.version,
        effectiveOn,
        supersededVersionId: previous,
        nextReviewOn,
        acknowledgementsAsked: asked,
        byScheduledCheck: actorId === null,
      },
    );
    return { nextReviewOn, asked, notified };
  }

  /**
   * Asks everyone in the document's audience who has not been asked yet to
   * acknowledge this version, in one statement whatever their number, and
   * returns who was added. Two processes adding at once add each person
   * once: the second finds them there.
   */
  async assignAcknowledgements(
    tx: Transaction,
    tenantId: string,
    documentId: string,
    versionId: string,
    dueOn: string,
    now: Date,
  ) {
    const { rows } = await tx.execute<{ user_id: string }>(sql`
      insert into ${documentAcknowledgements} (tenant_id, version_id, user_id, assigned_at, due_on)
      select ${tenantId}, ${versionId}, ${users.id}, ${now.toISOString()}::timestamptz, ${dueOn}::date
      from ${users}
      where ${userInAudience(sql`${documentId}::uuid`)}
      on conflict (tenant_id, version_id, user_id) do nothing
      returning user_id`);
    return rows.map((r) => r.user_id);
  }
}
