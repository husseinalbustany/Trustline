import { Injectable } from '@nestjs/common';
import type { AuthContext } from '../identity/auth.service.js';
import { IncidentsService } from '../incidents/incidents.service.js';
import { LibraryService } from '../policies/library.service.js';
import { RiskWorkService } from '../risks/work.service.js';
import { READ_PERMISSIONS } from '../policies/visibility.js';
import { DIGEST_ITEMS, type DigestSection } from './render.js';

/** A path in the web app, in the recipient's language, as a full link. */
export type LinkTo = (path: string) => string;

/**
 * What waits for one person, for their daily digest (docs/specs/email.md,
 * section 1): the same lists their screens show them, asked of the services
 * that show them, as that person (BackgroundContext), so that
 * the digest can hold nothing they could not see. References and counts
 * only: each item is a number or a reference and a link.
 *
 * `safetyOnly` while the subscription is suspended: incidents and
 * documents to acknowledge, not approvals or reviews.
 */
@Injectable()
export class DigestService {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly library: LibraryService,
    private readonly risks: RiskWorkService,
  ) {}

  async sectionsFor(
    auth: AuthContext,
    link: LinkTo,
    safetyOnly: boolean,
  ): Promise<DigestSection[]> {
    const { modules } = auth.tenant;
    const sections: DigestSection[] = [];
    const reads = READ_PERMISSIONS.some((p) => auth.permissions.includes(p));

    if (modules.includes('policies') && reads) {
      const awaiting = await this.library.list(auth, {
        appliesToMe: false,
        awaitingMyAcknowledgement: true,
        reissueDue: false,
        sort: 'number',
        page: 1,
        pageSize: DIGEST_ITEMS,
      });
      if (awaiting.total > 0) {
        sections.push({
          key: 'acknowledge',
          count: awaiting.total,
          items: awaiting.items.map((d) => ({
            label: d.number,
            href: link(`/policies/${d.id}`),
            overdue: d.myAcknowledgement?.overdue === true,
          })),
        });
      }
    }

    if (
      modules.includes('policies') &&
      !safetyOnly &&
      auth.permissions.includes('policies.approve')
    ) {
      const steps = await this.library.myApprovals(auth);
      // With the "no change" reviews awaiting their signature (business
      // decision 6).
      const total = steps.total + steps.reviews.length;
      if (total > 0) {
        sections.push({
          key: 'approve',
          count: total,
          items: [
            ...steps.items.map((s) => ({
              label: s.document.number,
              href: link(`/policies/${s.document.id}/versions/${s.version.id}`),
              overdue: s.overdue,
            })),
            ...steps.reviews.map((r) => ({
              label: r.number,
              href: link(`/policies/${r.documentId}`),
            })),
          ].slice(0, DIGEST_ITEMS),
        });
      }
    }

    // For those who manage documents: the approval steps overdue on the
    // documents they manage (quality review 3, S2), so that a stalled
    // approval reaches someone who rarely signs in.
    if (
      modules.includes('policies') &&
      !safetyOnly &&
      auth.permissions.includes('policies.manage')
    ) {
      const steps = await this.library.overdueSteps(auth);
      if (steps.total > 0) {
        sections.push({
          key: 'stepsOverdue',
          count: steps.total,
          items: steps.items.slice(0, DIGEST_ITEMS).map((s) => ({
            label: s.document.number,
            href: link(`/policies/${s.document.id}/versions/${s.version.id}`),
            overdue: true,
          })),
        });
      }
    }

    if (modules.includes('policies') && !safetyOnly && reads) {
      const reviews = await this.library.reviewsDue(auth);
      // Their own documents ahead of time, as the reminders do; and, for
      // those who manage documents, the ones whose review has passed.
      const theirs = reviews.items.filter((r) => r.mine || r.state === 'overdue');
      if (theirs.length > 0) {
        sections.push({
          key: 'reviews',
          count: theirs.length,
          items: theirs.slice(0, DIGEST_ITEMS).map((r) => ({
            label: r.number,
            href: link(`/policies/${r.id}`),
            overdue: r.state === 'overdue',
          })),
        });
      }
    }

    // Risks (risk management, "Notifications and email"): risks to review,
    // actions due and, for managers, proposals. Reviews and proposals wait
    // while suspended; completing an action is safety work and stays.
    if (modules.includes('risks')) {
      const waiting = await this.risks.digestFor(auth);
      if (!safetyOnly && waiting.reviews.length > 0) {
        sections.push({
          key: 'riskReviews',
          count: waiting.reviews.length,
          items: waiting.reviews.slice(0, DIGEST_ITEMS).map((r) => ({
            label: r.reference,
            href: link(`/risks/${r.id}`),
            overdue: r.overdue,
          })),
        });
      }
      if (waiting.actions.length > 0) {
        sections.push({
          key: 'actionsDue',
          count: waiting.actions.length,
          overdueCount: waiting.actions.filter((a) => a.overdue).length,
          items: waiting.actions.slice(0, DIGEST_ITEMS).map((a) => ({
            label: a.reference,
            href: link(`/risks/${a.riskId}`),
            overdue: a.overdue,
          })),
        });
      }
      // Steps to sign wait while suspended, as for documents.
      if (!safetyOnly && waiting.steps.length > 0) {
        sections.push({
          key: 'riskSteps',
          count: waiting.steps.length,
          items: waiting.steps.slice(0, DIGEST_ITEMS).map((r) => ({
            label: r.reference,
            href: link(`/risks/${r.riskId}`),
            overdue: r.overdue,
          })),
        });
      }
      if (!safetyOnly && waiting.proposals.length > 0) {
        sections.push({
          key: 'riskProposals',
          count: waiting.proposals.length,
          items: waiting.proposals.slice(0, DIGEST_ITEMS).map((r) => ({
            label: r.reference,
            href: link(`/risks/${r.id}`),
          })),
        });
      }
    }

    if (modules.includes('incidents')) {
      const mine = {
        open: true,
        serious: false,
        assignedToMe: true,
        mine: false,
        sort: 'due' as const,
        page: 1,
      };
      const assigned = await this.incidents.list(auth, {
        ...mine,
        overdue: false,
        pageSize: DIGEST_ITEMS,
      });
      if (assigned.total > 0) {
        const late = await this.incidents.list(auth, {
          ...mine,
          overdue: true,
          pageSize: 1,
        });
        sections.push({
          key: 'incidents',
          count: assigned.total,
          overdueCount: late.total,
          items: assigned.items.map((i) => ({
            label: i.reference,
            href: link(`/incidents/${i.id}`),
            overdue: i.overdue !== null,
          })),
        });
      }
    }
    return sections;
  }
}
