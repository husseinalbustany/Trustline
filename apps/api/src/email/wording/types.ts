/**
 * Everything an email or an unsubscribe page says, in one language. Every
 * language has exactly these keys (the type holds them to it) and the same
 * placeholders in each text (wording.spec.ts). Counts are written as
 * "label: number", so that no language needs plural forms.
 *
 * Placeholders, in braces: {reference} an incident's reference, {number} a
 * document's number, {version} a version number, {organization} the
 * organization's own name, {count}, {overdue} and {people} counts, {day} a
 * day, {hash} the seal of the audit chain's head (decision 5 of the audit
 * trail), {code} a one-time sign-in code. Nothing else is ever put into
 * these texts.
 */
export type Wording = {
  /** The direction the language is written in. */
  dir: 'ltr' | 'rtl';
  /** Opens every email. Names nobody. */
  greeting: string;
  /** The link to the item. */
  open: string;
  /**
   * Between a label and what follows it on a line of the plain text (a
   * link, a reference): ": ", or in French "\u00a0: " (regression 2, D5).
   */
  colon: string;
  /** Said after a reference whose deadline has passed. */
  overdue: string;
  immediate: {
    incident_reported: { subject: string; body: string };
    incident_handed_over: { subject: string; body: string };
    sentinel_flagged: { subject: string; body: string };
    incident_assigned: { subject: string; body: string };
    sign_off_requested: { subject: string; body: string };
    document_step_review: { subject: string; body: string };
    document_step_approve: { subject: string; body: string };
    review_approval_requested: { subject: string; body: string };
    signing_pin_set: { subject: string; body: string };
    signing_pin_changed: { subject: string; body: string };
    signing_pin_reset: { subject: string; body: string };
    signing_pin_locked: { subject: string; body: string };
    /** A full data export (docs/specs/data-export.md): names nobody. */
    data_export_requested: { subject: string; body: string };
    data_export_approved: { subject: string; body: string };
    data_export_refused: { subject: string; body: string };
    data_export_cancelled: { subject: string; body: string };
    data_export_lapsed: { subject: string; body: string };
    data_export_ready: { subject: string; body: string };
    data_export_downloaded: { subject: string; body: string };
    data_export_failed: { subject: string; body: string };
    /** The contract ends on {day}: its data can be exported first. */
    contract_ending: { subject: string; body: string };
    /** The week's head of the audit chain: {count} its number, {hash} its seal. */
    audit_chain_head: { subject: string; body: string; keep: string };
  };
  /** An external reviewer's one-time code: {code}, valid {count} minutes. */
  signInCode: { subject: string; body: string; expires: string; footer: string };
  weekly: {
    subject: string;
    body: string;
    overdue: string;
    people: string;
    open: string;
    /** With no acknowledgement overdue, only approval steps. */
    stepsSubject: string;
    /** With both acknowledgements and approval steps overdue (language review 8, A3). */
    bothSubject: string;
    /** The link to the overdue steps (language review 8, M6). */
    openSteps: string;
    stepsBody: string;
    stepsOverdue: string;
  };
  daily: {
    subject: string;
    intro: string;
    acknowledge: string;
    approve: string;
    stepsOverdue: string;
    reviews: string;
    incidents: string;
    incidentsOverdue: string;
    more: string;
    open: string;
  };
  footer: {
    /** In the weekly seal's email, instead of a link to switch it off. */
    alwaysAuditSeal: string;
    member: string;
    noDetails: string;
    unsubscribeImmediate: string;
    unsubscribeDigest: string;
    preferences: string;
  };
  page: {
    title: string;
    confirmImmediate: string;
    confirmDigest: string;
    button: string;
    doneImmediate: string;
    doneDigest: string;
    turnBackOn: string;
    /** On the immediate emails' pages: what always goes (business decision 4). */
    alwaysOn: string;
    invalid: string;
  };
};
