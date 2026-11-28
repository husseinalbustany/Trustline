import { z } from 'zod';
import {
  fitsLanguages,
  localizedText,
  optionalLocalizedText,
  SUPPORTED_LOCALES,
  type LanguageSettings,
  type Localized,
} from '../i18n/locales.js';
import type { ProfileInput } from './profile-input.js';

/**
 * The document design (docs/specs/ai-policy-drafting.md, "The document
 * design"): the template rules a reader and an exported file see, the
 * writing rules, and guidance per section. The structure itself, the
 * sections and which are required, is the document type's: a design does
 * not hold it twice.
 */

/** What the control block of a document may show, in this order. */
export const CONTROL_FIELDS = [
  'number',
  'title',
  'version',
  'owner',
  'effectiveOn',
  'reviewOn',
  'approvals',
] as const;

const COLOUR = /^#[0-9a-fA-F]{6}$/;

export const templateSchema = z.strictObject({
  header: localizedText(200).nullable(),
  footer: localizedText(200).nullable(),
  showLogo: z.boolean(),
  font: z.enum(['sans', 'serif']),
  accentColor: z.string().regex(COLOUR),
  controlBlock: z
    .array(z.enum(CONTROL_FIELDS))
    .min(1)
    .max(CONTROL_FIELDS.length)
    .refine((list) => new Set(list).size === list.length),
  // Where the client works in more than one language; right-to-left
  // follows from the language.
  bilingualLayout: z.enum(['one_language_per_document', 'side_by_side', 'one_after_another']),
});

export const writingSchema = z.strictObject({
  // The organization's own rules, each a sentence: voice, tense, length.
  rules: z.array(localizedText(300)).max(40),
  maxSentenceWords: z.number().int().min(8).max(80).nullable(),
  steps: z.enum(['numbered_one_action', 'numbered']),
  // How a requirement is told from guidance.
  requirements: z.enum(['must_should_may', 'shall_should_may']),
  // Standards are cited by requirement number only, unless the client has
  // the right to quote their text (the spec's decision 2).
  citations: z.enum(['by_number', 'by_number_and_title']),
  useGlossary: z.boolean(),
  // What never appears.
  never: z.array(localizedText(200)).max(20),
});

const sectionKey = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);

export const putDesignSchema = z.strictObject({
  // Null: the organization's design, for every type without its own.
  documentTypeId: z.uuid().nullable(),
  template: templateSchema,
  writing: writingSchema,
  sectionGuidance: z
    .record(sectionKey, optionalLocalizedText(1000))
    .refine((r) => Object.keys(r).length <= 40),
  // The version read; 0 when there was none of its own.
  version: z.number().int().min(0),
});

export type Template = z.infer<typeof templateSchema>;
export type Writing = z.infer<typeof writingSchema>;
export type DesignInput = z.infer<typeof putDesignSchema>;

type Words = Record<(typeof SUPPORTED_LOCALES)[number], string>;

/** The writing rules every client starts with, for any organization. */
const DEFAULT_RULES: Words[] = [
  {
    en: 'Write in the active voice and the present tense: “The supervisor checks the log”, not “The log should be checked”.',
    ar: 'اكتب بصيغة المبني للمعلوم وبالزمن المضارع: «يفحص المشرف السجل»، لا «ينبغي أن يُفحص السجل».',
    fr: 'Écrire à la voix active et au présent : « Le responsable vérifie le registre », et non « Le registre doit être vérifié ».',
  },
  {
    en: 'One action per step, with who does it.',
    ar: 'إجراء واحد في كل خطوة، مع ذكر من يقوم به.',
    fr: 'Une seule action par étape, avec la personne qui l’exécute.',
  },
  {
    en: 'Name roles and units, never people.',
    ar: 'اذكر الأدوار والوحدات، ولا تذكر أسماء الأشخاص أبدًا.',
    fr: 'Nommer des fonctions et des unités, jamais des personnes.',
  },
];

const DEFAULT_NEVER: Words[] = [
  {
    en: 'Names of patients, customers or staff',
    ar: 'أسماء المرضى أو العملاء أو الموظفين',
    fr: 'Les noms de patients, de clients ou de membres du personnel',
  },
  {
    en: 'Brand names, unless necessary',
    ar: 'الأسماء التجارية، إلا عند الضرورة',
    fr: 'Les noms de marque, sauf si nécessaire',
  },
];

/** A text in the client's languages only. */
const inLanguages = (words: Words, languages: LanguageSettings): Localized =>
  Object.fromEntries(languages.locales.filter((l): l is keyof Words => l in words).map((l) => [l, words[l]]));

/**
 * The design a client has until it saves one: its name from the profile in
 * the header, every field of the control block, and the starting writing
 * rules in its languages.
 */
export function defaultDesign(profile: ProfileInput, languages: LanguageSettings) {
  return {
    template: {
      header: profile.identity.legalName,
      footer: null,
      showLogo: true,
      font: 'sans' as const,
      accentColor: '#1F4E79',
      controlBlock: [...CONTROL_FIELDS],
      bilingualLayout: 'one_language_per_document' as const,
    } satisfies Template,
    writing: {
      rules: DEFAULT_RULES.map((w) => inLanguages(w, languages)),
      maxSentenceWords: 25,
      steps: 'numbered_one_action' as const,
      requirements: 'must_should_may' as const,
      citations: 'by_number' as const,
      useGlossary: true,
      never: DEFAULT_NEVER.map((w) => inLanguages(w, languages)),
    } satisfies Writing,
    sectionGuidance: {} as Record<string, Localized>,
  };
}

/** Whether every text of a design fits the client's languages. */
export function designFits(d: Pick<DesignInput, 'template' | 'writing' | 'sectionGuidance'>, languages: LanguageSettings) {
  const texts: (Localized | null)[] = [
    d.template.header,
    d.template.footer,
    ...d.writing.rules,
    ...d.writing.never,
    ...Object.values(d.sectionGuidance),
  ];
  return texts.every((t) => fitsLanguages(t, languages, { required: false }));
}
