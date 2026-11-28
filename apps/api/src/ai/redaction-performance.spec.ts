import { NameIndex, Redaction } from './redaction.js';

/**
 * Name removal runs on the request's thread, before anything is sent: an
 * input made to be slow must not hold the API up for every client
 * (security review 13, H1). Each of these is ten times the largest
 * request AiService accepts, and must be done in about a second.
 */
describe('name removal on adversarial input', () => {
  const N = 400_000;
  const people = ['Sarah Johnson', 'Khalid Al-Hassan', 'محمد الحسن', 'Abdul Rahman Saleh', ...Array.from({ length: 2000 }, (_, i) => `Person${i} Family${i}`)];
  const inputs: Record<string, string> = {
    letters: 'a'.repeat(N),
    'letters and dots': 'a.'.repeat(N / 2),
    'at signs': 'a@'.repeat(N / 2),
    'address-like': 'a@b.'.repeat(N / 4),
    digits: '1'.repeat(N),
    'digits and separators': '1 '.repeat(N / 2),
    'plus and digits': '+1'.repeat(N / 2),
    'arabic digits': '٠'.repeat(N),
    particles: 'Al-'.repeat(N / 3),
    'arabic particles': 'عبد '.repeat(N / 4),
    'capitalised words': 'Patient '.repeat(N / 8),
    'record words': 'MRN '.repeat(N / 4),
    'file words and digits': 'file 1'.repeat(N / 6),
    'diacritics': 'مَ'.repeat(N / 2),
    'placeholders': 'PERSON_1 '.repeat(N / 9),
  };

  for (const [name, text] of Object.entries(inputs)) {
    it(`finishes on ${name} in about a second`, () => {
      const redaction = new Redaction(new NameIndex(people));
      const began = performance.now();
      redaction.reserve([text]);
      redaction.learn([text]);
      redaction.redact(text);
      const took = performance.now() - began;
      expect([name, took < 1500]).toEqual([name, true]);
    });
  }
});
