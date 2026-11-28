/**
 * Names and identifiers removed before a request leaves Trustline, and put
 * back in the answer (docs/specs/ai-providers-and-allowances.md, decision 4
 * and "Safeguards common to every provider").
 *
 * One `Redaction` per request. It replaces, with stable placeholders:
 *
 * - the names of the client's people (its users, in every language they are
 *   written in) and every name the feature passes in, as whole names and as
 *   the parts of a name (`[PERSON_1]`);
 * - names it finds by the words around them: after a title or a word for a
 *   relationship (Patient, Mr, her son; Mme, son fils; المريضة، ابنها), in
 *   English, French and Arabic;
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
 *
 * What it cannot do (the spec, "Limits of name removal"): know a name it is
 * not given and that no title or relationship word announces. That is why
 * a feature must pass every person field of the records it sends.
 *
 * Every pattern here is bounded and anchored, and every step is one pass
 * over the text, so that no input can make it slow (security review 13,
 * H1): `redaction-performance.spec.ts` holds it to that.
 */

export const PLACEHOLDER_KINDS = [
  'PERSON',
  'EMAIL',
  'PHONE',
  'ID',
  'MRN',
] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

/**
 * Any placeholder of ours, as written in a text or as a model may write it
 * back: with brackets, without them, or with spaces inside them. Matched
 * against placeholders this request made only, when putting back.
 */
const PLACEHOLDER_LOOSE =
  /\[\s{0,3}(PERSON|EMAIL|PHONE|ID|MRN)_(\d{1,6})\s{0,3}\]|(?<![\p{L}\p{N}_])(PERSON|EMAIL|PHONE|ID|MRN)_(\d{1,6})(?![\p{L}\p{N}_])/gu;

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
function latinDigit(code: number): string | null {
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660);
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0);
  return null;
}

const MARK = /\p{M}/u;
/**
 * Invisible characters that can sit inside a word without changing how it
 * reads: the soft hyphen, zero-width spaces and joiners, direction marks.
 * Dropped, so that "Sa­rah" is Sarah.
 */
const FORMAT = /\p{Cf}/u;

type Folded = {
  /** The text lowercased, without diacritics, with Latin digits. */
  text: string;
  /** For each character of `text`, where it starts in the original. */
  from: number[];
};

/**
 * The text in the form names and numbers are compared in: lowercase; accents
 * and Arabic diacritics (harakat, shadda, tanween), the tatweel and
 * invisible characters removed; alef with hamza or madda as a bare alef,
 * and the other variants above; every digit a Latin one. With, for each
 * character, where it came from, so that what is found is replaced in the
 * original.
 */
export function fold(original: string): Folded {
  const parts: string[] = [];
  const from: number[] = [];
  for (let i = 0; i < original.length; ) {
    const point = original.codePointAt(i)!;
    const width = point > 0xffff ? 2 : 1;
    if (point < 0x80) {
      // Plain ASCII, most of any text: as it is, lowercased.
      parts.push(point >= 65 && point <= 90 ? String.fromCharCode(point + 32) : original[i]);
      from.push(i);
    } else {
      const digit = latinDigit(point);
      const char = String.fromCodePoint(point);
      if (digit !== null) {
        parts.push(digit);
        from.push(i);
      } else if (char !== TATWEEL && !FORMAT.test(char)) {
        for (const part of char.normalize('NFD')) {
          if (MARK.test(part)) continue;
          const lower = part.toLowerCase();
          for (const c of ARABIC_VARIANTS[lower] ?? LATIN_VARIANTS[lower] ?? lower) {
            parts.push(c);
            from.push(i);
          }
        }
      }
    }
    i += width;
  }
  return { text: parts.join(''), from };
}

/** The original span of a folded span, with any marks that follow it. */
function originalSpan(original: string, folded: Folded, start: number, end: number) {
  const from = folded.from[start];
  const lastStart = folded.from[end - 1];
  let to = lastStart + (original.codePointAt(lastStart)! > 0xffff ? 2 : 1);
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
  /** Folded, with the article, prefixes and common spellings written one way. */
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

/**
 * Common names written several ways in Latin letters, and one spelling for
 * each: so Muhammad is Mohammed, and Aicha is Aisha. Not every name, and
 * not every spelling: the spec's "Limits of name removal".
 */
const SPELLINGS: Record<string, string> = {};
for (const [one, ...others] of [
  ['muhammad', 'mohammed', 'mohamed', 'mohammad', 'mohamad', 'muhammed', 'muhamed', 'mohamud', 'mohd', 'mehmet'],
  ['ahmad', 'ahmed'],
  ['husain', 'hussein', 'hussain', 'hossein', 'husein', 'hussien', 'houssein'],
  ['hasan', 'hassan'],
  ['husni', 'hosni'],
  ['khalid', 'khaled'],
  ['umar', 'omar', 'omer'],
  ['yusuf', 'youssef', 'yousef', 'youssouf', 'yousif', 'yusef', 'youcef'],
  ['mustafa', 'moustafa', 'mostafa', 'mustapha', 'moustapha'],
  ['fatima', 'fatma', 'fatimah', 'fatema', 'fatouma'],
  ['aisha', 'aicha', 'aysha', 'ayesha', 'aishah', 'aischa'],
  ['maryam', 'mariam', 'meriem', 'maryem', 'myriam'],
  ['ibrahim', 'ebrahim', 'ibraheem', 'brahim'],
  ['uthman', 'othman', 'osman', 'usman', 'otman'],
  ['salih', 'saleh'],
  ['karim', 'kareem'],
  ['said', 'saeed', 'saeid', 'saied'],
  ['nur', 'nour', 'noor'],
  ['layla', 'leila', 'laila', 'leyla', 'leyla'],
  ['huda', 'houda', 'hoda'],
  ['zaynab', 'zainab', 'zeinab'],
  ['amina', 'aminah', 'amineh'],
  ['yasmin', 'yasmine', 'yasmeen'],
  ['abbas', 'abass'],
  ['hamza', 'hamzah'],
  ['jamal', 'gamal'],
  ['rashid', 'rachid', 'rasheed'],
  ['walid', 'waleed', 'oualid'],
  ['yahya', 'yahia'],
]) {
  for (const spelling of [one, ...others]) SPELLINGS[spelling] = one;
}

/** One spelling for a name written several ways, alone or after a particle. */
function spelled(norm: string): string {
  const known = SPELLINGS[norm];
  if (known) return known;
  for (const particle of ['abdal', 'abu', 'al']) {
    if (norm.length > particle.length && norm.startsWith(particle)) {
      const rest = SPELLINGS[norm.slice(particle.length)];
      if (rest) return particle + rest;
    }
  }
  return norm;
}

/** One spelling for the particles at the start of a word, and for the name. */
function canonical(norm: string): string {
  return spelled(
    norm
      .replace(/^abd(?:el|ul|al)*/u, 'abdal')
      .replace(/^(?:el|ul)(?=\p{L}{3,}|$)/u, 'al')
      .replace(/^abou/u, 'abu'),
  );
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
 * The shortest part of a name looked for in lower case, in Latin script:
 * reports typed on a phone often have none ("spoke to mohammed"). Shorter
 * parts are too often ordinary words.
 */
const MIN_LOWERCASE_PART = 4;

/**
 * English and French words that are also names: never taken for one when
 * written in lower case. With a capital, they still are.
 */
const ORDINARY_WORDS = new Set([
  'will', 'mark', 'rose', 'hope', 'grace', 'faith', 'june', 'april', 'august', 'bill', 'dean', 'page',
  'dawn', 'summer', 'frank', 'earl', 'miles', 'hunter', 'carter', 'banks', 'rivers', 'chase', 'price',
  'cook', 'baker', 'king', 'young', 'white', 'black', 'brown', 'green', 'gray', 'grey', 'long', 'short',
  'little', 'best', 'hall', 'wood', 'stone', 'field', 'ford', 'bush', 'ward', 'bell', 'park', 'lane',
  'hill', 'moss', 'bond', 'cash', 'case', 'cross', 'house', 'rich', 'pearl', 'ruby', 'amber', 'holly',
  'lily', 'daisy', 'iris', 'violet', 'said', 'sage', 'reed', 'wells', 'english', 'french', 'major',
  'pierre', 'blanc', 'petit', 'grand', 'noir', 'roux', 'claire', 'france', 'fleur', 'lune', 'salle',
  'aime', 'marin', 'rivet', 'masse', 'leger', 'bonne', 'clement',
]);

/**
 * Letters an Arabic word may begin with before a name: and, so, with, to,
 * like, and "and" or "so" before one of the others (ولمحمد: and to Mohammed).
 */
const ARABIC_PREFIXES = ['و', 'ف', 'ب', 'ل', 'ك', 'وب', 'ول', 'وك', 'فب', 'فل', 'فك'];

/**
 * The names to look for, folded: whole names as sequences of words, and
 * their parts. Built once per request from the client's people and what the
 * feature passes in, and added to with the names found by the words around
 * them (`Redaction.learn`).
 */
export class NameIndex {
  /** Whole names (two words or more), by their first word, longest first. */
  private readonly sequences = new Map<string, string[][]>();
  /** Parts of names that are looked for on their own. */
  private readonly parts = new Set<string>();

  constructor(names: Iterable<string>) {
    for (const name of names) this.add(name);
  }

  get size() {
    return this.parts.size;
  }

  /** Adds a name, as written in any language. */
  add(name: string) {
    if (!name || !name.trim()) return;
    const folded = fold(name.slice(0, 500));
    const raw = wordsOf(name, folded);
    for (const words of [raw, joined(folded, raw)]) {
      // Titles at the start are not part of the name to look for.
      let list = words.map((w) => w.norm);
      while (list.length > 1 && NOT_A_NAME.has(list[0])) list = list.slice(1);
      if (list.some((n) => /\d/.test(n)) || list.length > 8) continue;
      if (list.length >= 2) {
        const byFirst = this.sequences.get(list[0]) ?? [];
        if (!byFirst.some((s) => s.join(' ') === list.join(' '))) {
          byFirst.push(list);
          byFirst.sort((a, b) => b.length - a.length);
        }
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
   * Latin script when written with a capital, or in lower case when it is
   * long enough and not an ordinary word (so "will" is not taken for Will);
   * Arabic has no capitals, so there every part counts.
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
    ];
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.length - a.length);
    for (const sequence of candidates) {
      if (i + sequence.length > words.length) continue;
      const skip = this.matches(first, sequence[0]);
      if (skip === null) continue;
      let ok = true;
      for (let k = 1; k < sequence.length && ok; k++) {
        const gap = folded.text.slice(words[i + k - 1].end, words[i + k].start);
        ok = NAME_GAP.test(gap) && words[i + k].norm === sequence[k];
      }
      // A whole name in lower case made only of ordinary or short words
      // ("will mark" for Will Mark) is not taken for the name.
      const found = words.slice(i, i + sequence.length);
      if (ok && !first.arabic && found.every((w) => !w.capital && (w.norm.length < MIN_LOWERCASE_PART || ORDINARY_WORDS.has(w.norm)))) {
        ok = false;
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
    if (!word.arabic && !word.capital && (word.norm.length < MIN_LOWERCASE_PART || ORDINARY_WORDS.has(word.norm))) {
      return null;
    }
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
// Names found by the words around them.
// ---------------------------------------------------------------------------

/**
 * Titles and words for a relationship that a name follows, folded: "Patient
 * Aisha Rahman", "her son Omar", "Mme Dubois", "son fils Pierre",
 * "المريضة عائشة", "ابنها عمر".
 */
const LATIN_ANNOUNCERS = new Set([
  'patient', 'patients', 'pt', 'mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'doctor', 'nurse', 'sister', 'prof',
  'professor', 'sir', 'madam', 'sheikh',
  'son', 'daughter', 'wife', 'husband', 'mother', 'father', 'brother', 'child', 'baby', 'infant', 'grandson',
  'granddaughter', 'grandmother', 'grandfather', 'aunt', 'uncle', 'cousin', 'nephew', 'niece', 'relative',
  'visitor', 'witness', 'guardian', 'carer', 'caregiver', 'colleague', 'resident', 'partner', 'fiance',
  'patiente', 'mme', 'mlle', 'monsieur', 'madame', 'mademoiselle', 'docteur', 'infirmier', 'infirmiere',
  'fils', 'fille', 'epouse', 'epoux', 'mari', 'femme', 'mere', 'pere', 'frere', 'soeur', 'enfant', 'bebe',
  'tante', 'oncle', 'neveu', 'niece', 'temoin', 'visiteur', 'visiteuse', 'proche', 'collegue', 'residente',
  'compagnon', 'compagne', 'tuteur', 'tutrice', 'grand-mere',
]);

const ARABIC_ANNOUNCERS = new Set([
  'المريض', 'المريضه', 'مريض', 'مريضه', 'السيد', 'السيده', 'سيد', 'سيده', 'الدكتور', 'الدكتوره', 'دكتور',
  'دكتوره', 'د', 'الممرض', 'الممرضه', 'ممرض', 'ممرضه', 'الاستاذ', 'الاستاذه', 'الشيخ', 'المهندس',
  'ابن', 'ابنه', 'ابنها', 'ابنته', 'ابنتها', 'بنت', 'بنته', 'بنتها', 'زوج', 'زوجه', 'زوجته', 'زوجها',
  'ام', 'امه', 'امها', 'والد', 'والده', 'والدته', 'والدها', 'اخ', 'اخوه', 'اخوها', 'اخت', 'اخته', 'اختها',
  'جد', 'جده', 'جدته', 'جدها', 'عم', 'عمه', 'خال', 'خاله', 'الطفل', 'الطفله', 'الرضيع', 'الرضيعه',
  'الزائر', 'الزائره', 'الشاهد', 'الشاهده', 'المرافق', 'المرافقه', 'قريب', 'قريبه', 'الزميل', 'الزميله',
  'المقيم', 'المقيمه',
]);

/** Arabic words that do not begin a name, after an announcing word. */
const ARABIC_NOT_NAMES = new Set([
  'في', 'من', 'الى', 'على', 'عن', 'مع', 'و', 'او', 'ثم', 'قد', 'لم', 'لا', 'ما', 'هو', 'هي', 'كان', 'كانت',
  'الذي', 'التي', 'هذا', 'هذه', 'ذلك', 'تلك', 'بعد', 'قبل', 'عند', 'حول', 'بسبب', 'اثناء', 'بين', 'كل',
  'غير', 'انه', 'انها', 'ان', 'اذا', 'حتى', 'لقد', 'منذ', 'الذين', 'لدي', 'لديه', 'لديها', 'وهو', 'وهي',
  'فقد', 'وقد', 'ايضا', 'جدا', 'الان', 'اليوم', 'امس', 'غدا', 'رقم', 'سرير', 'غرفه', 'قسم',
]);

/** How many words after an announcing word are taken for the name. */
const LATIN_NAME_WORDS = 3;
const ARABIC_NAME_WORDS = 2;

/**
 * Names announced by the words before them, in the folded text's
 * positions. In Latin script, the capitalised words after the announcing
 * word (up to three); in Arabic, which has no capitals, the words after it
 * (up to two) that cannot be anything else.
 */
function announcedNames(folded: Folded, words: Word[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    const word = words[i];
    const arabic = word.arabic;
    if (!(arabic ? ARABIC_ANNOUNCERS.has(word.norm) : LATIN_ANNOUNCERS.has(word.norm))) continue;
    let end = -1;
    let j = i + 1;
    for (let taken = 0; j < words.length && taken < (arabic ? ARABIC_NAME_WORDS : LATIN_NAME_WORDS); j++) {
      const next = words[j];
      const gap = folded.text.slice(words[j - 1].end, next.start);
      // A full stop after "Mr" or "M." is part of the title; a comma or a
      // colon may stand before the name ("the witness, Peter Jones").
      if (!NAME_GAP.test(gap) && !(taken === 0 && /^[.,:]?\s{1,3}$/u.test(gap))) break;
      if (next.arabic !== arabic) break;
      const name = arabic
        ? !ARABIC_NOT_NAMES.has(next.norm) && !ARABIC_ANNOUNCERS.has(next.norm) && !/\d/.test(next.norm)
        : (next.capital || (taken > 0 && LATIN_PARTICLES.has(next.norm))) &&
          !LATIN_ANNOUNCERS.has(next.norm) &&
          !NOT_A_NAME.has(next.norm) &&
          !/\d/.test(next.norm);
      if (!name) break;
      end = next.end;
      if (!LATIN_PARTICLES.has(next.norm)) taken++;
    }
    if (end > 0) {
      spans.push({ start: words[i + 1].start, end });
      i = j - 1;
    }
  }
  return spans;
}

// ---------------------------------------------------------------------------
// Identifiers.
// ---------------------------------------------------------------------------

/** An address: bounded on both sides, and starting only where a word does. */
const EMAIL = /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){1,8}/gu;

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
 * Words near which a number of six digits or more is a record's: "patient
 * 654321", "file 445566", "dossier du patient : 778812", "ملف ٤٥٢١٨٨".
 * Up to thirty characters, none of them a digit, may stand between.
 */
const RECORD_NEAR_WORDS = [
  'patients?', 'pt', 'files?', 'records?', 'charts?', 'case', 'admission', 'admitted', 'mrn', 'ipp', 'nip', 'bed',
  'patiente?s?', 'dossiers?', 'sejour', 'hospitalisation', 'admis', 'admise',
  'المريض', 'المريضه', 'مريض', 'مريضه', 'ملف', 'الملف', 'السجل', 'سجل', 'الدخول',
];
const RECORD_NEAR = new RegExp(`${B}(?:${RECORD_NEAR_WORDS.join('|')})[^\\d\\n]{0,30}?(?<![\\p{L}\\p{N}])(\\d{6,20})(?![\\p{N}])`, 'gu');

/** A run of digits too long to be anything but an identifier. */
const LONG_DIGITS = /(?<!\d)\d{20,}(?!\d)/g;

/**
 * A long number standing alone: seven digits or more (up to forty), possibly
 * with spaces, dots, dashes or brackets between them, and a leading + or 00.
 * Not part of a code that letters or digits run into (INC-2026-0042 stays
 * whole).
 */
const LONG_NUMBER = /(?<![\p{L}\p{N}][-_/.]?)(?<![\p{L}\p{N}+])(\+|00)?\(?\d(?:[ .\-() ]{0,2}\d){6,40}\)?(?![\p{L}\p{N}])/gu;

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

/** The longest name taken from one announcing word, as written. */
const MAX_LEARNED = 120;

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
   * Notes the placeholders a set of texts already contains, in any form a
   * placeholder is put back from ("[PERSON_1]", "PERSON_1", "[ PERSON_1 ]"),
   * so that none is made with the same number and a placeholder someone
   * typed can never be put back as somebody's name (security review 13,
   * M2). Call it with every text of the request before redacting any.
   */
  reserve(texts: Iterable<string>) {
    for (const text of texts) {
      for (const m of text.matchAll(PLACEHOLDER_LOOSE)) {
        this.taken.add(`[${m[1] ?? m[3]}_${m[2] ?? m[4]}]`);
      }
    }
  }

  /**
   * Learns the names that titles and words for a relationship announce in
   * any of these texts ("Patient Aisha Rahman"), so that they are removed
   * wherever else they appear ("Aisha was given…"). Call it with every text
   * of the request before redacting any.
   */
  learn(texts: Iterable<string>) {
    for (const text of texts) {
      if (!text) continue;
      const folded = fold(text);
      const words = joined(folded, wordsOf(text, folded));
      for (const span of announcedNames(folded, words)) {
        const { start, end } = originalSpan(text, folded, span.start, span.end);
        if (end - start <= MAX_LEARNED) this.names.add(text.slice(start, end));
      }
    }
  }

  /** The text with every name and identifier replaced. */
  redact(text: string): string {
    if (!text) return text;
    const folded = fold(text);
    const spans: Span[] = [];
    // Which folded characters are already claimed: each check and claim
    // touches only its own span, so claiming is one pass over the text.
    const claimed = new Uint8Array(folded.text.length);
    const claim = (start: number, end: number, kind: PlaceholderKind, key: string) => {
      if (end <= start) return;
      for (let i = start; i < end; i++) if (claimed[i]) return;
      claimed.fill(1, start, end);
      spans.push({ start, end, kind, key });
    };

    for (const m of folded.text.matchAll(EMAIL)) {
      claim(m.index, m.index + m[0].length, 'EMAIL', identifierKey('EMAIL', m[0]));
    }
    for (const [pattern, kind] of [[MRN_LED, 'MRN'], [ID_LED, 'ID'], [RECORD_NEAR, 'MRN']] as const) {
      for (const m of folded.text.matchAll(pattern)) {
        const value = m[1];
        const start = m.index + m[0].length - value.length;
        claim(start, start + value.length, kind, identifierKey(kind, value));
      }
    }
    for (const m of folded.text.matchAll(LONG_DIGITS)) {
      claim(m.index, m.index + m[0].length, 'ID', m[0]);
    }
    for (const m of folded.text.matchAll(LONG_NUMBER)) {
      const kind = kindOfNumber(m[0]);
      if (kind) claim(m.index, m.index + m[0].length, kind, identifierKey(kind, m[0]));
    }

    // Names are looked for outside the identifiers found, so that a name
    // running into an address ("Khalid khalid@…") is still found in part.
    // The masked text is built in one pass.
    const pieces: string[] = [];
    let at = 0;
    for (const span of [...spans].sort((a, b) => a.start - b.start)) {
      pieces.push(folded.text.slice(at, span.start), ' '.repeat(span.end - span.start));
      at = span.end;
    }
    pieces.push(folded.text.slice(at));
    const masked: Folded = { text: pieces.join(''), from: folded.from };
    const words = wordsOf(text, masked);
    const joinedWords = joined(masked, words);
    const nameSpans = [
      ...announcedNames(masked, joinedWords),
      ...this.names.find(masked, words),
      ...this.names.find(masked, joinedWords),
    ].sort((a, b) => a.start - b.start || b.end - a.end);
    // Overlapping finds of the readings are one name: the widest.
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
    const out: string[] = [];
    let done = 0;
    for (const span of spans) {
      const { start, end } = originalSpan(text, folded, span.start, span.end);
      if (start < done) continue;
      out.push(text.slice(done, start), this.placeholderFor(span, text.slice(start, end)));
      done = end;
    }
    out.push(text.slice(done));
    return out.join('');
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

/** A key for "the same name", however it was spaced, hyphenated or spelled. */
function personKey(foldedSpan: string): string {
  return canonical([...foldedSpan.matchAll(WORD)].map((m) => canonical(m[0])).join(''));
}
