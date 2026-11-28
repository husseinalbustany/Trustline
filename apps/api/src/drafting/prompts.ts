import { z } from 'zod';
import { asData, DATA_RULES } from '../ai/prompt.js';
import type { DocumentContent, DocumentSection } from '../database/schema.js';
import { pickText, type Localized } from '../i18n/locales.js';
import type { EffectiveDesign } from './design.service.js';
import type { ProfileInput } from './profile-input.js';

/**
 * What the drafting assistant is told, and what it must answer
 * (docs/specs/ai-policy-drafting.md). Instructions are ours, in the system
 * text; everything written by the client or a person (the profile, the
 * request, answers, existing documents, the draft itself) goes in as data,
 * through `asData()`. Every answer is checked against a Zod schema.
 *
 * AiService refuses a message over 20,000 characters, so each part has a
 * budget and is cut to it.
 */

/** Questions a round may ask, and rounds before the draft must be written. */
export const QUESTIONS_PER_ROUND = 5;
export const MAX_ROUNDS = 3;
/** Existing documents given to the assistant, and how much of each. */
export const MAX_SOURCES = 3;
const SOURCE_CHARS = 2_800;
/** The longest draft the assistant is given back to revise. */
export const MAX_DRAFT_FOR_REVISION = 14_000;

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', ar: 'Arabic', fr: 'French' };

export const questionsAnswer = z.object({
  questions: z
    .array(z.object({ text: z.string().min(1).max(500), reason: z.string().min(1).max(500) }))
    .max(QUESTIONS_PER_ROUND),
  ready: z.boolean(),
});

export const draftAnswer = z.object({
  title: z.string().min(1).max(200),
  sections: z.array(z.object({ key: z.string().min(1).max(40), text: z.string().max(20_000) })).max(40),
  // The numbers of the existing documents it drew on, among those given.
  sources: z.array(z.string().max(60)).max(20),
});

export type QuestionsAnswer = z.infer<typeof questionsAnswer>;
export type DraftAnswer = z.infer<typeof draftAnswer>;

// ---------------------------------------------------------------------------
// Gaps and assumptions, marked in the text.
// ---------------------------------------------------------------------------

/** How the assistant marks them: `[[gap: …]]` and `[[assumed: …]]`. */
const MODEL_MARK = /\[\[\s*(gap|assumed)\s*:\s*([^[\]\n]{1,300}?)\s*\]\]/giu;

const GAP_WORDS: Record<string, string> = { en: 'To be decided', fr: 'À décider', ar: 'لم يُحدَّد بعد' };
const ASSUMED_WORDS: Record<string, string> = { en: 'Assumed', fr: 'Hypothèse', ar: 'افتراض' };

const colon = (locale: string) => (locale === 'fr' ? ' : ' : ': ');

/** A gap as the reader sees it, in the draft's language. */
export const gapMark = (locale: string, text: string) => `[${GAP_WORDS[locale] ?? GAP_WORDS.en}${colon(locale)}${text}]`;
/** An assumption as the reader sees it. */
export const assumedMark = (locale: string, text: string) =>
  `[${ASSUMED_WORDS[locale] ?? ASSUMED_WORDS.en}${colon(locale)}${text}]`;

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SHOWN_MARK = new RegExp(
  `\\[(${[...Object.values(GAP_WORDS), ...Object.values(ASSUMED_WORDS)].map(escape).join('|')})\\s?:\\s?([^[\\]\\n]{1,300})\\]`,
  'gu',
);
const GAP_SET = new Set(Object.values(GAP_WORDS));

/** Whether a text still holds a gap someone must fill, in any language. */
export function holdsGap(text: string): boolean {
  for (const m of text.matchAll(SHOWN_MARK)) if (GAP_SET.has(m[1])) return true;
  return false;
}

/** The gaps and assumptions marked in a version's text, as the reader sees them. */
export function marksOf(content: DocumentContent) {
  const gaps: { section: string; text: string }[] = [];
  const assumptions: { section: string; text: string }[] = [];
  for (const sections of Object.values(content)) {
    for (const [section, text] of Object.entries(sections ?? {})) {
      for (const m of text.matchAll(SHOWN_MARK)) {
        (GAP_SET.has(m[1]) ? gaps : assumptions).push({ section, text: m[2].trim() });
      }
    }
  }
  return { gaps, assumptions };
}

/** The assistant's marks, turned into the marks a reader sees. */
export function showMarks(text: string, locale: string): string {
  return text.replace(MODEL_MARK, (_whole, kind: string, said: string) =>
    kind.toLowerCase() === 'gap' ? gapMark(locale, said.trim()) : assumedMark(locale, said.trim()),
  );
}

// ---------------------------------------------------------------------------
// Context.
// ---------------------------------------------------------------------------

const clamp = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/** The profile as facts, in the draft's language. */
export function profileFacts(p: ProfileInput, locale: string, defaultLocale: string): string {
  const t = (x: Localized | null | undefined) => (x ? pickText(x, locale, defaultLocale) : '');
  const list = (items: string[]) => items.filter(Boolean).join('; ');
  const lines = [
    `Legal name: ${t(p.identity.legalName)}`,
    p.identity.tradingName && `Trading name: ${t(p.identity.tradingName)}`,
    `Sector: ${p.identity.sector}${p.identity.organizationType ? `; type: ${t(p.identity.organizationType)}` : ''}`,
    p.identity.ownership && `Ownership: ${p.identity.ownership}`,
    p.identity.staffCount !== null && `Staff: ${p.identity.staffCount}`,
    p.identity.siteCount !== null && `Sites: ${p.identity.siteCount}`,
    ...p.identity.measures.map((m) => `${t(m.label)}: ${m.value}`),
    p.services.provided.length > 0 && `Services provided: ${list(p.services.provided.map(t))}`,
    p.services.notProvided.length > 0 && `Not provided: ${list(p.services.notProvided.map(t))}`,
    p.committees.length > 0 &&
      `Committees: ${list(p.committees.map((c) => `${t(c.name)}${c.approves ? ` (approves: ${t(c.approves)})` : ''}`))}`,
    p.titles.length > 0 && `Job titles used: ${list(p.titles.map((x) => t(x.title)))}`,
    p.standards.length > 0 &&
      `Standards and rules followed: ${list(p.standards.map((s) => `${t(s.name)}${s.edition ? ` (${s.edition})` : ''} [${s.kind}]`))}`,
    p.glossary.length > 0 &&
      `Terms: ${list(p.glossary.map((g) => `use "${t(g.preferred)}"${g.avoid ? ` not "${t(g.avoid)}"` : ''}${g.note ? ` (${t(g.note)})` : ''}`))}`,
    p.abbreviations.length > 0 && `Abbreviations allowed: ${list(p.abbreviations.map((a) => `${a.short} = ${t(a.meaning)}`))}`,
    p.houseRules.documentOwners && `Who may own a document: ${t(p.houseRules.documentOwners)}`,
    p.houseRules.retention && `Retention: ${t(p.houseRules.retention)}`,
    p.houseRules.other && `Other house rules: ${t(p.houseRules.other)}`,
    p.relatedSystems.length > 0 &&
      `Systems staff use: ${list(p.relatedSystems.map((r) => `${r.name}${r.purpose ? ` (${t(r.purpose)})` : ''}`))}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/** The design's rules and the type's sections, for the system text. */
function designRules(design: EffectiveDesign, sections: DocumentSection[], locale: string, defaultLocale: string) {
  const t = (x: Localized | null | undefined) => (x ? pickText(x, locale, defaultLocale) : '');
  const w = design.writing;
  return [
    'Writing rules of the organization:',
    ...w.rules.map((r) => `- ${t(r)}`),
    w.maxSentenceWords !== null && `- Sentences of ${w.maxSentenceWords} words at most.`,
    w.steps === 'numbered_one_action' ? '- Steps are numbered, one action each, each saying who does it.' : '- Steps are numbered.',
    w.requirements === 'must_should_may'
      ? '- "must" is a requirement, "should" a recommendation, "may" a permission.'
      : '- "shall" is a requirement, "should" a recommendation, "may" a permission.',
    w.citations === 'by_number'
      ? '- Cite a standard by its requirement number only, never quoting its text.'
      : '- Cite a standard by its requirement number and title, never quoting its text.',
    w.useGlossary && '- Use the organization’s preferred terms, never the forms to avoid.',
    ...w.never.map((n) => `- Never write: ${t(n)}.`),
    '',
    'Sections, in this order (key: name):',
    ...sections.map(
      (s) =>
        `- ${s.key}: ${t(s.name)}${s.required ? ' (required)' : ''}${design.sectionGuidance[s.key] ? `. Guidance: ${t(design.sectionGuidance[s.key])}` : ''}`,
    ),
  ]
    .filter((l) => l !== false)
    .join('\n');
}

export type DraftingContext = {
  locale: string;
  defaultLocale: string;
  typeName: string;
  sections: DocumentSection[];
  profile: ProfileInput;
  design: EffectiveDesign;
  /** The organization's units, indented, in the draft's language. */
  structure: string;
};

const ROLE = [
  'You help a person at an organization write a controlled document (a policy or a procedure) in Trustline.',
  'You write drafts only. A person decides everything: you never approve, publish or present a draft as approved.',
  'You have no tools and nothing you write is acted on.',
  DATA_RULES,
].join(' ');

/** The system text shared by every step: who the assistant is, the rules, the organization. */
export function systemText(ctx: DraftingContext, task: string): string {
  const language = LANGUAGE_NAMES[ctx.locale] ?? ctx.locale;
  return [
    ROLE,
    `The document is a ${ctx.typeName}. Write in ${language}.`,
    task,
    clamp(designRules(ctx.design, ctx.sections, ctx.locale, ctx.defaultLocale), 4_000),
    asData('organization profile', clamp(profileFacts(ctx.profile, ctx.locale, ctx.defaultLocale), 7_000)),
    asData('organization structure', clamp(ctx.structure, 3_000)),
  ].join('\n\n');
}

export const QUESTIONS_TASK = [
  'Decide what you still need to know to write this document well.',
  `Ask only what you cannot work out from the organization's facts, the request and the answers already given: at most ${QUESTIONS_PER_ROUND} questions, each with the reason you ask it.`,
  'Typical questions: who it applies to, who is responsible for each step, how often, what is recorded and where, what happens when a step cannot be done, which existing documents it must agree with.',
  'If you know enough, ask nothing and set "ready" to true.',
  'Answer with JSON only: {"questions": [{"text": "...", "reason": "..."}], "ready": true|false}.',
].join(' ');

export const DRAFT_TASK = [
  'Write the draft: one entry in "sections" per section key listed above, in that order, each with its text.',
  'Never invent what you were not told. Where something is not known, or the person answered "not decided", write [[gap: what must be decided]] at that place instead.',
  'After every statement you assumed rather than were told, write [[assumed: the assumption]].',
  'Use only paragraphs, numbered and bulleted lists, bold (**text**) and headings (## or ###): no links, web or email addresses, tables, quotes or code.',
  'In "title" give the document a short title. In "sources" list the numbers of the existing documents given to you that you drew on, and no other.',
  'Answer with JSON only: {"title": "...", "sections": [{"key": "...", "text": "..."}], "sources": ["..."]}.',
].join(' ');

export const REVISION_TASK = [
  'The current draft and the change the person asks for are below. Write the whole draft again with that change made, and nothing else changed.',
  'Keep every gap and assumption still true, marked as [[gap: ...]] and [[assumed: ...]]; mark any new one the same way.',
  'Use only paragraphs, numbered and bulleted lists, bold (**text**) and headings (## or ###).',
  'Answer with JSON only: {"title": "...", "sections": [{"key": "...", "text": "..."}], "sources": ["..."]}.',
].join(' ');

export type QA = { round: number; text: string; reason: string; answer: string | null; answered: boolean };

/** The request and what was asked and answered, as data. */
export function conversationText(request: string, qa: QA[]): string {
  const parts = [asData('request', clamp(request, 4_000))];
  if (qa.length > 0) {
    parts.push('Questions asked and answers given:');
    let budget = 6_000;
    for (const q of qa) {
      const answer = !q.answered ? 'Not answered: treat as not decided.' : q.answer === null ? 'Not decided.' : null;
      const piece = `Question (round ${q.round}): ${q.text}\n${answer ?? asData('answer', clamp(q.answer!, 1_500))}`;
      if (piece.length > budget) break;
      budget -= piece.length;
      parts.push(piece);
    }
  }
  return parts.join('\n\n');
}

export type Source = { documentId: string; number: string; title: string; text: string };

/** Existing documents the person may read, as data. */
export function sourcesText(sources: Source[]): string {
  if (sources.length === 0) return 'No existing document was found to agree with.';
  return [
    'Existing documents of the organization, which the draft must agree with:',
    ...sources.map((s) => asData('existing document', `Number: ${s.number}\nTitle: ${s.title}\n\n${clamp(s.text, SOURCE_CHARS)}`)),
  ].join('\n\n');
}

/** A version's text in one language, as data, for a revision. */
export function draftText(sections: DocumentSection[], text: Record<string, string>, locale: string, defaultLocale: string) {
  return asData(
    'current draft',
    sections
      .filter((s) => text[s.key])
      .map((s) => `## ${s.key}: ${pickText(s.name, locale, defaultLocale)}\n${text[s.key]}`)
      .join('\n\n'),
  );
}
