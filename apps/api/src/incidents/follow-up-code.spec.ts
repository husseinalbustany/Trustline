import {
  FOLLOW_UP_ALPHABET,
  hashFollowUpCode,
  matchesFollowUpCode,
  newFollowUpCode,
  normalizeFollowUpCode,
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

  it('matches whatever came with it that is not part of a code', () => {
    const code = newFollowUpCode();
    const hash = hashFollowUpCode(code);
    const bare = code.replaceAll('-', '');
    const groups = code.split('-');
    // Written as escapes: none of these can be seen in a source file.
    const RLM = '\u200f';
    const LRM = '\u200e';
    const ALM = '\u061c';
    const ISOLATES = ['\u2066', '\u2067', '\u2068', '\u2069'];
    const EMBEDDINGS = ['\u202a', '\u202b', '\u202c', '\u202d', '\u202e'];
    for (const [what, typed] of Object.entries({
      'a direction mark at each end, as a phone pastes it': `${RLM}${code}${RLM}`,
      'left-to-right marks around it': `${LRM}${code}${LRM}`,
      'an Arabic letter mark in front': `${ALM}${code}`,
      'isolated, as a right-to-left page shows it': `${ISOLATES[0]}${code}${ISOLATES[3]}`,
      'a mark between every two characters': bare.split('').join(RLM),
      'every isolate and embedding there is': `${ISOLATES.join('')}${code}${EMBEDDINGS.join('')}`,
      'a zero-width space and a joiner': `\u200b${groups[0]}\u200d${groups.slice(1).join('')}\u200c`,
      'a byte order mark': `\ufeff${code}`,
      'non-breaking spaces between the groups': groups.join('\u00a0'),
      'narrow non-breaking spaces': groups.join('\u202f'),
      'a tab and a line end': `\t${code}\r\n`,
      'other dashes': groups.join('–'),
      'an Arabic hyphen-like tatweel': groups.join('ـ'),
      'dots, as some keyboards separate': groups.join('.'),
      'quotation marks around it': `“${code}”`,
      'a label copied with it': `: ${code}.`,
      'small letters and stray punctuation': ` (${bare.toLowerCase()}) `,
    })) {
      expect([what, normalizeFollowUpCode(typed)]).toEqual([what, bare]);
      expect([what, matchesFollowUpCode(typed, hash)]).toEqual([what, true]);
      expect([what, hashFollowUpCode(typed)]).toEqual([what, hash]);
    }
  });

  it('is not made easier to guess by that', () => {
    const code = newFollowUpCode();
    const hash = hashFollowUpCode(code);
    const bare = code.replaceAll('-', '');
    // Every character of the code has to be there, in order, and no other
    // character of the alphabet.
    expect(matchesFollowUpCode(bare.slice(1), hash)).toBe(false);
    expect(matchesFollowUpCode(`${bare}2`, hash)).toBe(false);
    expect(matchesFollowUpCode(`2${bare}`, hash)).toBe(false);
    expect(matchesFollowUpCode(bare.split('').reverse().join(''), hash)).toBe(
      bare.split('').reverse().join('') === bare,
    );
    expect(matchesFollowUpCode(`${bare.slice(0, 8)}\u200f`, hash)).toBe(false);
    // Nothing but marks is no code at all, and matches none.
    expect(normalizeFollowUpCode('\u200f\u200e - \u00a0')).toBe('');
    expect(matchesFollowUpCode('\u200f\u200e', hash)).toBe(false);
    // The look-alikes the alphabet leaves out are not read as anything.
    expect(normalizeFollowUpCode('0O1IL')).toBe('');
    // Only what is in the alphabet is ever hashed.
    expect(normalizeFollowUpCode(`${code}\u0000<script>`)).toMatch(
      new RegExp(`^[${FOLLOW_UP_ALPHABET}]+$`),
    );
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
