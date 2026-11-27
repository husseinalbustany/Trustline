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
 * Whether an anonymous reporter may still write to an incident with their
 * follow-up code: until it has ended, closed or not taken forward. After
 * that the code still reads it, and a reopened incident takes their comments
 * again. (Staff who are signed in may comment on an ended incident as
 * before: they can be held to what they write there.)
 */
export const takesCommentsByCode = (status: IncidentStatus) =>
  OPEN_STATUSES.includes(status);

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
 * another signs that off. Decided from what the incident is now; see
 * `needsSignOff` for what it has been.
 */
export const callsForSignOff = (incident: Gravity) =>
  incident.isSentinel || incident.harmLevel === 'death';

/**
 * Whether the harm level an incident carries was given by a member of
 * staff: a signed-in reporter, or a triager. The sender of a report through
 * the public link may be anyone with the link, and their grade is theirs
 * alone until a triager has looked at it (`firstTriagedAt`). The database
 * trigger on `incidents` (migration 0030) holds the same rule.
 */
export const gradedByStaff = (incident: {
  channel: 'app' | 'public';
  firstTriagedAt: Date | null;
}) => incident.channel !== 'public' || incident.firstTriagedAt !== null;

/** An incident with its memory of having called for sign-off. */
export type Weighed = Gravity & {
  /** Stored once it has been a sentinel event or a death; never cleared. */
  signOffNeeded: boolean;
  /** See `gradedByStaff()`. */
  graded: boolean;
};

/**
 * Whether closing this incident takes two people. Once it has, it always
 * does: lowering the harm level or clearing the sentinel flag afterwards
 * does not remove the second signature, or one person with the right to
 * triage could close a sentinel event alone by first calling it something
 * else. What a public sender chose does not count until a triager has
 * graded the report.
 */
export const needsSignOff = (incident: Weighed) =>
  incident.signOffNeeded || (incident.graded && callsForSignOff(incident));

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
  /**
   * Whether the person must say which revision of the incident they were
   * looking at. Required where they put their name to what they read: a
   * signature on a closure summary that was replaced meanwhile is refused.
   */
  revision: 'required' | 'optional';
  /** Whether this incident can take the move at all. */
  fits: (incident: Standing) => boolean;
  /** Whether this person may make it. */
  by: (caller: Caller) => boolean;
};

/**
 * An incident as status moves see it: how serious it is and has been, where
 * it stands, and whether a triager has ever decided on it. `triagedAt` is set
 * by triage only, never by setting a report aside, and is never cleared; so
 * a report in `new` has never been triaged, and stays that way when it goes
 * back there.
 */
type Standing = Weighed & { status: IncidentStatus; triagedAt: Date | null };

/** Whether a triager has decided on it at some point. */
const wasTriaged = (incident: Standing) => incident.triagedAt !== null;

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
    revision: 'optional',
    fits: always,
    by: triager,
  },
  {
    kind: 'close',
    from: ['triaged', 'in_progress'],
    to: 'closed',
    event: 'closed',
    note: 'required',
    revision: 'optional',
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
    revision: 'optional',
    fits: needsSignOff,
    by: triager,
  },
  {
    kind: 'sign_off',
    from: ['awaiting_sign_off'],
    to: 'closed',
    event: 'signed_off',
    note: 'optional',
    revision: 'required',
    fits: always,
    by: secondPerson,
  },
  {
    kind: 'send_back',
    from: ['awaiting_sign_off'],
    to: 'in_progress',
    event: 'sent_back',
    note: 'required',
    revision: 'optional',
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
    revision: 'optional',
    fits: always,
    by: (caller) => caller.isRequester || caller.canTriage,
  },
  {
    // Not taken forward: before triage, or after it when triage shows it is
    // a duplicate or not an incident at all. A serious report cannot be set
    // aside: its harm level has to be lowered at triage first, which leaves
    // a trace of who decided so. Nor one that has needed a second person to
    // close it: set aside by one, it would end without that signature.
    kind: 'reject',
    from: ['new', 'triaged'],
    to: 'rejected',
    event: 'rejected',
    note: 'required',
    revision: 'optional',
    fits: (incident) => !isSerious(incident) && !needsSignOff(incident),
    by: triager,
  },
  {
    // A closed incident is worked on again.
    kind: 'reopen',
    from: ['closed'],
    to: 'in_progress',
    event: 'reopened',
    note: 'required',
    revision: 'optional',
    fits: always,
    by: triager,
  },
  {
    // Set aside before anyone triaged it: it goes back to be triaged like
    // any new report, with a triage deadline counted from the reopening.
    // Sent on to `in_progress`, it would be worked on with no handling
    // department, no grade a triager gave, and nobody answerable for it.
    kind: 'reopen',
    from: ['rejected'],
    to: 'new',
    event: 'reopened',
    note: 'required',
    revision: 'optional',
    fits: (incident) => !wasTriaged(incident),
    by: triager,
  },
  {
    // Set aside after triage: the triage stands (its handling department,
    // grade and assignee were kept), so it goes back to where the setting
    // aside took it from. Only that decision is undone.
    kind: 'reopen',
    from: ['rejected'],
    to: 'triaged',
    event: 'reopened',
    note: 'required',
    revision: 'optional',
    fits: wasTriaged,
    by: triager,
  },
];

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

/**
 * Deadlines. An incident has two, both counted from when it was reported:
 * one to be triaged by and one to be closed by. Each matters only while the
 * incident is in a status where that work is still to be done.
 */
export const DEADLINES = ['triage', 'closure'] as const;
export type Deadline = (typeof DEADLINES)[number];

/**
 * The statuses in which each deadline is live. The triage deadline stops
 * mattering once the incident leaves `new`, by triage or by being set aside;
 * the closure deadline once it is `closed` or `rejected`. Reopening gives a
 * new closure deadline, counted from the reopening (`closeDueFrom`), and a
 * report set aside before triage goes back to `new` with a new triage
 * deadline counted from it too (`triageDueFrom`).
 */
export const DEADLINE_LIVE_IN: Record<Deadline, IncidentStatus[]> = {
  triage: ['new'],
  closure: ['triaged', 'in_progress', 'awaiting_sign_off'],
};

/** The deadline an incident in this status is working towards, if any. */
export const liveDeadline = (status: IncidentStatus): Deadline | null =>
  DEADLINES.find((d) => DEADLINE_LIVE_IN[d].includes(status)) ?? null;

type Timed = {
  status: IncidentStatus;
  triageDueAt: Date | null;
  closeDueAt: Date | null;
};

/** When the deadline an incident is working towards falls, if it has one. */
export const liveDueAt = (incident: Timed): Date | null => {
  const deadline = liveDeadline(incident.status);
  if (deadline === 'triage') return incident.triageDueAt;
  if (deadline === 'closure') return incident.closeDueAt;
  return null;
};

/**
 * Which deadline an incident has missed, as things stand at `now`: overdue
 * for triage when it is still `new` past its triage deadline, overdue for
 * closure when it is being worked on past its closure deadline. Worked out
 * whenever it is asked, never stored.
 */
export const overdueOf = (incident: Timed, now: Date): Deadline | null => {
  const due = liveDueAt(incident);
  return due && due.getTime() < now.getTime()
    ? liveDeadline(incident.status)
    : null;
};

/**
 * The share of the allowed time that is left when "due soon" is announced:
 * a quarter. For 72 hours to triage, 18 hours before the deadline.
 */
export const DUE_SOON_SHARE = 0.25;

/**
 * The response rule an incident falls under: the one for its harm level, and
 * for a sentinel event the one for a death, whatever its harm level.
 */
export const ruleLevelOf = (incident: Gravity): HarmLevel =>
  incident.isSentinel ? 'death' : incident.harmLevel;
