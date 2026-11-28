/**
 * What a reader may do next with a risk, so that no screen keeps a copy of
 * the rules (docs/specs/risk-management.md, "API outline", `moves`): steps
 * 1 to 7 of the order of build.
 *
 * - `edit`: change its details (a manager);
 * - `rate`: give an inherent, current or target rating (its owner, on the
 *   register; a manager). While an acceptance is in approval the current
 *   rating is fixed (409 `acceptance_in_progress`);
 * - `add_control`: add a control, and change or switch off one (as `rate`);
 * - `review`: record a review (its owner, a manager, or a member of the
 *   committee it is escalated to, for the committee);
 * - `add_action`: add an action (its owner or a manager);
 * - `escalate`, `de_escalate`: before a committee by hand (a manager), and
 *   off its list (a member, or a manager for the whole organization) once
 *   its band is below the committee's threshold;
 * - `correct`: correct a rationale, a comment or a reason written on it (a
 *   manager);
 * - `link_incident`: link an incident (a manager, with the incidents module);
 * - `request_acceptance`, `withdraw_acceptance`, `approve_acceptance`,
 *   `return_acceptance`: an acceptance above tolerance and its steps;
 * - `close` (no second signature needed) or `request_closure` (one is),
 *   `approve_closure`, `return_closure`, `reopen`;
 * - `accept_proposal`, `reject_proposal`: take a proposed risk onto the
 *   register, or not (a manager; not the one who raised it, for accepting).
 *
 * While the subscription is suspended, only safety work stays open
 * (business decision 16): recording a current rating (`rate`, for the kind
 * `current` only) and escalating (`escalate`).
 */
export type RiskMove =
  | 'edit'
  | 'rate'
  | 'add_control'
  | 'review'
  | 'add_action'
  | 'escalate'
  | 'de_escalate'
  | 'correct'
  | 'link_incident'
  | 'request_acceptance'
  | 'withdraw_acceptance'
  | 'approve_acceptance'
  | 'return_acceptance'
  | 'close'
  | 'request_closure'
  | 'approve_closure'
  | 'return_closure'
  | 'reopen'
  | 'accept_proposal'
  | 'reject_proposal';

/** What the approvals and links allow the reader now, worked out by the caller. */
export type ApprovalMoves = {
  requestAcceptance: boolean;
  withdrawAcceptance: boolean;
  decideAcceptance: boolean;
  /** Closure is open to the reader: `close` or `request_closure`. */
  close: 'close' | 'request_closure' | null;
  decideClosure: boolean;
  closureRequested: boolean;
  reopen: boolean;
  linkIncident: boolean;
  /** An acceptance is in approval: its current rating is fixed, so no review. */
  acceptancePending: boolean;
};

const NONE: ApprovalMoves = {
  requestAcceptance: false,
  withdrawAcceptance: false,
  decideAcceptance: false,
  close: null,
  decideClosure: false,
  closureRequested: false,
  reopen: false,
  linkIncident: false,
  acceptancePending: false,
};

export function movesFor(
  risk: { status: string; createdBy: string },
  role: {
    manager: boolean;
    owner: boolean;
    member: boolean;
    userId: string;
    /** May take it off its committee's list now. */
    deEscalate: boolean;
  },
  suspended: boolean,
  approvals: ApprovalMoves = NONE,
): RiskMove[] {
  const works = role.manager || role.owner;
  if (suspended) {
    if (risk.status !== 'open') return [];
    return [...(works ? (['rate'] as const) : []), ...(role.manager ? (['escalate'] as const) : [])];
  }
  if (risk.status === 'open' && approvals.closureRequested) {
    // While a closure waits for its signature, the risk waits too.
    return [
      ...(approvals.decideClosure ? (['approve_closure', 'return_closure'] as const) : []),
      ...(role.manager ? (['escalate', 'correct'] as const) : []),
    ];
  }
  if (risk.status === 'open') {
    return [
      ...(role.manager ? (['edit'] as const) : []),
      ...(works ? (['rate', 'add_control'] as const) : []),
      ...((works || role.member) && !approvals.acceptancePending ? (['review'] as const) : []),
      ...(works ? (['add_action'] as const) : []),
      ...(role.manager ? (['escalate'] as const) : []),
      ...(role.deEscalate ? (['de_escalate'] as const) : []),
      ...(approvals.linkIncident ? (['link_incident'] as const) : []),
      ...(approvals.requestAcceptance ? (['request_acceptance'] as const) : []),
      ...(approvals.withdrawAcceptance ? (['withdraw_acceptance'] as const) : []),
      ...(approvals.decideAcceptance ? (['approve_acceptance', 'return_acceptance'] as const) : []),
      ...(approvals.close ? [approvals.close] : []),
      ...(role.manager ? (['correct'] as const) : []),
    ];
  }
  if (risk.status === 'proposed' && role.manager) {
    return [
      'edit',
      'rate',
      'add_control',
      'correct',
      ...(risk.createdBy !== role.userId ? (['accept_proposal'] as const) : []),
      'reject_proposal',
    ];
  }
  if (risk.status === 'closed') {
    return [...(approvals.reopen ? (['reopen'] as const) : []), ...(role.manager ? (['correct'] as const) : [])];
  }
  return role.manager ? ['correct'] : [];
}
