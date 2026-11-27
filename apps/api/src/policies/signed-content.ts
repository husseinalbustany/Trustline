import type { DocumentContent, DocumentSection } from '../database/schema.js';
import type { Localized } from '../i18n/locales.js';

/**
 * Exactly what an approval or an acknowledgement of a version signs, and
 * what its content hash is a hash of: which document and version, the
 * sections it is written in, every word of it in every language, its
 * change summary and what it asks of its readers. Published versions never
 * change, and a version in review cannot be edited, so a hash taken now is
 * of what the signer was shown.
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
});
