import type { NotificationData } from '../database/schema.js';
import type { NotificationKind } from '../incidents/notifier.js';
import type { EmailSwitch } from './unsubscribe-token.js';

export type EmailCategory = 'immediate' | 'daily_digest' | 'weekly_digest';

/**
 * The notifications sent by email at once, and on what condition
 * (docs/specs/email.md, section 1, which says why each cannot wait):
 * `serious` only when the incident is serious as it stands when the
 * notification is written. Every other kind is in-app only, or reaches the
 * person through the daily digest.
 */
export const IMMEDIATE: Partial<Record<NotificationKind, 'always' | 'serious'>> = {
  incident_reported: 'serious',
  incident_handed_over: 'serious',
  sentinel_flagged: 'always',
  incident_assigned: 'always',
  sign_off_requested: 'always',
  document_step_assigned: 'always',
  // A "no change" review awaiting the Approving authority's signature
  // (business decision 6): as an approval step assigned to them.
  review_approval_requested: 'always',
};

export type ImmediateKind =
  | 'incident_reported'
  | 'incident_handed_over'
  | 'sentinel_flagged'
  | 'incident_assigned'
  | 'sign_off_requested'
  | 'document_step_assigned'
  | 'review_approval_requested';

export const IMMEDIATE_KINDS = Object.keys(IMMEDIATE) as ImmediateKind[];

/** The notifications sent by email as the weekly digest. */
export const WEEKLY: NotificationKind[] = ['acknowledgements_overdue_digest'];

/** Which email a notification is sent as, if any. */
export function categoryOf(
  kind: NotificationKind,
  data: NotificationData,
): EmailCategory | null {
  const rule = IMMEDIATE[kind];
  if (rule === 'always') return 'immediate';
  if (rule === 'serious') return data.serious === true ? 'immediate' : null;
  if (WEEKLY.includes(kind)) return 'weekly_digest';
  return null;
}

/** The person's switch that governs an email of this category. */
export const switchOf = (category: EmailCategory): EmailSwitch =>
  category === 'immediate' ? 'immediate' : 'digest';

/**
 * What is still emailed while the subscription is suspended: safety work,
 * meaning everything about incidents and documents to acknowledge. Approval
 * steps and reviews wait: they cannot be decided until it is active again.
 */
export const SAFETY_WHILE_SUSPENDED: NotificationKind[] = [
  'incident_reported',
  'incident_handed_over',
  'sentinel_flagged',
  'incident_assigned',
  'sign_off_requested',
  'acknowledgements_overdue_digest',
];

/**
 * The immediate emails some people may not switch off (business decision
 * 4): the people others rely on. Serious-incident and sentinel alerts to
 * those who triage, and approval steps (a "no change" review included) to
 * those assigned them. The organization's switch still stops everything.
 */
export const COMPULSORY_FOR_TRIAGERS: NotificationKind[] = [
  'incident_reported',
  'incident_handed_over',
  'sentinel_flagged',
];
export const COMPULSORY_FOR_ASSIGNEES: NotificationKind[] = [
  'document_step_assigned',
  'review_approval_requested',
];

/** What the preferences answer says is always on, and why. */
export type AlwaysOn = {
  emails: 'serious_incident_alerts' | 'approval_steps';
  reason: 'triages' | 'decides_approval_steps';
};

