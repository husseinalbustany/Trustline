/**
 * Names and identifiers removed before a request leaves Trustline, and put
 * back in the answer (docs/specs/ai-providers-and-allowances.md, decision 4
 * and "Safeguards common to every provider").
 *
 * One `Redaction` per request. It replaces, with stable placeholders:
 *
 * - the names of the client's people (its users, in every language they are
 *   written in) and any name the feature passes in, as whole names and as
 *   the parts of a name (`[PERSON_1]`);
 * - email addresses (`[EMAIL_1]`), phone numbers (`[PHONE_1]`), national
 *   ID-like numbers (`[ID_1]`) and medical record-like numbers (`[MRN_1]`),
 *   in Latin and Arabic-Indic digits.
 *
 * The same thing gets the same placeholder everywhere in the request (the
 * system text and every message), so the model can tell people apart. What
 * each placeholder stands for is kept in this object only, in memory, and
 * goes when the request does: it is never logged, stored or sent.
 *
 * Matching errs on the side of removing: a word that is also a name is
 * replaced, and put back in the answer, so what the person reads is right
 * either way; only the model sees less.
 */

export const PLACEHOLDER_KINDS = [
  'PERSON',
  'EMAIL',
  'PHONE',
  'ID',
  'MRN',
] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

/** Any placeholder of ours, as written in a text. */
const PLACEHOLDER = /\[(PERSON|EMAIL|PHONE|ID|MRN)_(\d{1,6})\]/g;

/**
 * The same, as a model may write it back: without the brackets, or with
 * spaces inside them. Only ever matched against placeholders this request
 * made, so nothing else that looks like one is touched.
 */
const PLACEHOLDER_LOOSE =
  /\[\s*(PERSON|EMAIL|PHONE|ID|MRN)_(\d{1,6})\s*\]|(?<![\p{L}\p{N}_])(PERSON|EMAIL|PHONE|ID|MRN)_(\d{1,6})(?![\p{L}\p{N}_])/gu;

// ---------------------------------------------------------------------------
// Folding: one form for comparing, with where each character came from.
// ---------------------------------------------------------------------------

/** Arabic letters written several ways, and the form compared. */
const ARABIC_VARIANTS: Record<string, string> = {
  // Alef wasla. (Alef with hamza or madda decomposes to a bare alef.)
  'ٱ': 'ا',
  // Teh marbuta, often typed as heh.
  'ة': 'ه',
  // Persian yeh and keheh, typed on some keyboards.
  'ی': 'ي',
  'ک': 'ك',
  // Alef maqsura is kept apart from yeh on purpose: folding them would make
  // the preposition على the name علي.
};

/** Latin letters that do not decompose. */
const LATIN_VARIANTS: Record<string, string> = {
  œ: 'oe',
  æ: 'ae',
  ß: 'ss',
  ø: 'o',
  đ: 'd',
  ł: 'l',
  ı: 'i',
};

const TATWEEL = 'ـ';

/** Arabic-Indic and Eastern Arabic-Indic digits, as Latin ones. */
function latinDigit(c: string): string | null {
  const code = c.charCodeAt(0);
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return null;
}

const MARK = /\p{M}/u;

type Folded = {
  /** The text lowercased, without diacritics, with Latin digits. */
  text: string;
  /** For each character of `text`, where it starts in the original. */
  from: number[];
};

/**
 * The text in the form names and numbers are compared in: lowercase; accents
 * and Arabic diacritics (harakat, shadda, tanween) and the tatweel removed;
 * alef with hamza or madda as a bare alef, and the other variants above;
 * every digit a Latin one. With, for each character, where it came from, so
 * that what is found is replaced in the original.
 */
export function fold(original: string): Folded {
  let text = '';
  const from: number[] = [];
  for (let i = 0; i < original.length; ) {
    const point = original.codePointAt(i)!;
    const char = String.fromCodePoint(point);
    const push = (s: string) => {
      for (const c of s) {
        text += c;
        from.push(i);
      }
    };
    const digit = latinDigit(char);
    if (digit !== null) push(digit);
    else if (char !== TATWEEL) {
      for (const part of char.normalize('NFD')) {
        if (MARK.test(part)) continue;
        const lower = part.toLowerCase();
        push(ARABIC_VARIANTS[lower] ?? LATIN_VARIANTS[lower] ?? lower);
      }
    }
    i += char.length;
  }
  return { text, from };
}

/** The original span of a folded span, with any marks that follow it. */
function originalSpan(original: string, folded: Folded, start: number, end: number) {
  const from = folded.from[start];
  const lastStart = folded.from[end - 1];
  let to = lastStart + String.fromCodePoint(original.codePointAt(lastStart)!).length;
  while (to < original.length && (MARK.test(original[to]) || original[to] === TATWEEL)) to++;
  return { start: from, end: to };
}

// ---------------------------------------------------------------------------
// Words.
// ---------------------------------------------------------------------------

type Word = {
  /** In the folded text. */
  start: number;
  end: number;
  /** Folded, with the article and prefixes written one way. */
  norm: string;
  /** Written with a capital, in the original (Latin script only). */
  capital: boolean;
  arabic: boolean;
};

const WORD = /[\p{L}\p{N}]+/gu;
const ARABIC = /[؀-ۿ]/;

/**
 * Particles that begin a name and are written joined, hyphenated or apart:
 * Al-Hassan, Al Hassan, Alhassan, El-Hassan; Abdul Rahman, Abdelrahman,
 * Abd al-Rahman; Abu Bakr, Abou Bakr; عبد الله and عبدالله. Folded to one
 * spelling, so that each way matches the others.
 */
const LATIN_PARTICLES = new Set(['al', 'el', 'ul', 'abd', 'abdul', 'abdel', 'abdal', 'abu', 'abou', 'bou']);
const ARABIC_PARTICLES = new Set(['ال', 'عبد', 'ابو', 'بو']);

/** One spelling for the particles at the start of a word. */
function canonical(norm: string): string {
  return norm
    .replace(/^abd(?:el|ul|al)*/u, 'abdal')
    .replace(/^(?:el|ul)(?=\p{L}{3,}|$)/u, 'al')
    .replace(/^abou/u, 'abu');
}

/** What may stand between the parts of one name: spaces and hyphens. */
const NAME_GAP = /^[\s \-‐‑‒–]{1,3}$/u;
const HYPHENATED = /[-‐‑‒–]/u;

const isCapital = (c: string) => c !== c.toLowerCase() && c === c.toUpperCase();

/** The words of a folded text, each as written and folded. */
function wordsOf(original: string, folded: Folded): Word[] {
  const words: Word[] = [];
  for (const m of folded.text.matchAll(WORD)) {
    const start = m.index;
    const end = start + m[0].length;
    const first = original[folded.from[start]];
    const arabic = ARABIC.test(m[0]);
    words.push({ start, end, norm: canonical(m[0]), capital: !arabic && isCapital(first), arabic });
  }
  return words;
}

/**
 * The same words with each particle joined to the word after it, when that
 * is how it reads as one name: always after an Arabic particle; after a
 * Latin one when hyphenated or before a capital. So "Al Hassan" and
 * "al-Hassan" are one word, as "Alhassan" is, while "ben said" stays two.
 */
function joined(folded: Folded, words: Word[]): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    let word = words[i];
    while (i + 1 < words.length) {
      const next = words[i + 1];
      const gap = folded.text.slice(word.end, next.start);
      const particle = word.arabic ? ARABIC_PARTICLES.has(word.norm) : LATIN_PARTICLES.has(word.norm);
      if (!particle || !NAME_GAP.test(gap)) break;
      if (!word.arabic && !HYPHENATED.test(gap) && !next.capital && !LATIN_PARTICLES.has(next.norm)) break;
      word = {
        start: word.start,
        end: next.end,
        norm: canonical(word.norm + next.norm),
        capital: word.capital,
        arabic: word.arabic,
      };
      i++;
      if (!LATIN_PARTICLES.has(next.norm) && !ARABIC_PARTICLES.has(next.norm)) break;
    }
    out.push(word);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Names.
// ---------------------------------------------------------------------------

/**
 * Titles and words that come with a name and are not one: never replaced on
 * their own, and not part of a name to look for.
 */
const NOT_A_NAME = new Set([
  'dr', 'prof', 'mr', 'mrs', 'ms', 'miss', 'mme', 'mlle', 'mx', 'sir', 'madam', 'dame',
  'doctor', 'docteur', 'professor', 'professeur', 'nurse', 'sister', 'monsieur', 'madame',
  'sheikh', 'shaikh', 'cheikh', 'eng', 'ing', 'pr',
  'al', 'abdal', 'abu', 'bin', 'ibn', 'ben', 'bint', 'de', 'du', 'des', 'la', 'le', 'van', 'von', 'der',
  'د', 'ا', 'م', 'دكتور', 'الدكتور', 'الدكتوره', 'دكتوره', 'السيد', 'السيده', 'الاستاذ', 'الاستاذه',
  'استاذ', 'استاذه', 'الممرض', 'الممرضه', 'الشيخ', 'شيخ', 'المهندس', 'المهندسه',
  'ال', 'عبد', 'ابو', 'بن', 'ابن', 'بنت',
]);

/** The shortest part of a name looked for on its own, in letters. */
const MIN_PART = 3;

/**
 * Letters an Arabic word may begin with before a name: and, so, with, to,
 * like, and "and" or "so" before one of the others (ولمحمد: and to Mohammed).
 */
const ARABIC_PREFIXES = ['و', 'ف', 'ب', 'ل', 'ك', 'وب', 'ول', 'وك', 'فب', 'فل', 'فك'];

/**
 * The names to look for, folded: whole names as sequences of words, and
 * their parts. Built once per request from the client's people and what the
 * feature passes in.
 */
export class NameIndex {
  /** Whole names (two words or more), by their first word, longest first. */
  private readonly sequences = new Map<string, string[][]>();
  /** Parts of names that are looked for on their own. */
  private readonly parts = new Set<string>();

  constructor(names: Iterable<string>) {
    for (const name of names) this.add(name);
    for (const list of this.sequences.values()) list.sort((a, b) => b.length - a.length);
  }

  get size() {
    return this.parts.size;
  }

  private add(name: string) {
    if (!name || !name.trim()) return;
    const folded = fold(name);
    const raw = wordsOf(name, folded);
    for (const words of [raw, joined(folded, raw)]) {
      // Titles at the start are not part of the name to look for.
      let list = words.map((w) => w.norm);
      while (list.length > 1 && NOT_A_NAME.has(list[0])) list = list.slice(1);
      if (list.some((n) => /\d/.test(n))) continue;
      if (list.length >= 2) {
        const byFirst = this.sequences.get(list[0]) ?? [];
        if (!byFirst.some((s) => s.join(' ') === list.join(' '))) byFirst.push(list);
        this.sequences.set(list[0], byFirst);
      }
      for (const part of list) {
        if (part.length >= MIN_PART && !NOT_A_NAME.has(part)) this.parts.add(part);
      }
    }
  }

  /**
   * Where names are in a text, in the folded text's positions: whole names
   * first, then parts of names on their own. A part on its own counts in
   * Latin script only when written with a capital, so "will" is not taken
   * for Will; Arabic has no capitals, so there every part counts.
   */
  find(folded: Folded, words: Word[]): { start: number; end: number }[] {
    const spans: { start: number; end: number }[] = [];
    for (let i = 0; i < words.length; ) {
      const found = this.wholeAt(folded, words, i) ?? this.partAt(words[i]);
      if (found) {
        spans.push({ start: found.start, end: found.end });
        i += found.words;
      } else i++;
    }
    return spans;
  }

  /** A word as it may match a name's: itself, or an Arabic prefix and a name. */
  private matches(word: Word, norm: string): number | null {
    if (word.norm === norm) return 0;
    if (word.arabic && word.norm.length > norm.length && word.norm.endsWith(norm)) {
      const prefix = word.norm.slice(0, word.norm.length - norm.length);
      if (ARABIC_PREFIXES.includes(prefix)) return prefix.length;
    }
    return null;
  }

  private wholeAt(folded: Folded, words: Word[], i: number) {
    const first = words[i];
    const candidates = [
      ...(this.sequences.get(first.norm) ?? []),
      ...(first.arabic
        ? ARABIC_PREFIXES.flatMap((p) => (first.norm.startsWith(p) ? (this.sequences.get(first.norm.slice(p.length)) ?? []) : []))
        : []),
    ].sort((a, b) => b.length - a.length);
    for (const sequence of candidates) {
      if (i + sequence.length > words.length) continue;
      const skip = this.matches(first, sequence[0]);
      if (skip === null) continue;
      let ok = true;
      for (let k = 1; k < sequence.length && ok; k++) {
        const gap = folded.text.slice(words[i + k - 1].end, words[i + k].start);
        ok = NAME_GAP.test(gap) && words[i + k].norm === sequence[k];
      }
      if (ok) {
        return {
          start: first.start + skip,
          end: words[i + sequence.length - 1].end,
          words: sequence.length,
        };
      }
    }
    return null;
  }

  private partAt(word: Word) {
    if (!word.arabic && !word.capital) return null;
    if (this.parts.has(word.norm)) return { start: word.start, end: word.end, words: 1 };
    if (word.arabic) {
      for (const prefix of ARABIC_PREFIXES) {
        const rest = word.norm.slice(prefix.length);
        if (word.norm.startsWith(prefix) && rest.length >= MIN_PART && this.parts.has(rest)) {
          return { start: word.start + prefix.length, end: word.end, words: 1 };
        }
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Identifiers.
// ---------------------------------------------------------------------------

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/** The start of a word, for patterns in any script. */
const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

/**
 * Words that introduce a medical record or file number, folded (lowercase,
 * no accents, ة as ه, إ as ا): English, French, Arabic.
 */
const MRN_WORDS = [
  'mrn', 'mr\\s?(?:no|n°|#)', 'medical\\s+record(?:\\s+(?:number|no|#))?',
  '(?:record|file|patient|hospital|chart|case)\\s+(?:number|no|#|id)',
  'dossier(?:\\s+(?:medical|patient))?(?:\\s+(?:n°|no|numero))?', '(?:n°|no|numero)\\s+de\\s+dossier',
  'ipp', 'nip',
  'رقم\\s+الملف(?:\\s+الطبي)?', 'الرقم\\s+الطبي', 'رقم\\s+السجل(?:\\s+الطبي)?', 'السجل\\s+الطبي(?:\\s+رقم)?',
  'الملف\\s+الطبي(?:\\s+رقم)?', 'ملف\\s+رقم', 'رقم\\s+المريض', 'ملف\\s+المريض(?:\\s+رقم)?',
];

/** Words that introduce an identity document's number. */
const ID_WORDS = [
  'national\\s+id(?:\\s+(?:number|no))?', 'id\\s+(?:number|no|card)', 'identity\\s+(?:card|number)(?:\\s+(?:number|no))?',
  'passport(?:\\s+(?:number|no))?', 'iqama(?:\\s+(?:number|no))?', 'emirates\\s+id', 'civil\\s+id(?:\\s+(?:number|no))?',
  'social\\s+security(?:\\s+(?:number|no))?', 'ssn',
  'carte\\s+d.identite(?:\\s+(?:n°|no|numero))?', 'cni', 'cin', 'nir', '(?:numero\\s+de\\s+)?securite\\s+sociale', 'passeport(?:\\s+(?:n°|no))?',
  'رقم\\s+الهويه(?:\\s+الوطنيه)?', 'الهويه(?:\\s+الوطنيه)?(?:\\s+رقم)?', 'بطاقه\\s+الهويه', 'رقم\\s+الاقامه', 'الاقامه(?:\\s+رقم)?',
  'رقم\\s+الجواز', 'جواز\\s+السفر(?:\\s+رقم)?', 'رقم\\s+جواز\\s+السفر', 'البطاقه\\s+المدنيه', 'الرقم\\s+المدني', 'السجل\\s+المدني',
  'الرقم\\s+الوطني', 'رقم\\s+الضمان(?:\\s+الاجتماعي)?',
];

/** After the words: a short run of punctuation, then the number itself. */
const LED_VALUE = '[\\s:#.°=\\-]{0,4}((?:[a-z]{1,4}[\\s\\-]?)?\\d(?:[\\d\\s\\-/]{2,24}\\d)?)';

const ledBy = (words: string[]) => new RegExp(`${B}(?:${words.join('|')})${LED_VALUE}${E}`, 'gu');
const MRN_LED = ledBy(MRN_WORDS);
const ID_LED = ledBy(ID_WORDS);

/**
 * A long number standing alone: seven digits or more, possibly with spaces,
 * dots, dashes or brackets between them, and a leading + or 00. Not part of
 * a code that letters or digits run into (INC-2026-0042 stays whole).
 */
const LONG_NUMBER = /(?<![\p{L}\p{N}][-_/.]?)(?<![\p{L}\p{N}+])(\+|00)?\(?\d(?:[ .\-() ]{0,2}\d){6,}\)?(?![\p{L}\p{N}])/gu;

const DATE = /^(?:\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d{1,2}[-.]\d{1,2}[-.]\d{4})$/;

/** What a long number alone is taken for. Null: not an identifier (a date). */
function kindOfNumber(found: string): PlaceholderKind | null {
  if (DATE.test(found)) return null;
  const digits = found.replace(/\D/g, '');
  const separated = /[ .\-() ]/.test(found.replace(/^\+/, ''));
  if (found.startsWith('+') || found.startsWith('00') || found.startsWith('(')) return 'PHONE';
  // Emirates ID: 784-YYYY-NNNNNNN-N.
  if (digits.length === 15 && digits.startsWith('784')) return 'ID';
  // Saudi national ID and iqama: ten digits from 1 or 2.
  if (digits.length === 10 && /^[12]/.test(digits) && !separated) return 'ID';
  if (digits.startsWith('0') && digits.length >= 8 && digits.length <= 12) return 'PHONE';
  if (separated && digits.length <= 12) return 'PHONE';
  return 'ID';
}

/** A key for "the same identifier": its digits, or the address lowercased. */
const identifierKey = (kind: PlaceholderKind, foldedValue: string) =>
  kind === 'EMAIL' ? foldedValue : foldedValue.replace(/[^\p{L}\p{N}]/gu, '');

// ---------------------------------------------------------------------------
// The redaction of one request.
// ---------------------------------------------------------------------------

type Span = { start: number; end: number; kind: PlaceholderKind; key: string };

/**
 * Removes names and identifiers from the texts of one request, and puts
 * them back in the answer. Keep one per request, never longer.
 */
export class Redaction {
  /** Kind and key of what was found, to its placeholder. */
  private readonly placeholders = new Map<string, string>();
  /** Placeholder to the text it stands for, as first written. */
  private readonly originals = new Map<string, string>();
  private readonly next: Record<PlaceholderKind, number> = { PERSON: 1, EMAIL: 1, PHONE: 1, ID: 1, MRN: 1 };
  /** Placeholders already in a text the request was given: never made again. */
  private readonly taken = new Set<string>();

  constructor(private readonly names: NameIndex) {}

  /** How many different things were replaced. */
  get replaced() {
    return this.originals.size;
  }

  /**
   * Notes the placeholders a set of texts already contains (someone typed
   * "[PERSON_1]"), so that none is made with the same number. Call it with
   * every text of the request before redacting any of them.
   */
  reserve(texts: Iterable<string>) {
    for (const text of texts) {
      for (const m of text.matchAll(PLACEHOLDER)) this.taken.add(m[0]);
    }
  }

  /** The text with every name and identifier replaced. */
  redact(text: string): string {
    if (!text) return text;
    const folded = fold(text);
    const spans: Span[] = [];
    const claim = (start: number, end: number, kind: PlaceholderKind, key: string) => {
      if (end <= start) return;
      if (spans.some((s) => start < s.end && s.start < end)) return;
      spans.push({ start, end, kind, key });
    };

    for (const m of folded.text.matchAll(EMAIL)) {
      claim(m.index, m.index + m[0].length, 'EMAIL', identifierKey('EMAIL', m[0]));
    }
    for (const [pattern, kind] of [[MRN_LED, 'MRN'], [ID_LED, 'ID']] as const) {
      for (const m of folded.text.matchAll(pattern)) {
        const value = m[1];
        const start = m.index + m[0].length - value.length;
        claim(start, start + value.length, kind, identifierKey(kind, value));
      }
    }
    for (const m of folded.text.matchAll(LONG_NUMBER)) {
      const kind = kindOfNumber(m[0]);
      if (kind) claim(m.index, m.index + m[0].length, kind, identifierKey(kind, m[0]));
    }

    // Names are looked for outside the identifiers found, so that a name
    // running into an address ("Khalid khalid@…") is still found in part.
    let masked = folded.text;
    for (const span of spans) {
      masked = masked.slice(0, span.start) + ' '.repeat(span.end - span.start) + masked.slice(span.end);
    }
    const words = wordsOf(text, { text: masked, from: folded.from });
    const nameSpans = [
      ...this.names.find({ text: masked, from: folded.from }, words),
      ...this.names.find({ text: masked, from: folded.from }, joined({ text: masked, from: folded.from }, words)),
    ].sort((a, b) => a.start - b.start || b.end - a.end);
    // Overlapping finds of the two readings are one name: the widest.
    const merged: { start: number; end: number }[] = [];
    for (const span of nameSpans) {
      const last = merged[merged.length - 1];
      if (last && span.start < last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    for (const span of merged) {
      claim(span.start, span.end, 'PERSON', personKey(folded.text.slice(span.start, span.end)));
    }

    spans.sort((a, b) => a.start - b.start);
    let out = '';
    let at = 0;
    for (const span of spans) {
      const { start, end } = originalSpan(text, folded, span.start, span.end);
      if (start < at) continue;
      out += text.slice(at, start) + this.placeholderFor(span, text.slice(start, end));
      at = end;
    }
    return out + text.slice(at);
  }

  private placeholderFor(span: Span, original: string) {
    const id = `${span.kind}:${span.key}`;
    const known = this.placeholders.get(id);
    if (known) return known;
    let placeholder: string;
    do {
      placeholder = `[${span.kind}_${this.next[span.kind]++}]`;
    } while (this.taken.has(placeholder));
    this.placeholders.set(id, placeholder);
    this.originals.set(placeholder, original);
    return placeholder;
  }

  /**
   * The answer with this request's placeholders put back. Anything that
   * only looks like one (written by someone, or made up by the model) is
   * left as it is.
   */
  restore(text: string): string {
    if (!text || this.originals.size === 0) return text;
    return text.replace(PLACEHOLDER_LOOSE, (whole, k1?: string, n1?: string, k2?: string, n2?: string) => {
      const placeholder = `[${k1 ?? k2}_${n1 ?? n2}]`;
      return this.originals.get(placeholder) ?? whole;
    });
  }

  /** Every string inside a parsed answer (structured output), put back. */
  restoreDeep<T>(value: T): T {
    if (typeof value === 'string') return this.restore(value) as T;
    if (Array.isArray(value)) return value.map((v: unknown) => this.restoreDeep(v)) as T;
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, this.restoreDeep(v)]),
      ) as T;
    }
    return value;
  }
}

/** A key for "the same name", however it was spaced or hyphenated. */
function personKey(foldedSpan: string): string {
  return canonical([...foldedSpan.matchAll(WORD)].map((m) => canonical(m[0])).join(''));
}
