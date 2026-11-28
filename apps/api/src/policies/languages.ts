import type { DocumentContent, DocumentSection } from '../database/schema.js';

/**
 * Which language of a document is authoritative: the one whose text stands
 * when two languages disagree, which readers of a language that is missing
 * a section are shown instead, against which the other languages are said
 * to lag, and in which a version's required sections and change summary
 * must be written before it is sent for review. Each client chooses it
 * (business decision 3: `document_settings.authoritative_locale`); until it
 * does, or if it stops working in the language it chose, it is the
 * client's main language. This is the one place that decides it: every
 * comparison of languages asks it, through `authoritativeLocaleOf`
 * (document-settings.ts) where it has a transaction.
 */
export function authoritativeLocale(
  tenant: { defaultLocale: string; locales: string[] },
  settings: { authoritativeLocale: string | null } = { authoritativeLocale: null },
) {
  const chosen = settings.authoritativeLocale;
  return chosen && tenant.locales.includes(chosen) ? chosen : tenant.defaultLocale;
}

/**
 * Where one section stands in one language:
 *
 * - `written`: it has text in this language (for the authoritative one,
 *   always so when it has text);
 * - `fallback`: no text in this language, but some in the authoritative
 *   one, which its readers are shown instead, with a note;
 * - `lagging`: it has text in this language, but the authoritative text
 *   changed since the previous published version and this one did not, so
 *   it may say something the authoritative text no longer says
 *   ("translation not updated");
 * - `empty`: no text in this language nor in the authoritative one.
 */
export type SectionLanguageState = 'written' | 'fallback' | 'lagging' | 'empty';

export type LanguageStatus = {
  authoritative: string;
  /** The published version it was compared with, if there was one. */
  comparedWith: { id: string; version: number } | null;
  sections: {
    key: string;
    locales: Record<string, SectionLanguageState>;
  }[];
  /** For each language, how many sections stand each way. */
  byLocale: Record<string, Record<SectionLanguageState, number>>;
  /** Whether any section lags in any language. */
  lagging: boolean;
};

const text = (content: DocumentContent | undefined, locale: string, key: string) =>
  content?.[locale]?.[key]?.trim() ?? '';

/**
 * Where every section of a version stands in each of the client's
 * languages, against its authoritative language and the version published
 * before it (`previous`: for a version in progress, the one published now;
 * for a published or superseded one, the one it replaced).
 */
export function languageStatus(
  version: { sections: DocumentSection[]; content: DocumentContent },
  previous: { id: string; version: number; content: DocumentContent } | null,
  locales: string[],
  authoritative: string,
): LanguageStatus {
  const order = [authoritative, ...locales.filter((l) => l !== authoritative)];
  const byLocale: LanguageStatus['byLocale'] = Object.fromEntries(
    order.map((l) => [l, { written: 0, fallback: 0, lagging: 0, empty: 0 }]),
  );
  const sections = version.sections.map((section) => {
    const main = text(version.content, authoritative, section.key);
    const mainChanged =
      !!previous && main !== text(previous.content, authoritative, section.key);
    const states: Record<string, SectionLanguageState> = {};
    for (const locale of order) {
      const here = text(version.content, locale, section.key);
      let state: SectionLanguageState;
      if (locale === authoritative) state = here ? 'written' : 'empty';
      else if (!here) state = main ? 'fallback' : 'empty';
      else if (
        mainChanged &&
        here === text(previous!.content, locale, section.key)
      ) {
        state = 'lagging';
      } else state = 'written';
      states[locale] = state;
      byLocale[locale][state] += 1;
    }
    return { key: section.key, locales: states };
  });
  return {
    authoritative,
    comparedWith: previous ? { id: previous.id, version: previous.version } : null,
    sections,
    byLocale,
    lagging: order.some((l) => byLocale[l].lagging > 0),
  };
}
