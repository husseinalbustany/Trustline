import type { NotificationData } from '../database/schema.js';
import type { NotificationKind } from '../incidents/notifier.js';
import type { EmailSwitch } from './unsubscribe-token.js';

export type EmailCategory = 'immediate' | 'daily_digest' | 'weekly_digest';

/** What happened to a full data export, as its notification says (`data.change`). */
export const DATA_EXPORT_CHANGES = ['requested', 'approved', 'refused', 'cancelled', 'lapsed', 'ready', 'downloaded', 'failed'] as const;
export type DataExportChange = (typeof DATA_EXPORT_CHANGES)[number];

/**
 * The notifications sent by email at once, and on what condition
 * (docs/specs/email.md, section 1, which says why each cannot wait):
 * `serious` only when the incident is serious as it stands when the
 * notification is written. Every other kind is in-app only, or reaches the
 * person through the daily digest.
 */
export const IMMEDIATE: Partial<Record<NotificationKind, 'always' | 'serious' | 'extreme'>> = {
  incident_reported: 'serious',
  incident_handed_over: 'serious',
  sentinel_flagged: 'always',
  incident_assigned: 'always',
  sign_off_requested: 'always',
  document_step_assigned: 'always',
  // A "no change" review awaiting the Approving authority's signature
  // (business decision 6): as an approval step assigned to them.
  review_approval_requested: 'always',
  // The person's own signing PIN set, changed, reset or locked (security
  // review 11): so that a change they did not make is seen.
  signing_pin_changed: 'always',
  signing_pin_locked: 'always',
  // The week's head of the audit chain, to the Administrators (decision 5
  // of the audit trail): a copy of it outside Trustline's hands.
  audit_chain_head: 'always',
  // A full data export asked for, approved, made or downloaded: something
  // an administrator must know the same day (docs/specs/data-export.md).
  data_export_changed: 'always',
  // The contract ends in 90, 30 or 7 days: its data can be exported first.
  contract_ending: 'always',
  // A risk put before a committee in the band Extreme (risk management,
  // "Notifications and email"): the committee and the owner, at once. The
  // person may switch it off (business decision 16).
  risk_escalated: 'extreme',
  // An acceptance or closure step that becomes someone's: an approval step,
  // as for documents.
  risk_step_assigned: 'always',
};

export type ImmediateKind =
  | 'incident_reported'
  | 'incident_handed_over'
  | 'sentinel_flagged'
  | 'incident_assigned'
  | 'sign_off_requested'
  | 'document_step_assigned'
  | 'review_approval_requested'
  | 'signing_pin_changed'
  | 'signing_pin_locked'
  | 'audit_chain_head'
  | 'data_export_changed'
  | 'contract_ending'
  | 'risk_escalated'
  | 'risk_step_assigned';

export const IMMEDIATE_KINDS = Object.keys(IMMEDIATE) as ImmediateKind[];

/** The notifications sent by email as the weekly digest. */
export const WEEKLY: NotificationKind[] = ['acknowledgements_overdue_digest', 'risks_overdue_digest'];

/** Which email a notification is sent as, if any. */
export function categoryOf(
  kind: NotificationKind,
  data: NotificationData,
): EmailCategory | null {
  const rule = IMMEDIATE[kind];
  if (rule === 'always') return 'immediate';
  if (rule === 'serious') return data.serious === true ? 'immediate' : null;
  if (rule === 'extreme') return data.band === 'extreme' ? 'immediate' : null;
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
  // About the person's own signing PIN: never held back.
  'signing_pin_changed',
  'signing_pin_locked',
  // Evidence of the audit trail: never held back.
  'audit_chain_head',
  // Exporting stays open while suspended (data export, decision 6).
  'data_export_changed',
  'contract_ending',
  // An extreme risk put before a committee is safety work.
  'risk_escalated',
];

/**
 * What is still emailed during a cancelled client's exit window, when only
 * its holders of `data.export` may sign in: the exports themselves.
 */
export const OPEN_IN_EXIT_WINDOW: NotificationKind[] = ['data_export_changed'];

/**
 * Sent even when the organization switched its emails off (security review
 * 19, L8): a full export of its data, and its contract's last days to make
 * one.
 */
export const ALWAYS_SENT: NotificationKind[] = ['data_export_changed', 'contract_ending'];

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
  'risk_step_assigned',
];
/**
 * Security notices about the person's own signing PIN, for everyone; and
 * the week's head of the audit chain, which goes to Administrators only and
 * which they may not switch off (decided with the audit trail).
 */
export const COMPULSORY_FOR_EVERYONE: NotificationKind[] = [
  'signing_pin_changed',
  'signing_pin_locked',
  'audit_chain_head',
  // To those who may export or manage the settings only: a full export of
  // everything is not to be missed.
  'data_export_changed',
  'contract_ending',
];

/** What the preferences answer says is always on, and why. */
export type AlwaysOn = {
  emails: 'serious_incident_alerts' | 'approval_steps';
  reason: 'triages' | 'decides_approval_steps';
};

