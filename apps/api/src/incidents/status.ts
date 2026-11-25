import type { incidentEvents, incidents } from '../database/schema.js';

export type IncidentStatus = (typeof incidents.status.enumValues)[number];
export type HarmLevel = (typeof incidents.harmLevel.enumValues)[number];
export type EventKind = (typeof incidentEvents.kind.enumValues)[number];

/**
 * Every rule about where an incident stands and where it may go next lives in
 * this file: which statuses count as open, which allow triage, and who may
 * make which move. Nothing else compares statuses, so a rule that changes,
 * changes here.
 */

/** Not yet ended: someone still has work to do on it. */
export const OPEN_STATUSES: IncidentStatus[] = [
  'new',
  'triaged',
  'in_progress',
  'awaiting_sign_off',
];

/**
 * An incident can be triaged, and triaged again, until it has ended. Not
 * while it awaits sign-off: what the second person signs must not change
 * under them.
 */
export const TRIAGE_FROM: IncidentStatus[] = ['new', 'triaged', 'in_progress'];

export const SERIOUS_HARM: HarmLevel[] = ['severe', 'death'];

type Gravity = { harmLevel: HarmLevel; isSentinel: boolean };

/** Severe harm, a death, or a sentinel event: never set aside unexamined. */
export const isSerious = (incident: Gravity) =>
  incident.isSentinel || SERIOUS_HARM.includes(incident.harmLevel);

/**
 * A sentinel event or a death: one person asks for it to be closed and
 * another signs that off.
 */
export const needsSignOff = (incident: Gravity) =>
  incident.isSentinel || incident.harmLevel === 'death';

/**
 * What a move is, whatever status it leads to. A screen labels its button by
 * it, and a caller names it where the status it leads to does not say enough:
 * sending a closure request back and withdrawing it both lead to
 * `in_progress`.
 */
export const MOVE_KINDS = [
  'start',
  'close',
  'reject',
  'reopen',
  'request_sign_off',
  'sign_off',
  'send_back',
  'withdraw',
] as const;
export type MoveKind = (typeof MOVE_KINDS)[number];

/** What one person may do on one incident, as far as status goes. */
export type Caller = {
  /** Holds the right to triage, covering this incident. */
  canTriage: boolean;
  /** Holds the right to sign off, covering this incident. */
  canSignOff: boolean;
  /** Asked for the closure this incident is now waiting on. */
  isRequester: boolean;
};

export type Move = {
  kind: MoveKind;
  from: IncidentStatus[];
  to: IncidentStatus;
  /** The timeline entry it leaves. */
  event: EventKind;
  /** Whether the person must explain the change. */
  note: 'required' | 'optional';
  /** Whether this incident can take the move at all. */
  fits: (incident: Gravity) => boolean;
  /** Whether this person may make it. */
  by: (caller: Caller) => boolean;
};

const always = () => true;
const triager = (caller: Caller) => caller.canTriage;
/** The second person: holds the right, and is not the one who asked. */
const secondPerson = (caller: Caller) =>
  caller.canSignOff && !caller.isRequester;

/**
 * Every allowed change of status outside triage. Two moves lead from
 * `awaiting_sign_off` back to `in_progress`, and one person may be allowed
 * both: there the caller has to say which they mean.
 */
const MOVES: Move[] = [
  {
    kind: 'start',
    from: ['triaged'],
    to: 'in_progress',
    event: 'status_changed',
    note: 'optional',
    fits: always,
    by: triager,
  },
  {
    kind: 'close',
    from: ['triaged', 'in_progress'],
    to: 'closed',
    event: 'closed',
    note: 'required',
    fits: (incident) => !needsSignOff(incident),
    by: triager,
  },
  {
    // In place of closing: the note is the closure summary being proposed.
    kind: 'request_sign_off',
    from: ['triaged', 'in_progress'],
    to: 'awaiting_sign_off',
    event: 'sign_off_requested',
    note: 'required',
    fits: needsSignOff,
    by: triager,
  },
  {
    kind: 'sign_off',
    from: ['awaiting_sign_off'],
    to: 'closed',
    event: 'signed_off',
    note: 'optional',
    fits: always,
    by: secondPerson,
  },
  {
    kind: 'send_back',
    from: ['awaiting_sign_off'],
    to: 'in_progress',
    event: 'sent_back',
    note: 'required',
    fits: always,
    by: secondPerson,
  },
  {
    // The request is taken back, by whoever made it or by anyone who may
    // triage the incident. Not a judgement on the closure, unlike `send_back`.
    kind: 'withdraw',
    from: ['awaiting_sign_off'],
    to: 'in_progress',
    event: 'status_changed',
    note: 'required',
    fits: always,
    by: (caller) => caller.isRequester || caller.canTriage,
  },
  {
    // A serious report cannot be set aside: its harm level has to be lowered
    // at triage first, which leaves a trace of who decided so.
    kind: 'reject',
    from: ['new'],
    to: 'rejected',
    event: 'rejected',
    note: 'required',
    fits: (incident) => !isSerious(incident),
    by: triager,
  },
  {
    kind: 'reopen',
    from: ['closed', 'rejected'],
    to: 'in_progress',
    event: 'reopened',
    note: 'required',
    fits: always,
    by: triager,
  },
];

type Standing = Gravity & { status: IncidentStatus };

/** The moves this person may make on this incident now. */
export const movesFor = (incident: Standing, caller: Caller): Move[] =>
  MOVES.filter(
    (m) => m.from.includes(incident.status) && m.fits(incident) && m.by(caller),
  );

/**
 * Whether this person has any say over the incident's status as it stands.
 * Asked before anything else, so that someone with no say learns nothing
 * about the incident from how a request is refused.
 */
export const hasSay = (incident: Standing, caller: Caller) =>
  incident.status === 'awaiting_sign_off'
    ? caller.canTriage || caller.canSignOff || caller.isRequester
    : caller.canTriage;

export type Refusal =
  | 'invalid_transition'
  | 'kind_required'
  | 'serious_cannot_be_rejected'
  | 'sign_off_required'
  | 'missing_triage_permission'
  | 'missing_sign_off_permission'
  | 'same_person';

/**
 * The move that takes this incident to `to` for this person, or why there is
 * none. Assumes `hasSay()`.
 *
 * `kind` says which move is meant. It may be left out where only one move
 * leads from the incident's status to `to`; where two do, it must be given.
 * When given it must be that of a move that leads there: one that does not
 * means the caller was looking at an incident in another status.
 */
export function chooseMove(
  incident: Standing,
  to: IncidentStatus,
  caller: Caller,
  kind?: MoveKind,
): Move | Refusal {
  const leading = MOVES.filter(
    (m) => m.to === to && m.from.includes(incident.status),
  );
  if (leading.length > 1 && !kind) return 'kind_required';
  const meant = kind ? leading.filter((m) => m.kind === kind) : leading;
  // At most one is left: no two moves share a status, a target and a kind.
  const move = meant.find((m) => m.fits(incident));
  if (!move) {
    if (meant.length === 0) return 'invalid_transition';
    if (to === 'rejected') return 'serious_cannot_be_rejected';
    // Closing outright what needs a second person.
    if (to === 'closed') return 'sign_off_required';
    return 'invalid_transition';
  }
  if (move.by(caller)) return move;
  // Has a say, but not this one. A decision for the second person: without
  // the right, or with it but having asked. Anything else is for a triager.
  if (move.kind !== 'sign_off' && move.kind !== 'send_back') {
    return 'missing_triage_permission';
  }
  return caller.canSignOff ? 'same_person' : 'missing_sign_off_permission';
}
