/**
 * What a document's PDF says, in one language (docs/specs/document-pdf.md):
 * the control block, the print rules and the notes, word for word as the
 * web's print view says them. Every language has exactly these keys and the
 * same placeholders (wording.spec.ts).
 */
export type PdfWording = {
  dir: 'ltr' | 'rtl';
  /** Each language by its name, in this language. */
  languages: Record<'en' | 'ar' | 'fr', string>;
  controlBlock: string;
  number: string;
  version: string;
  title: string;
  owner: string;
  ownerUnit: string;
  effectiveOn: string;
  nextReviewOn: string;
  authoritative: string;
  approvals: string;
  noApprovals: string;
  /** {name} and {date}. */
  preparedBy: string;
  reviewedBy: string;
  approvedBy: string;
  notSet: string;
  unknownPerson: string;
  notControlled: string;
  /** {number}, {version}, {title}; with {revision} for an imported version. */
  printHeader: string;
  printHeaderOriginal: string;
  /** {date}. */
  printedOn: string;
  /** {page} of {pages}. */
  pageOf: string;
  /** {language}, {other}; {language}, {authoritative}. */
  sectionInOther: string;
  sectionLagging: string;
  notInForce: Record<'retired' | 'superseded' | 'withdrawn' | 'unpublished', string>;
  imported: Record<'title' | 'notThroughRoute' | 'revisionLabel' | 'approvedOn' | 'approvedBy' | 'originalKeptAt' | 'differences', string>;
  contentHash: string;
  aiDraft: string;
  aiNotice: string;
};
