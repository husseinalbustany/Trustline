import { firstUncoveredStep } from './approval-engine.service.js';

describe('covering the steps of a run with different people', () => {
  it('finds a person for each step, no one twice, undoing an early choice when a later step needs it', () => {
    expect(firstUncoveredStep([['a'], ['b']])).toBeNull();
    // Taking "a" for the first step, as it comes first, would leave the
    // second with nobody; "b" takes the first instead.
    expect(firstUncoveredStep([['a', 'b'], ['a']])).toBeNull();
    expect(firstUncoveredStep([['a', 'b'], ['b', 'c'], ['a']])).toBeNull();
  });

  it('names the first step that cannot have a person of its own', () => {
    expect(firstUncoveredStep([['a'], ['a']])).toBe(1);
    expect(firstUncoveredStep([['a', 'b'], ['a', 'b'], ['a', 'b']])).toBe(2);
    expect(firstUncoveredStep([['a'], ['b'], ['a', 'b']])).toBe(2);
    expect(firstUncoveredStep([[]])).toBe(0);
  });
});
