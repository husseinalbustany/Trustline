import {
  chooseMove,
  hasSay,
  movesFor,
  needsSignOff,
  OPEN_STATUSES,
  TRIAGE_FROM,
  type Caller,
  type IncidentStatus,
} from './status.js';

const nobody: Caller = {
  canTriage: false,
  canSignOff: false,
  isRequester: false,
};
const triager: Caller = { ...nobody, canTriage: true };
const signer: Caller = { ...nobody, canSignOff: true };
const officer: Caller = { ...nobody, canTriage: true, canSignOff: true };
const requester: Caller = { ...officer, isRequester: true };

const ordinary = { harmLevel: 'mild', isSentinel: false } as const;
const sentinel = { harmLevel: 'severe', isSentinel: true } as const;
const at = <T extends object>(incident: T, status: IncidentStatus) => ({
  ...incident,
  status,
});

const offered = (
  incident: Parameters<typeof movesFor>[0],
  caller: Caller,
): string[] => movesFor(incident, caller).map((m) => `${m.action}>${m.to}`);

describe('incident status rules', () => {
  it('counts an incident awaiting sign-off as open, and not as triageable', () => {
    expect(OPEN_STATUSES).toEqual([
      'new',
      'triaged',
      'in_progress',
      'awaiting_sign_off',
    ]);
    expect(TRIAGE_FROM).not.toContain('awaiting_sign_off');
  });

  it('asks for a second person for a sentinel event and for a death, and nothing else', () => {
    expect(needsSignOff({ harmLevel: 'none', isSentinel: true })).toBe(true);
    expect(needsSignOff({ harmLevel: 'death', isSentinel: false })).toBe(true);
    expect(needsSignOff({ harmLevel: 'severe', isSentinel: false })).toBe(
      false,
    );
  });

  it('replaces closing by a request for sign-off where one is needed', () => {
    for (const status of ['triaged', 'in_progress'] as const) {
      expect(offered(at(ordinary, status), triager)).toContain('close>closed');
      expect(offered(at(sentinel, status), triager)).not.toContain(
        'close>closed',
      );
      expect(offered(at(sentinel, status), triager)).toContain(
        'request_sign_off>awaiting_sign_off',
      );
      expect(chooseMove(at(sentinel, status), 'closed', officer)).toBe(
        'sign_off_required',
      );
      expect(
        chooseMove(at(ordinary, status), 'awaiting_sign_off', officer),
      ).toBe('invalid_transition');
    }
  });

  it('offers each person awaiting sign-off exactly what they may do', () => {
    const waiting = at(sentinel, 'awaiting_sign_off');
    expect(offered(waiting, officer)).toEqual([
      'sign_off>closed',
      'send_back>in_progress',
    ]);
    // Without the right to triage, the second person can still decide.
    expect(offered(waiting, signer)).toEqual([
      'sign_off>closed',
      'send_back>in_progress',
    ]);
    expect(offered(waiting, requester)).toEqual(['withdraw>in_progress']);
    expect(offered(waiting, triager)).toEqual(['withdraw>in_progress']);
    expect(offered(waiting, nobody)).toEqual([]);
    // Whoever asked may take the request back even with no rights left.
    expect(offered(waiting, { ...nobody, isRequester: true })).toEqual([
      'withdraw>in_progress',
    ]);
  });

  it('never offers one person two ways to the same status', () => {
    for (const canTriage of [true, false]) {
      for (const canSignOff of [true, false]) {
        for (const isRequester of [true, false]) {
          const caller = { canTriage, canSignOff, isRequester };
          const targets = movesFor(
            at(sentinel, 'awaiting_sign_off'),
            caller,
          ).map((m) => m.to);
          expect(new Set(targets).size).toBe(targets.length);
        }
      }
    }
  });

  it('refuses the one who asked, and anyone without the right, as second person', () => {
    const waiting = at(sentinel, 'awaiting_sign_off');
    expect(chooseMove(waiting, 'closed', requester)).toBe('same_person');
    expect(chooseMove(waiting, 'closed', triager)).toBe(
      'missing_sign_off_permission',
    );
    expect(
      chooseMove(waiting, 'closed', { ...nobody, isRequester: true }),
    ).toBe('missing_sign_off_permission');
    expect(chooseMove(waiting, 'closed', officer)).toMatchObject({
      action: 'sign_off',
      note: 'optional',
    });
    // Going back is a decision for the second person, a withdrawal otherwise.
    expect(chooseMove(waiting, 'in_progress', officer)).toMatchObject({
      action: 'send_back',
      note: 'required',
    });
    expect(chooseMove(waiting, 'in_progress', requester)).toMatchObject({
      action: 'withdraw',
      note: 'required',
    });
    expect(chooseMove(waiting, 'rejected', officer)).toBe('invalid_transition');
  });

  it('gives a say only to those the status concerns', () => {
    const waiting = at(sentinel, 'awaiting_sign_off');
    expect(hasSay(waiting, nobody)).toBe(false);
    expect(hasSay(waiting, signer)).toBe(true);
    expect(hasSay(waiting, { ...nobody, isRequester: true })).toBe(true);
    // The right to sign off decides nothing before a request is made.
    expect(hasSay(at(sentinel, 'triaged'), signer)).toBe(false);
    expect(hasSay(at(sentinel, 'triaged'), triager)).toBe(true);
  });

  it('still cannot set a serious report aside', () => {
    expect(chooseMove(at(sentinel, 'new'), 'rejected', officer)).toBe(
      'serious_cannot_be_rejected',
    );
    expect(chooseMove(at(ordinary, 'new'), 'rejected', officer)).toMatchObject({
      action: 'reject',
    });
  });
});
