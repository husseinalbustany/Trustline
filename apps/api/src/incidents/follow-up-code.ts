import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * The follow-up code of an anonymous report: the only way back to it, shown
 * once and stored only as a hash.
 */

/** Letters and digits that cannot be mistaken for one another: no 0/O, 1/I/L. */
export const FOLLOW_UP_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const FOLLOW_UP_LENGTH = 16;

/**
 * A new code as the reporter is shown it, in groups of four:
 * `K7QM-2RXD-9FHT-WB3N`. Each character is drawn evenly from the alphabet by
 * the system's secure random source, about 79 bits in all.
 */
export function newFollowUpCode(): string {
  let code = '';
  for (let i = 0; i < FOLLOW_UP_LENGTH; i++) {
    code += FOLLOW_UP_ALPHABET[randomInt(FOLLOW_UP_ALPHABET.length)];
  }
  return code.match(/.{4}/g)!.join('-');
}

const NOT_IN_ALPHABET = new RegExp(`[^${FOLLOW_UP_ALPHABET}]`, 'g');

/**
 * A code as typed or pasted back, reduced to the characters a code is made
 * of. Letter case does not matter, and whatever is not in the alphabet is
 * left out: the hyphens it was shown with, spaces, punctuation, and what
 * cannot be seen at all, such as the direction marks a phone puts around
 * pasted text in a right-to-left field. None of that can be part of a code,
 * so none of it should cost the reporter an attempt.
 *
 * Nothing is made easier to guess by this: every one of the code's own
 * characters still has to be there, in order, and nothing else from the
 * alphabet.
 */
export const normalizeFollowUpCode = (code: string) =>
  code.toUpperCase().replace(NOT_IN_ALPHABET, '');

const digest = (code: string) =>
  createHash('sha256').update(normalizeFollowUpCode(code)).digest();

/** What is stored for a code. */
export const hashFollowUpCode = (code: string) => digest(code).toString('hex');

// Stands in for the stored hash when there is none, so that checking a code
// against a report that does not exist, or has no code, does the same work
// as checking it against one that does. Random, so no code can match it.
const DECOY = randomBytes(32);

/**
 * Whether a typed code is the one whose hash was stored. Compared in
 * constant time; with nothing stored (`null`) it compares all the same and
 * answers no.
 */
export function matchesFollowUpCode(
  code: string,
  storedHash: string | null,
): boolean {
  const stored = storedHash ? Buffer.from(storedHash, 'hex') : DECOY;
  const usable = storedHash !== null && stored.length === DECOY.length;
  const same = timingSafeEqual(digest(code), usable ? stored : DECOY);
  return same && usable;
}
