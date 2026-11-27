import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  notifications,
  users,
  type NotificationData,
} from '../database/schema.js';
import { AccessService } from '../identity/access.service.js';
import type { Permission } from '../identity/permissions.js';
import type { ModuleCode, ModuleKey } from '../subscriptions/modules.js';
import { isSerious, type HarmLevel } from './status.js';

export type NotificationKind = (typeof notifications.kind.enumValues)[number];

/**
 * The module each kind of notification belongs to. A client without the
 * module is never sent one (its routes and checks do not run), and is not
 * shown the ones it was sent before: they are back when the module is. A
 * new kind must say here where it belongs.
 */
export const NOTIFICATION_MODULE: Record<NotificationKind, ModuleKey> = {
  incident_reported: 'incidents',
  incident_assigned: 'incidents',
  incident_handed_over: 'incidents',
  comment_added: 'incidents',
  status_changed: 'incidents',
  sign_off_requested: 'incidents',
  sign_off_decided: 'incidents',
  due_soon: 'incidents',
  overdue: 'incidents',
  sentinel_flagged: 'incidents',
  public_form_paused: 'incidents',
  document_step_assigned: 'policies',
  document_returned: 'policies',
  document_approved: 'policies',
  document_published: 'policies',
  acknowledgement_assigned: 'policies',
  acknowledgement_due: 'policies',
  acknowledgement_overdue: 'policies',
  review_due: 'policies',
  review_overdue: 'policies',
};

/** The kinds a client with these modules is shown. */
export const kindsInUse = (modules: readonly ModuleCode[]) =>
  (Object.keys(NOTIFICATION_MODULE) as NotificationKind[]).filter((kind) => {
    const module = NOTIFICATION_MODULE[kind];
    return module === 'core' || modules.includes(module);
  });

/**
 * How many values one statement is sent with at most. The driver numbers a
 * statement's parameters with 16 bits, so one carrying more than 65,535 of
 * them cannot be sent at all; a notification takes five. A batch of the
 * deadline check can name far more people than that, so what is written or
 * asked about a list of people goes in pieces of this size.
 */
export const ROWS_PER_STATEMENT = 1000;

/** A list cut into pieces of at most `size`, in order. */
export function inChunks<T>(list: T[], size = ROWS_PER_STATEMENT): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}

/**
 * What the notifier needs to know of an incident, as it stands once the
 * change being announced has been made.
 */
export type Subject = {
  id: string;
  reference: string;
  orgUnitId: string;
  ownerUnitId: string | null;
  assignedTo: string | null;
  reportedBy: string | null;
  /** What makes it serious or not, which every notification says. */
  harmLevel: HarmLevel;
  isSentinel: boolean;
};

/** One kind of notification about an incident, and who it is meant for. */
export type Draft = {
  kind: NotificationKind;
  /**
   * What the notification carries besides the incident's reference: which
   * deadline, which outcome. Never a name, never free text.
   */
  data?: Record<string, string>;
  /** The people it is meant for. Empty places (null) are skipped. */
  to: Iterable<string | null>;
  /**
   * Who gets it instead when none of those can be told: for a deadline, the
   * people who may triage the incident when nobody is assigned to it or the
   * person assigned has left.
   */
  orElse?: Iterable<string | null>;
  /**
   * About something internal to those handling the incident, so only for
   * people who see all of it. Otherwise for anyone who sees it at all.
   */
  internal?: boolean;
};

/** The groups of people a notification can be addressed to. */
export type Who = {
  /** Everyone who may triage any of these units of the incident. */
  mayTriage(unitIds: (string | null)[]): Set<string>;
  /** Everyone who may triage for the whole organization. */
  mayTriageEverywhere(): Set<string>;
  /**
   * Everyone a handover brings to the incident, through the department it
   * has been handed to:
   *
   * - whose right to triage covers it now and did not cover it before,
   *   through the unit where it happened or the department that handled it
   *   until then;
   * - whose right to view covers it now, and who before could neither view
   *   nor triage it through either of those: the department's managers,
   *   whom nothing told of the incident until now.
   *
   * Those it covered before were told of the incident when it was reported
   * or handed to them, or could already open it. Nobody, when the change
   * being announced is not a handover.
   */
  newlyCovering(): Set<string>;
  /** Everyone who may sign off the closure of this incident. */
  maySignOff(): Set<string>;
};

export type Announcement = {
  incident: Subject;
  /**
   * For a handover only: the department that handled the incident until this
   * change, null when none did yet. Left out for any other change.
   */
  handedOverFrom?: string | null;
  /** The person whose action this is, who is not told of it. */
  actorId: string | null;
  /**
   * The notifications to send, most specific first: a person named in two
   * of them gets the first only.
   */
  drafts: (who: Who) => Draft[];
};

/**
 * Writes notifications. The one place that does, so that the rules about who
 * may be told hold for every kind:
 *
 * - Nobody is told of their own action.
 * - Nobody is told twice of one event.
 * - Nobody is told who could not open the incident: only active users who
 *   reported it, are assigned to it, or whose right to view or triage covers
 *   the unit where it happened or the department handling it. For something
 *   internal, the reporter's own sight of it is not enough.
 * - A notification holds the incident's reference and no name of anyone, so
 *   it cannot tell a handler who reported or who acted.
 *
 * Call it in the transaction that makes the change, with the incident as the
 * change leaves it.
 */
@Injectable()
export class Notifier {
  constructor(private readonly access: AccessService) {}

  /** Announces one event on one incident. Returns how many were told. */
  send(tx: Transaction, tenantId: string, announcement: Announcement) {
    return this.sendAll(tx, tenantId, [announcement]);
  }

  /**
   * Announces one event on each of several incidents, with two queries for
   * all of them however many people are involved: who holds which right over
   * which unit, and which of the people named are active.
   */
  async sendAll(tx: Transaction, tenantId: string, events: Announcement[]) {
    if (events.length === 0) return 0;
    const holders = await this.access.holders(
      tx,
      ['incidents.view', 'incidents.triage', 'incidents.sign_off'],
      events.flatMap((e) => [
        e.incident.orgUnitId,
        e.incident.ownerUnitId,
        e.handedOverFrom ?? null,
      ]),
    );
    const planned = events.map((event) => {
      const { incident } = event;
      const units = [incident.orgUnitId, incident.ownerUnitId];
      const fullAccess = new Set([
        ...holders.of('incidents.view', units),
        ...holders.of('incidents.triage', units),
      ]);
      if (incident.assignedTo) fullAccess.add(incident.assignedTo);
      const who: Who = {
        // Only ever about this incident's own units: a unit that is not one
        // of them is covered from the whole organization alone.
        mayTriage: (ids) => holders.of('incidents.triage', ids),
        mayTriageEverywhere: () => holders.everywhere('incidents.triage'),
        newlyCovering: () => {
          if (event.handedOverFrom === undefined) return new Set();
          const before = [incident.orgUnitId, event.handedOverFrom];
          const triagedBefore = holders.of('incidents.triage', before);
          const sawBefore = new Set([
            ...triagedBefore,
            ...holders.of('incidents.view', before),
          ]);
          return new Set([
            ...[...holders.of('incidents.triage', units)].filter(
              (id) => !triagedBefore.has(id),
            ),
            ...[...holders.of('incidents.view', units)].filter(
              (id) => !sawBefore.has(id),
            ),
          ]);
        },
        // The right to sign off does not by itself let anyone see the
        // incident; the check below drops those who cannot.
        maySignOff: () => holders.of('incidents.sign_off', units),
      };
      return { ...event, fullAccess, drafts: event.drafts(who) };
    });

    const named = new Set<string>();
    for (const { drafts } of planned) {
      for (const draft of drafts) {
        for (const id of [...draft.to, ...(draft.orElse ?? [])]) {
          if (id) named.add(id);
        }
      }
    }
    if (named.size === 0) return 0;
    const active = new Set<string>();
    for (const ids of inChunks([...named])) {
      const found = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, ids), eq(users.status, 'active')));
      for (const user of found) active.add(user.id);
    }

    const rows: (typeof notifications.$inferInsert)[] = [];
    for (const { incident, actorId, fullAccess, drafts } of planned) {
      const told = new Set<string>();
      const mayBeTold = (id: string | null, draft: Draft): id is string =>
        id !== null &&
        id !== actorId &&
        active.has(id) &&
        (fullAccess.has(id) || (!draft.internal && id === incident.reportedBy));
      for (const draft of drafts) {
        let recipients = [...new Set(draft.to)].filter((id) =>
          mayBeTold(id, draft),
        );
        if (recipients.length === 0 && draft.orElse) {
          recipients = [...new Set(draft.orElse)].filter((id) =>
            mayBeTold(id, draft),
          );
        }
        for (const userId of recipients) {
          if (userId === null || told.has(userId)) continue;
          told.add(userId);
          rows.push({
            tenantId,
            userId,
            kind: draft.kind,
            incidentId: incident.id,
            // Whether it is serious as it stands now, so that a death does
            // not read like a wet floor in a list of notifications.
            data: {
              ...draft.data,
              reference: incident.reference,
              serious: isSerious(incident),
            },
          });
        }
      }
    }
    // In the caller's transaction all the same: every piece is written or
    // none is.
    for (const chunk of inChunks(rows)) {
      await tx.insert(notifications).values(chunk);
    }
    return rows.length;
  }

  /**
   * Tells something about the hospital itself, not one of its incidents,
   * to everyone who holds one of these rights for the whole organization.
   * Active users only. The notification carries no incident, and `data`
   * says whether it is serious like every other.
   */
  async tellHospital(
    tx: Transaction,
    tenantId: string,
    kind: NotificationKind,
    data: Record<string, string | number>,
    everywhere: Permission[],
  ) {
    const holders = await this.access.holders(tx, everywhere, []);
    const to = new Set(everywhere.flatMap((p) => [...holders.everywhere(p)]));
    if (to.size === 0) return 0;
    const rows = [...to].map((userId) => ({
      tenantId,
      userId,
      kind,
      incidentId: null,
      data: { ...data, serious: false } satisfies NotificationData,
    }));
    for (const chunk of inChunks(rows)) {
      await tx.insert(notifications).values(chunk);
    }
    return rows.length;
  }
}
