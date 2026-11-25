import {
  chooseMove,
  hasSay,
  MOVE_KINDS,
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
): string[] => movesFor(incident, caller).map((m) => `${m.kind}>${m.to}`);

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

  it('names every move with one of eight kinds, each used once', () => {
    expect([...MOVE_KINDS].sort()).toEqual([
      'close',
      'reject',
      'reopen',
      'request_sign_off',
      'send_back',
      'sign_off',
      'start',
      'withdraw',
    ]);
    const everyone = { canTriage: true, canSignOff: true, isRequester: false };
    const seen = new Set<string>();
    for (const status of [
      'new',
      'triaged',
      'in_progress',
      'awaiting_sign_off',
      'closed',
      'rejected',
    ] as const) {
      for (const incident of [ordinary, sentinel]) {
        for (const isRequester of [true, false]) {
          const moves = movesFor(at(incident, status), {
            ...everyone,
            isRequester,
          });
          // Within what one person is offered, a kind says which move.
          expect(new Set(moves.map((m) => m.kind)).size).toBe(moves.length);
          for (const move of moves) seen.add(move.kind);
        }
      }
    }
    expect([...seen].sort()).toEqual([...MOVE_KINDS].sort());
  });

  it('offers each person awaiting sign-off exactly what they may do', () => {
    const waiting = at(sentinel, 'awaiting_sign_off');
    // The second person decides, and as a triager may also just take the
    // request back: two moves to the same status, told apart by kind.
    expect(offered(waiting, officer)).toEqual([
      'sign_off>closed',
      'send_back>in_progress',
      'withdraw>in_progress',
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

  it('needs the kind where two moves lead to the same status, and checks it elsewhere', () => {
    const waiting = at(sentinel, 'awaiting_sign_off');
    // Whoever asks, and whichever of the two they could make.
    for (const caller of [officer, signer, triager, requester]) {
      expect(chooseMove(waiting, 'in_progress', caller)).toBe('kind_required');
    }
    expect(
      chooseMove(waiting, 'in_progress', officer, 'send_back'),
    ).toMatchObject({
      kind: 'send_back',
      event: 'sent_back',
      note: 'required',
    });
    expect(
      chooseMove(waiting, 'in_progress', officer, 'withdraw'),
    ).toMatchObject({
      kind: 'withdraw',
      event: 'status_changed',
      note: 'required',
    });
    // Only one move leads to closed: the kind may be left out, or be right.
    expect(chooseMove(waiting, 'closed', officer)).toMatchObject({
      kind: 'sign_off',
      note: 'optional',
    });
    expect(chooseMove(waiting, 'closed', officer, 'sign_off')).toMatchObject({
      kind: 'sign_off',
    });
    // A kind that does not lead there from here: the screen was out of date.
    expect(chooseMove(waiting, 'closed', officer, 'close')).toBe(
      'invalid_transition',
    );
    expect(chooseMove(waiting, 'in_progress', officer, 'reopen')).toBe(
      'invalid_transition',
    );
    const triaged = at(ordinary, 'triaged');
    expect(chooseMove(triaged, 'in_progress', triager)).toMatchObject({
      kind: 'start',
    });
    expect(chooseMove(triaged, 'in_progress', triager, 'reopen')).toBe(
      'invalid_transition',
    );
    expect(
      chooseMove(at(ordinary, 'closed'), 'in_progress', triager, 'reopen'),
    ).toMatchObject({ kind: 'reopen' });
  });

  it('refuses the one who asked, and anyone without the right, as second person', () => {
    const waiting = at(sentinel, 'awaiting_sign_off');
    const onlyAsked = { ...nobody, isRequester: true };
    expect(chooseMove(waiting, 'closed', requester)).toBe('same_person');
    expect(chooseMove(waiting, 'in_progress', requester, 'send_back')).toBe(
      'same_person',
    );
    expect(chooseMove(waiting, 'closed', triager)).toBe(
      'missing_sign_off_permission',
    );
    expect(chooseMove(waiting, 'in_progress', triager, 'send_back')).toBe(
      'missing_sign_off_permission',
    );
    expect(chooseMove(waiting, 'closed', onlyAsked)).toBe(
      'missing_sign_off_permission',
    );
    // Taking the request back is for whoever asked and for triagers.
    expect(chooseMove(waiting, 'in_progress', signer, 'withdraw')).toBe(
      'missing_triage_permission',
    );
    for (const caller of [requester, onlyAsked, triager, officer]) {
      expect(
        chooseMove(waiting, 'in_progress', caller, 'withdraw'),
      ).toMatchObject({ kind: 'withdraw' });
    }
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
      kind: 'reject',
    });
  });
});
