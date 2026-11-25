import {
  FOLLOW_UP_ALPHABET,
  hashFollowUpCode,
  matchesFollowUpCode,
  newFollowUpCode,
} from './follow-up-code.js';

describe('follow-up code', () => {
  it('is 16 characters in groups of four, from an alphabet without look-alikes', () => {
    expect(FOLLOW_UP_ALPHABET).toHaveLength(31);
    for (const lookAlike of '01OIL') {
      expect(FOLLOW_UP_ALPHABET).not.toContain(lookAlike);
    }
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const code = newFollowUpCode();
      expect(code).toMatch(
        /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/,
      );
      seen.add(code);
    }
    expect(seen.size).toBe(500);
    // Every character of the alphabet turns up: none is left out by the draw.
    const used = new Set([...seen].join('').replaceAll('-', ''));
    expect(used.size).toBe(FOLLOW_UP_ALPHABET.length);
  });

  it('is stored as a hash that does not contain it', () => {
    const code = newFollowUpCode();
    const hash = hashFollowUpCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(code.replaceAll('-', '').toLowerCase());
  });

  it('matches whatever the letter case, hyphens and spaces it is typed with', () => {
    const code = newFollowUpCode();
    const hash = hashFollowUpCode(code);
    const bare = code.replaceAll('-', '');
    for (const typed of [
      code,
      code.toLowerCase(),
      bare,
      bare.toLowerCase(),
      ` ${bare.slice(0, 8)} ${bare.slice(8)} `,
      `${bare.slice(0, 2)}-${bare.slice(2)}`,
    ]) {
      expect(matchesFollowUpCode(typed, hash)).toBe(true);
    }
  });

  it('matches nothing else, and nothing at all when no hash is stored', () => {
    const code = newFollowUpCode();
    const hash = hashFollowUpCode(code);
    expect(matchesFollowUpCode(newFollowUpCode(), hash)).toBe(false);
    expect(matchesFollowUpCode(code.slice(0, -1), hash)).toBe(false);
    expect(matchesFollowUpCode('', hash)).toBe(false);
    expect(matchesFollowUpCode(code, null)).toBe(false);
    expect(matchesFollowUpCode('', null)).toBe(false);
    // A stored value that is not a hash is never a match and never throws.
    expect(matchesFollowUpCode(code, 'not-a-hash')).toBe(false);
    expect(matchesFollowUpCode(code, '')).toBe(false);
  });
});
