/**
 * Everything an email or an unsubscribe page says, in one language. Every
 * language has exactly these keys (the type holds them to it) and the same
 * placeholders in each text (wording.spec.ts). Counts are written as
 * "label: number", so that no language needs plural forms.
 *
 * Placeholders, in braces: {reference} an incident's reference, {number} a
 * document's number, {version} a version number, {organization} the
 * organization's own name, {count}, {overdue} and {people} counts, {day} a
 * day. Nothing else is ever put into these texts.
 */
export type Wording = {
  /** The direction the language is written in. */
  dir: 'ltr' | 'rtl';
  /** Opens every email. Names nobody. */
  greeting: string;
  /** The link to the item. */
  open: string;
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
  };
  weekly: {
    subject: string;
    body: string;
    overdue: string;
    people: string;
    open: string;
  };
  daily: {
    subject: string;
    intro: string;
    acknowledge: string;
    approve: string;
    reviews: string;
    incidents: string;
    incidentsOverdue: string;
    more: string;
    open: string;
  };
  footer: {
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
    invalid: string;
  };
};
