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

/** A code as typed back: letter case, hyphens and spaces do not matter. */
const normalize = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();

const digest = (code: string) =>
  createHash('sha256').update(normalize(code)).digest();

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
