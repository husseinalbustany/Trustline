import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { actionEvents, actionNotes, actions, orgUnits, users } from '../database/schema.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { fitsLanguages, type LanguageSettings, type Localized } from '../i18n/locales.js';
import { dayOf } from '../i18n/time-zones.js';
import { nextReference } from '../incidents/reference.js';
import { ActionNotifier } from './action-notifier.js';
import type { CreateActionInput, UpdateActionInput } from './input.js';
import type { ActionSourceRules, ActionSourceType, SourceRecord } from './sources.js';

/**
 * Who is asking, as the source's module has worked it out: the engine
 * applies its rules to that, and knows nothing of permissions.
 */
export type ActionCaller = {
  tenant: { id: string; timeZone: string } & LanguageSettings;
  userId: string;
  /** Manages actions of this source record (for a risk: `risks.manage` over it). */
  manages: boolean;
  /** Owns the source record (a risk's owner). */
  ownsSource: boolean;
  suspended: boolean;
};

export const actionColumns = {
  id: actions.id,
  reference: actions.reference,
  sourceType: actions.sourceType,
  riskId: actions.riskId,
  title: actions.title,
  description: actions.description,
  ownerId: actions.ownerId,
  orgUnitId: actions.orgUnitId,
  dueOn: actions.dueOn,
  originalDueOn: actions.originalDueOn,
  strength: actions.strength,
  hierarchy: actions.hierarchy,
  status: actions.status,
  completedAt: actions.completedAt,
  completedBy: actions.completedBy,
  completionNote: actions.completionNote,
  effectiveness: actions.effectiveness,
  verifiedBy: actions.verifiedBy,
  verifiedAt: actions.verifiedAt,
  verificationNote: actions.verificationNote,
  cancelReason: actions.cancelReason,
  createdBy: actions.createdBy,
  createdAt: actions.createdAt,
  updatedAt: actions.updatedAt,
  revision: actions.revision,
};

export type ActionRow = Pick<typeof actions.$inferSelect, keyof typeof actionColumns>;

export type ActionMove = 'edit' | 'complete' | 'verify' | 'cancel' | 'reopen';

const OPEN = ['open', 'in_progress'] as const;
const isOpen = (status: string) => (OPEN as readonly string[]).includes(status);

/** Open, and past its due day. */
export const isOverdue = (a: { status: string; dueOn: string }, today: string) =>
  isOpen(a.status) && a.dueOn < today;

const forbidden = (code = 'missing_permission') => new ForbiddenException({ code });

/**
 * The shared actions engine (docs/specs/actions.md): one table and one set
 * of rules for every corrective and preventive action, whatever called for
 * it. It serves no routes: a module calls it in its own transaction, after
 * its own checks, with what it has worked out of the caller
 * (`ActionCaller`), and the engine applies the rules of the spec:
 *
 * - a manager of the source, or its owner, does everything;
 * - the action's owner marks it in progress, moves its due day with a
 *   reason, and completes it with a note;
 * - the effectiveness check is never the action's owner's (403
 *   `same_person`);
 * - every change takes the action's revision (409 `stale_action`), is
 *   written to its timeline and audited in the same transaction.
 */
@Injectable()
export class ActionsService {
  private readonly sources = new Map<ActionSourceType, ActionSourceRules>();

  constructor(
    private readonly provisioning: ProvisioningService,
    private readonly notifier: ActionNotifier,
  ) {}

  /** Called once by the module a source belongs to. */
  register(type: ActionSourceType, rules: ActionSourceRules) {
    this.sources.set(type, rules);
  }

  rulesOf(type: ActionSourceType) {
    const rules = this.sources.get(type);
    if (!rules) throw new Error(`No rules registered for actions of ${type}`);
    return rules;
  }

  /** The source types registered, with their rules. */
  registered() {
    return [...this.sources.entries()];
  }

  // Reading.

  /** What the caller may do next with an action. */
  movesFor(action: Pick<ActionRow, 'status' | 'ownerId' | 'completedBy'>, who: ActionCaller): ActionMove[] {
    const manager = who.manages || who.ownsSource;
    const owner = action.ownerId === who.userId;
    if (who.suspended) {
      return isOpen(action.status) && (manager || owner) ? ['complete'] : [];
    }
    if (isOpen(action.status)) {
      return [
        ...(manager || owner ? (['edit', 'complete'] as const) : []),
        ...(manager ? (['cancel'] as const) : []),
      ];
    }
    if (action.status === 'completed') {
      return [
        // Never by its owner, nor by whoever completed it (security review 17, L2).
        ...(manager && !owner && action.completedBy !== who.userId ? (['verify'] as const) : []),
        ...(manager ? (['reopen'] as const) : []),
      ];
    }
    return manager ? ['reopen'] : [];
  }

  /** An action as a screen shows it, with what the caller may do. */
  view(action: ActionRow, who: ActionCaller) {
    const today = dayOf(new Date(), who.tenant.timeZone);
    const manager = who.manages || who.ownsSource;
    return {
      ...action,
      overdue: isOverdue(action, today),
      dueMoved: action.dueOn !== action.originalDueOn,
      // What `edit` may change: everything for a manager, progress and the
      // due day for the action's owner.
      editable: manager ? ('all' as const) : action.ownerId === who.userId ? ('progress' as const) : null,
      moves: this.movesFor(action, who),
    };
  }

  /** The actions of one source record, oldest first. */
  listOf(tx: Transaction, type: ActionSourceType, sourceId: string) {
    return tx
      .select(actionColumns)
      .from(actions)
      .where(and(eq(actions.sourceType, type), type === 'risk' ? eq(actions.riskId, sourceId) : sql`false`))
      .orderBy(asc(actions.createdAt), asc(actions.id));
  }

  /** An action, locked for a change, or null. */
  async lock(tx: Transaction, id: string) {
    const [action] = await tx.select(actionColumns).from(actions).where(eq(actions.id, id)).for('update');
    return action ?? null;
  }

  /** An action's timeline, oldest first. */
  eventsOf(tx: Transaction, id: string) {
    return tx
      .select({
        id: actionEvents.id,
        kind: actionEvents.kind,
        actorId: actionEvents.actorId,
        occurredAt: actionEvents.occurredAt,
        details: actionEvents.details,
      })
      .from(actionEvents)
      .where(eq(actionEvents.actionId, id))
      .orderBy(asc(actionEvents.occurredAt), asc(actionEvents.id));
  }

  /**
   * "My actions": the person's open and in-progress actions, overdue and
   * due first.
   */
  mine(tx: Transaction, userId: string) {
    return tx
      .select(actionColumns)
      .from(actions)
      .where(and(eq(actions.ownerId, userId), inArray(actions.status, [...OPEN])))
      .orderBy(asc(actions.dueOn), asc(actions.reference))
      .limit(200);
  }

  // Checks on what a body names.

  private assertText(who: ActionCaller, title?: Localized, description?: Localized | null) {
    if (
      (title !== undefined && !fitsLanguages(title, who.tenant)) ||
      !fitsLanguages(description, who.tenant, { required: false })
    ) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
  }

  private async assertOwner(tx: Transaction, userId: string) {
    const [found] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.status, 'active')));
    if (!found) throw new BadRequestException({ code: 'unknown_owner' });
  }

  private async assertUnit(tx: Transaction, unitId: string | null) {
    if (unitId === null) return;
    const [found] = await tx
      .select({ id: orgUnits.id })
      .from(orgUnits)
      .where(and(eq(orgUnits.id, unitId), eq(orgUnits.active, true)));
    if (!found) throw new BadRequestException({ code: 'unknown_unit' });
  }

  /** 400 `due_in_past` for a due day before today. */
  private assertDue(who: ActionCaller, dueOn: string) {
    if (dueOn < dayOf(new Date(), who.tenant.timeZone)) {
      throw new BadRequestException({ code: 'due_in_past' });
    }
  }

  private async event(
    tx: Transaction,
    who: ActionCaller,
    actionId: string,
    kind: (typeof actionEvents.$inferInsert)['kind'],
    details: Record<string, unknown>,
  ) {
    await tx.insert(actionEvents).values({
      tenantId: who.tenant.id,
      actionId,
      kind,
      actorId: who.userId,
      details,
    });
  }

  private async after(tx: Transaction, id: string) {
    const [row] = await tx.select(actionColumns).from(actions).where(eq(actions.id, id));
    return row;
  }

  // Writing. Each in the caller's transaction, after its own checks.

  /** Adds an action to a source record, for a manager of it or its owner. */
  async create(
    tx: Transaction,
    who: ActionCaller,
    source: { type: ActionSourceType; record: SourceRecord },
    input: Omit<CreateActionInput, 'revision'>,
  ) {
    if (who.suspended) throw forbidden('subscription_suspended');
    if (!who.manages && !who.ownsSource) throw forbidden();
    this.assertText(who, input.title, input.description);
    this.assertDue(who, input.dueOn);
    await this.assertOwner(tx, input.ownerId);
    const orgUnitId = input.orgUnitId === undefined ? source.record.orgUnitId : input.orgUnitId;
    await this.assertUnit(tx, orgUnitId);
    const today = dayOf(new Date(), who.tenant.timeZone);
    const reference = await nextReference(tx, who.tenant.id, 'ACT', Number(today.slice(0, 4)));
    const [created] = await tx
      .insert(actions)
      .values({
        tenantId: who.tenant.id,
        reference,
        sourceType: source.type,
        riskId: source.type === 'risk' ? source.record.id : null,
        title: input.title,
        description: input.description,
        ownerId: input.ownerId,
        orgUnitId,
        dueOn: input.dueOn,
        // Set by the database to the due day, whatever is sent.
        originalDueOn: input.dueOn,
        strength: input.strength,
        hierarchy: input.hierarchy,
        createdBy: who.userId,
      })
      .returning(actionColumns);
    const details = {
      reference,
      sourceType: source.type,
      sourceId: source.record.id,
      ownerId: created.ownerId,
      orgUnitId,
      dueOn: created.dueOn,
      strength: created.strength,
      hierarchy: created.hierarchy,
    };
    await this.event(tx, who, created.id, 'created', details);
    await this.provisioning.audit(tx, who.tenant.id, who.userId, 'action_created', 'action', created.id, details);
    await this.notifier.send(tx, who.tenant.id, created, source.record, who.userId, [
      { kind: 'action_assigned', to: [created.ownerId], data: { dueOn: created.dueOn } },
    ]);
    return created;
  }

  private assertFresh(action: ActionRow, revision: number) {
    if (action.revision !== revision) throw new ConflictException({ code: 'stale_action' });
  }

  /**
   * Changes an action. A manager changes anything; the action's owner only
   * its progress and its due day. A new due day needs a reason (400
   * `reason_required`), is audited as `action_due_changed`, and keeps the
   * first one. Only an open action changes (409 `action_not_open`).
   */
  async update(
    tx: Transaction,
    who: ActionCaller,
    action: ActionRow,
    source: SourceRecord,
    input: UpdateActionInput,
  ) {
    const manager = who.manages || who.ownsSource;
    const owner = action.ownerId === who.userId;
    if (!manager && !owner) throw forbidden();
    this.assertFresh(action, input.revision);
    if (!isOpen(action.status)) throw new ConflictException({ code: 'action_not_open' });
    const { revision: _revision, reason, ...fields } = input;
    const changed = Object.fromEntries(
      Object.entries(fields).filter(
        ([k, v]) =>
          v !== undefined &&
          JSON.stringify(v) !== JSON.stringify(action[k as keyof ActionRow] ?? null),
      ),
    ) as Partial<typeof fields>;
    if (Object.keys(changed).length === 0) return action;
    if (!manager && Object.keys(changed).some((k) => k !== 'status' && k !== 'dueOn')) {
      throw forbidden();
    }
    if (changed.dueOn !== undefined) {
      if (!reason) throw new BadRequestException({ code: 'reason_required' });
      this.assertDue(who, changed.dueOn);
    }
    this.assertText(who, changed.title, changed.description);
    if (changed.ownerId) await this.assertOwner(tx, changed.ownerId);
    if (changed.orgUnitId !== undefined) await this.assertUnit(tx, changed.orgUnitId);
    await tx
      .update(actions)
      .set({ ...changed, revision: sql`${actions.revision} + 1`, updatedAt: new Date() })
      .where(eq(actions.id, action.id));
    const { dueOn, ...rest } = changed;
    // Text people write is never copied into the trail or the timeline
    // (security review 15, M1): only that it changed.
    const fromTo = Object.fromEntries(
      Object.entries(rest).map(([k, v]) => [
        k,
        k === 'title' || k === 'description'
          ? { changed: true }
          : { from: action[k as keyof ActionRow] ?? null, to: v },
      ]),
    );
    if (Object.keys(fromTo).length > 0) {
      await this.event(tx, who, action.id, 'updated', fromTo);
      await this.provisioning.audit(tx, who.tenant.id, who.userId, 'action_updated', 'action', action.id, fromTo);
    }
    if (dueOn !== undefined) {
      // The reason stays on the record, correctable, named by its id
      // (security review 17, L5): never in the trail or the timeline.
      const noteId = await this.note(tx, who, action.id, 'due_change_reason', reason!);
      const due = { from: action.dueOn, to: dueOn, noteId, originalDueOn: action.originalDueOn };
      await this.event(tx, who, action.id, 'due_changed', due);
      await this.provisioning.audit(tx, who.tenant.id, who.userId, 'action_due_changed', 'action', action.id, due);
    }
    if (changed.ownerId) {
      await this.notifier.send(tx, who.tenant.id, action, source, who.userId, [
        { kind: 'action_assigned', to: [changed.ownerId], data: { dueOn: dueOn ?? action.dueOn } },
      ]);
    }
    return this.after(tx, action.id);
  }

  /** Completes an open action with a note of what was done. */
  async complete(tx: Transaction, who: ActionCaller, action: ActionRow, source: SourceRecord, input: { revision: number; note: string }) {
    if (!(who.manages || who.ownsSource || action.ownerId === who.userId)) throw forbidden();
    this.assertFresh(action, input.revision);
    if (!isOpen(action.status)) throw new ConflictException({ code: 'action_not_open' });
    const now = new Date();
    await tx
      .update(actions)
      .set({
        status: 'completed',
        completedAt: now,
        completedBy: who.userId,
        completionNote: input.note,
        revision: sql`${actions.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(actions.id, action.id));
    const today = dayOf(now, who.tenant.timeZone);
    const details = { from: action.status, onTime: action.dueOn >= today, dueOn: action.dueOn };
    await this.event(tx, who, action.id, 'completed', { ...details, noteGiven: true });
    await this.provisioning.audit(tx, who.tenant.id, who.userId, 'action_completed', 'action', action.id, details);
    await this.notifier.send(tx, who.tenant.id, action, source, who.userId, [
      { kind: 'action_completed', to: [source.ownerId] },
    ]);
    return this.after(tx, action.id);
  }

  /**
   * The effectiveness check of a completed action, by a manager of the
   * source or its owner, never by the action's owner (403 `same_person`).
   */
  async verify(
    tx: Transaction,
    who: ActionCaller,
    action: ActionRow,
    input: { revision: number; outcome: 'effective' | 'not_effective'; note?: string },
  ) {
    if (!who.manages && !who.ownsSource) throw forbidden();
    if (action.ownerId === who.userId || action.completedBy === who.userId) throw forbidden('same_person');
    this.assertFresh(action, input.revision);
    if (action.status !== 'completed') throw new ConflictException({ code: 'action_not_completed' });
    const now = new Date();
    await tx
      .update(actions)
      .set({
        status: 'verified',
        effectiveness: input.outcome,
        verifiedBy: who.userId,
        verifiedAt: now,
        verificationNote: input.note ?? null,
        revision: sql`${actions.revision} + 1`,
        updatedAt: now,
      })
      .where(eq(actions.id, action.id));
    await this.event(tx, who, action.id, 'verified', { outcome: input.outcome, noteGiven: !!input.note });
    await this.provisioning.audit(tx, who.tenant.id, who.userId, 'action_verified', 'action', action.id, {
      outcome: input.outcome,
    });
    return this.after(tx, action.id);
  }

  /** Cancels an open action, with a reason, for a manager. */
  async cancel(tx: Transaction, who: ActionCaller, action: ActionRow, input: { revision: number; reason: string }) {
    if (!who.manages && !who.ownsSource) throw forbidden();
    this.assertFresh(action, input.revision);
    if (!isOpen(action.status)) throw new ConflictException({ code: 'action_not_open' });
    await tx
      .update(actions)
      .set({ status: 'cancelled', cancelReason: input.reason, revision: sql`${actions.revision} + 1`, updatedAt: new Date() })
      .where(eq(actions.id, action.id));
    const details = { from: action.status, reasonGiven: true };
    await this.event(tx, who, action.id, 'cancelled', details);
    await this.provisioning.audit(tx, who.tenant.id, who.userId, 'action_cancelled', 'action', action.id, details);
    return this.after(tx, action.id);
  }

  /**
   * Reopens a completed, verified or cancelled action, with a reason, for a
   * manager. Its last completion note, outcome and reason stay on it until
   * it is completed or cancelled again; the timeline says what happened,
   * without the text.
   */
  async reopen(tx: Transaction, who: ActionCaller, action: ActionRow, input: { revision: number; reason: string }) {
    if (!who.manages && !who.ownsSource) throw forbidden();
    this.assertFresh(action, input.revision);
    if (isOpen(action.status)) throw new ConflictException({ code: 'action_open' });
    await tx
      .update(actions)
      .set({ status: 'open', revision: sql`${actions.revision} + 1`, updatedAt: new Date() })
      .where(eq(actions.id, action.id));
    const noteId = await this.note(tx, who, action.id, 'reopen_reason', input.reason);
    const details = { from: action.status, noteId, effectiveness: action.effectiveness };
    await this.event(tx, who, action.id, 'reopened', details);
    await this.provisioning.audit(tx, who.tenant.id, who.userId, 'action_reopened', 'action', action.id, {
      from: action.status,
      noteId,
    });
    return this.after(tx, action.id);
  }

  /** Writes a reason on the record, correctable, and returns its id. */
  private async note(
    tx: Transaction,
    who: ActionCaller,
    actionId: string,
    kind: 'due_change_reason' | 'reopen_reason',
    text: string,
  ) {
    const [row] = await tx
      .insert(actionNotes)
      .values({ tenantId: who.tenant.id, actionId, kind, text, writtenBy: who.userId })
      .returning({ id: actionNotes.id });
    return row.id;
  }

  /** The reasons written on an action, oldest first. */
  notesOf(tx: Transaction, actionId: string) {
    return tx
      .select({
        id: actionNotes.id,
        kind: actionNotes.kind,
        text: actionNotes.text,
        writtenBy: actionNotes.writtenBy,
        writtenAt: actionNotes.writtenAt,
        correctedAt: actionNotes.correctedAt,
      })
      .from(actionNotes)
      .where(eq(actionNotes.actionId, actionId))
      .orderBy(asc(actionNotes.writtenAt), asc(actionNotes.id));
  }

  /**
   * Corrects text written on an action, for a manager of the source, at any
   * status (security reviews 15, M1, and 17, L4 and L5): what was done, the
   * effectiveness note, the reason it was cancelled, its title and
   * description (a finished action is not otherwise edited), and a reason
   * kept as a note (`note`, with its id). So that a detail of a person typed
   * by mistake can be taken out. Audited and written to the timeline as
   * which was corrected, never the text. 409 `nothing_to_correct` for a
   * note the action does not have; 404 for a note of another action.
   */
  async correct(
    tx: Transaction,
    who: ActionCaller,
    action: ActionRow,
    input:
      | { revision: number; field: 'completionNote' | 'verificationNote' | 'cancelReason'; text: string }
      | { revision: number; field: 'title' | 'description'; text: Localized }
      | { revision: number; field: 'note'; noteId: string; text: string },
  ) {
    if (!who.manages && !who.ownsSource) throw forbidden();
    this.assertFresh(action, input.revision);
    let details: Record<string, unknown> = { field: input.field };
    if (input.field === 'note') {
      const done = await tx
        .update(actionNotes)
        .set({ text: input.text, correctedBy: who.userId, correctedAt: new Date() })
        .where(and(eq(actionNotes.id, input.noteId), eq(actionNotes.actionId, action.id)))
        .returning({ id: actionNotes.id });
      if (done.length === 0) throw new NotFoundException();
      details = { ...details, noteId: input.noteId };
    } else {
      if (input.field === 'title' || input.field === 'description') {
        this.assertText(who, input.field === 'title' ? input.text : undefined, input.field === 'description' ? input.text : undefined);
      } else if (action[input.field] === null) {
        throw new ConflictException({ code: 'nothing_to_correct' });
      }
      await tx
        .update(actions)
        .set({ [input.field]: input.text, updatedAt: new Date() })
        .where(eq(actions.id, action.id));
    }
    await tx.update(actions).set({ revision: sql`${actions.revision} + 1` }).where(eq(actions.id, action.id));
    await this.event(tx, who, action.id, 'text_corrected', details);
    await this.provisioning.audit(tx, who.tenant.id, who.userId, 'action_text_corrected', 'action', action.id, details);
    return this.after(tx, action.id);
  }

  /** The newest first, for a source's page: the counts a screen shows. */
  static summaryOf(list: ActionRow[], today: string) {
    const open = list.filter((a) => isOpen(a.status));
    return {
      open: open.length,
      overdue: open.filter((a) => a.dueOn < today).length,
      // Every open action of the treatment is weaker: the strength check.
      allWeaker: open.length > 0 && open.every((a) => a.strength === 'weaker'),
    };
  }
}
