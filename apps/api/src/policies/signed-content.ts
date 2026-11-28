import type { DocumentContent, DocumentSection } from '../database/schema.js';
import type { Localized } from '../i18n/locales.js';

/**
 * Exactly what an approval or an acknowledgement of a version signs, and
 * what its content hash is a hash of: which document and version, the
 * sections it is written in, every word of it in every language, its
 * change summary and what it asks of its readers; and, for a version sent
 * or imported since migration 0049, the authoritative language recorded on
 * it (security review 7, finding 3). A version recorded by that migration
 * keeps the earlier form, so that the signatures made over it stay valid.
 * Published versions never change, and a version in review cannot be
 * edited, so a hash taken now is of what the signer was shown.
 */
export const signedVersion = (
  doc: { id: string; number: string },
  version: {
    id: string;
    version: number;
    sections: DocumentSection[];
    content: DocumentContent;
    changeSummary: Localized | null;
    acknowledgementRequired: boolean;
    acknowledgeWithinDays: number;
    authoritativeLocale: string | null;
    signsAuthoritativeLocale: boolean;
  },
) => ({
  documentId: doc.id,
  number: doc.number,
  versionId: version.id,
  version: version.version,
  sections: version.sections,
  content: version.content,
  changeSummary: version.changeSummary ?? null,
  acknowledgementRequired: version.acknowledgementRequired,
  acknowledgeWithinDays: version.acknowledgeWithinDays,
  ...(version.signsAuthoritativeLocale && {
    authoritativeLocale: version.authoritativeLocale,
  }),
});

/** What the original of an imported document says of itself. */
export type ImportedOriginal = {
  numberAsGiven: string | null;
  revisionLabel: string | null;
  approvedOn: string;
  approvedBy: string;
  originalKeptAt: Localized;
  effectiveOn: string;
  nextReviewOn: string;
};

/**
 * What the importer of a document signs (meaning `imported`): that the
 * version holds the text of the original approved before Trustline, and
 * what the original says of its approval. The version as an approval signs
 * it, with those details beside it.
 */
export const signedImport = (
  doc: Parameters<typeof signedVersion>[0],
  version: Parameters<typeof signedVersion>[1],
  original: ImportedOriginal,
) => ({
  ...signedVersion(doc, version),
  importedOriginal: original,
});
