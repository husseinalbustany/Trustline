import { z } from 'zod';
import {
  fitsLanguages,
  localizedText,
  optionalLocalizedText,
  type LanguageSettings,
  type Localized,
} from '../i18n/locales.js';
import { line } from '../i18n/text.js';

/**
 * The client profile (docs/specs/ai-policy-drafting.md, "The client
 * profile"): facts about the organization, never about a person. Every
 * text a client writes is per language. Its structure is the organization
 * tree already in Trustline, its languages and its numbering are the
 * client's settings and document types: none is written here twice.
 */

export const SECTORS = [
  'healthcare',
  'manufacturing',
  'logistics',
  'education',
  'public_sector',
  'services',
  'retail',
  'energy',
  'construction',
  'other',
] as const;

const count = z.number().int().min(0).max(10_000_000);
const name = (max: number) => localizedText(max);
const optionalName = (max: number) => localizedText(max).nullable();

export const profileSchema = z.strictObject({
  identity: z.strictObject({
    legalName: name(200),
    tradingName: optionalName(200),
    sector: z.enum(SECTORS),
    // In the organization's own words: "a general hospital", "a bottling plant".
    organizationType: optionalName(200),
    ownership: z.enum(['public', 'private', 'non_profit', 'mixed']).nullable(),
    staffCount: count.nullable(),
    siteCount: count.nullable(),
    // What the sector counts: beds, production lines, vehicles, pupils.
    measures: z.array(z.strictObject({ label: name(100), value: count })).max(10),
  }),
  services: z.strictObject({
    provided: z.array(name(300)).max(100),
    notProvided: z.array(name(300)).max(100),
  }),
  // The committees and what each approves; the rest of the structure is the
  // organization tree.
  committees: z.array(z.strictObject({ name: name(200), approves: optionalLocalizedText(1000) })).max(50),
  // The job titles the organization uses, and the Trustline role each maps to.
  titles: z.array(z.strictObject({ title: name(150), roleId: z.uuid().nullable() })).max(200),
  standards: z
    .array(
      z.strictObject({
        kind: z.enum(['standard', 'regulation', 'licensing_body']),
        name: name(200),
        edition: line(1, 60).nullable(),
      }),
    )
    .max(50),
  glossary: z
    .array(
      z.strictObject({
        preferred: name(150),
        // The forms not to use, in each language.
        avoid: optionalName(300),
        note: optionalLocalizedText(500),
      }),
    )
    .max(300),
  abbreviations: z.array(z.strictObject({ short: line(1, 20), meaning: name(200) })).max(200),
  houseRules: z.strictObject({
    // Who may own a document; how long documents and records are kept; anything else.
    documentOwners: optionalLocalizedText(1000),
    retention: optionalLocalizedText(1000),
    other: optionalLocalizedText(2000),
  }),
  relatedSystems: z.array(z.strictObject({ name: line(1, 100), purpose: optionalLocalizedText(300) })).max(50),
});

export type ProfileInput = z.infer<typeof profileSchema>;

export const PROFILE_PARTS = [
  'identity',
  'services',
  'committees',
  'titles',
  'standards',
  'glossary',
  'abbreviations',
  'houseRules',
  'relatedSystems',
] as const satisfies readonly (keyof ProfileInput)[];

export const putProfileSchema = profileSchema.extend({
  // The revision read; 0 when there was no profile yet.
  revision: z.number().int().min(0),
});

/** An empty profile, as a client without one is shown. */
export function emptyProfile(legalName: Localized): ProfileInput {
  return {
    identity: {
      legalName,
      tradingName: null,
      sector: 'other',
      organizationType: null,
      ownership: null,
      staffCount: null,
      siteCount: null,
      measures: [],
    },
    services: { provided: [], notProvided: [] },
    committees: [],
    titles: [],
    standards: [],
    glossary: [],
    abbreviations: [],
    houseRules: { documentOwners: null, retention: null, other: null },
    relatedSystems: [],
  };
}

/** Every text of a profile that is written per language. */
export function textsOf(p: ProfileInput): (Localized | null)[] {
  return [
    p.identity.legalName,
    p.identity.tradingName,
    p.identity.organizationType,
    ...p.identity.measures.map((m) => m.label),
    ...p.services.provided,
    ...p.services.notProvided,
    ...p.committees.flatMap((c) => [c.name, c.approves]),
    ...p.titles.map((t) => t.title),
    ...p.standards.map((s) => s.name),
    ...p.glossary.flatMap((g) => [g.preferred, g.avoid, g.note]),
    ...p.abbreviations.map((a) => a.meaning),
    p.houseRules.documentOwners,
    p.houseRules.retention,
    p.houseRules.other,
    ...p.relatedSystems.map((r) => r.purpose),
  ];
}

/**
 * Whether a profile fits the client's languages: no text in a language
 * the client does not use, and the legal name in its default language.
 */
export function profileFits(p: ProfileInput, languages: LanguageSettings) {
  return (
    fitsLanguages(p.identity.legalName, languages) &&
    textsOf(p).every((t) => fitsLanguages(t, languages, { required: false }))
  );
}
