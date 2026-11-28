/**
 * What a full data export says to people, in one language
 * (docs/specs/data-export.md, "Languages"): the README, the CSV files'
 * headings and the words of their values, and the labels of the documents'
 * HTML. Every language has exactly these keys (wording.spec.ts). The
 * machine files (JSON Lines, schemas, the manifest) are never translated.
 */
export type ExportWording = {
  dir: 'ltr' | 'rtl';
  /** The language's own name, as the README's list of languages shows it. */
  language: string;
  readme: {
    title: string;
    /** {organization}, {moment}: when the data was taken, in the organization's time zone. */
    intro: string;
    contents: string;
    folders: Record<
      | 'organization'
      | 'structure'
      | 'people'
      | 'incidents'
      | 'documents'
      | 'notifications'
      | 'reports'
      | 'audit'
      | 'schema'
      | 'settings',
      string
    >;
    formatsTitle: string;
    formats: string[];
    checkTitle: string;
    /** The four checks, in order: signature, files, audit chain, document signatures. {keysUrl}: where Trustline publishes its keys. */
    checks: [string, string, string, string];
    /** Before the commands of the first check, which are not translated. */
    commandsTitle: string;
    /** To keep the published keys with the archive. */
    saveKeys: string;
    /** {keyId}: the export key that signed the manifest. */
    signedBy: string;
    unsigned: string;
    personalTitle: string;
    personal: string[];
    notIncludedTitle: string;
    notIncluded: string[];
    /** PDFs are not in this release: said in every archive. */
    pdfs: string;
  };
  /** CSV headings: by file, then by column. */
  csv: Record<string, Record<string, string>>;
  /** Codes in the CSV files, as words. Codes not listed are worded by the audit trail's words, else shown as they are. */
  values: Record<string, string>;
  /** Each language's name, in this language. */
  languages: Record<'en' | 'ar' | 'fr', string>;
  yes: string;
  no: string;
  /** A unit or person no longer known. */
  unknown: string;
  organization: string;
  html: {
    version: string;
    number: string;
    owner: string;
    ownerUnit: string;
    effective: string;
    status: string;
    approvals: string;
    approvedBeforeTrustline: string;
    approvedOn: string;
    approvedBy: string;
    originalKeptAt: string;
    differences: string;
    changeSummary: string;
    /** {language}: the language a section is shown in instead. */
    fallback: string;
    lagging: string;
    empty: string;
    contentHash: string;
    signed: string;
    /** An AI draft nobody has taken ownership of yet: its mark and notice (design-guidelines-and-branding.md, "AI content"). */
    aiDraft: string;
    aiNotice: string;
  };
};
