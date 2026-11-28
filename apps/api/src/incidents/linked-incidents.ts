import { Injectable } from '@nestjs/common';
import { and, count, eq, gte, inArray } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { incidentCategories, incidents } from '../database/schema.js';
import type { AuthContext } from '../identity/auth.service.js';
import type { Localized } from '../i18n/locales.js';
import { dayOf } from '../i18n/time-zones.js';
import { seenInFull, visibleTo } from './visibility.js';

/**
 * An incident as another module shows it where it links to one (a risk the
 * incident raised or supports: docs/specs/risk-management.md, "Links to
 * other modules"): its reference, type, category, unit, day, harm level and
 * status, and only to someone who sees it in full (`seenInFull`). Never who
 * reported it, how it arrived (`channel`: a public report is always
 * anonymous, so it would tell), or whether it was anonymous: the rules of
 * incident-safeguards-and-deadlines.md, section 1, hold wherever it is
 * shown.
 */
export type LinkedIncident = {
  id: string;
  reference: string;
  type: string;
  categoryId: string;
  orgUnitId: string;
  /** The day it happened, on the client's calendar. */
  occurredOn: string;
  harmLevel: string;
  status: string;
};

/** Named columns only: nothing about who reported it or how. */
const shown = {
  id: incidents.id,
  reference: incidents.reference,
  type: incidents.type,
  categoryId: incidents.categoryId,
  orgUnitId: incidents.orgUnitId,
  occurredAt: incidents.occurredAt,
  harmLevel: incidents.harmLevel,
  status: incidents.status,
};

/**
 * What the incidents module tells other modules of its incidents, in their
 * transaction: they read its tables only through here.
 */
@Injectable()
export class LinkedIncidents {
  /**
   * An incident `auth` sees in full, for linking it or raising a risk from
   * it, with what raising offers (its unit and harm level); null for one
   * they do not, of another client, or that does not exist, alike.
   */
  async forLinking(tx: Transaction, auth: AuthContext, id: string) {
    const [row] = await tx
      .select({ id: incidents.id, reference: incidents.reference, orgUnitId: incidents.orgUnitId, harmLevel: incidents.harmLevel })
      .from(incidents)
      .where(and(eq(incidents.id, id), seenInFull(auth)));
    return row ?? null;
  }

  /**
   * Of these incidents, those `auth` sees in full, as a linking page shows
   * them, with the names of their categories; and how many of the others
   * there are, with nothing else about them.
   */
  async describe(tx: Transaction, auth: AuthContext, ids: string[]) {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return { items: [] as LinkedIncident[], hidden: 0, categories: {} as Record<string, Localized> };
    const rows = await tx
      .select(shown)
      .from(incidents)
      .where(and(inArray(incidents.id, wanted), seenInFull(auth)));
    const categoryIds = [...new Set(rows.map((r) => r.categoryId))];
    const named = categoryIds.length
      ? await tx
          .select({ id: incidentCategories.id, name: incidentCategories.name })
          .from(incidentCategories)
          .where(inArray(incidentCategories.id, categoryIds))
      : [];
    return {
      items: rows.map(({ occurredAt, ...r }) => ({
        ...r,
        occurredOn: dayOf(occurredAt, auth.tenant.timeZone),
      })) as LinkedIncident[],
      // Those it holds that the reader may not open: a count, no more.
      hidden: wanted.length - rows.length,
      categories: Object.fromEntries(named.map((c) => [c.id, c.name])) as Record<string, Localized>,
    };
  }

  /** How many of these incidents happened since a moment: a plain signal, no detail. */
  async since(tx: Transaction, ids: string[], from: Date) {
    if (ids.length === 0) return 0;
    const [{ n }] = await tx
      .select({ n: count() })
      .from(incidents)
      .where(and(inArray(incidents.id, [...new Set(ids)]), gte(incidents.occurredAt, from)));
    return n;
  }

  /** Whether `auth` sees this incident at all (as on the incident's page). */
  async visible(tx: Transaction, auth: AuthContext, id: string) {
    const [row] = await tx.select({ id: incidents.id }).from(incidents).where(and(eq(incidents.id, id), visibleTo(auth)));
    return !!row;
  }
}
