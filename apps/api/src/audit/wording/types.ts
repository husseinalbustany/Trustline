import type { AuditAction, AuditActor, AuditArea, AuditDetailKey, AuditEntityType } from '../actions.js';

/**
 * The words of the audit trail in one language, for what the API writes
 * (the CSV, later). The web app's dictionaries hold the same keys under
 * `audit.actions` and `audit.actors`; `actions.spec.ts` checks that every
 * language has every one.
 *
 * Style (docs/specs/audit-trail.md, "Wording of actions"): a label names
 * what happened, not who did it, which is its own column. English: a noun
 * with a past participle; Arabic: a verbal noun (masdar); French: a noun
 * phrase. None needs to agree with the actor.
 */
export type AuditWording = {
  actions: Record<AuditAction, string>;
  areas: Record<AuditArea, string>;
  entities: Record<AuditEntityType, string>;
  /** The CSV of the trail: its headings, and how a yes or no is said. */
  csv: {
    seq: string;
    at: string;
    who: string;
    area: string;
    action: string;
    recordType: string;
    record: string;
    details: string;
    address: string;
    sealedLate: string;
    yes: string;
    no: string;
    /** An actor whose name is gone. */
    formerUser: string;
    /** An external reviewer, by name: `{name}`. */
    externalReviewer: string;
  };
  actors: Record<AuditActor, string>;
  /** The three types of unit, which a record of `org_unit` is named by. */
  unitTypes: { facility: string; department: string; unit: string };
  /**
   * The details of an entry, as sentences (language review 10): the field
   * first, then its value, so that no verb agrees with a name; a change as
   * `change` says it (no arrow in Arabic); some actions as a whole sentence
   * (`templates`, by action, or by action and value).
   */
  details: {
    colon: string;
    separator: string;
    none: string;
    all: string;
    yes: string;
    no: string;
    change: string;
    /** Between items of one list in a line: ", " or "، " (language review 11). */
    listSeparator: string;
    /** A target left to the default (language review 11). */
    defaultTarget: string;
    /** A figure in its unit: {value}. */
    units: { percent: string; seconds: string };
    /** Each language by its name, in this language. */
    languages: Record<'en' | 'ar' | 'fr', string>;
    fields: Record<AuditDetailKey, string>;
    values: Record<string, string>;
    templates: Record<string, string>;
    screens: Record<
      'incident' | 'incidents' | 'document' | 'documents' | 'audit' | 'auditDownload' | 'reports' | 'users' | 'dashboard' | 'other',
      string
    >;
  };
};
