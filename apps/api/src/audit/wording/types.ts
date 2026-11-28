import type { AuditAction, AuditActor, AuditArea, AuditEntityType } from '../actions.js';

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
  };
  actors: Record<AuditActor, string>;
};
