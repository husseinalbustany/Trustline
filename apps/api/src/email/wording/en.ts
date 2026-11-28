import type { Wording } from './types.js';

export const en: Wording = {
  dir: 'ltr',
  greeting: 'Hello,',
  open: 'Open in Trustline',
  colon: ': ',
  overdue: 'overdue',
  immediate: {
    incident_reported: {
      subject: 'Serious incident reported: {reference}',
      body: 'A serious incident, {reference}, has been reported in an area you triage.',
    },
    incident_handed_over: {
      subject: 'Serious incident handed to your department: {reference}',
      body: 'A serious incident, {reference}, has been handed to a department you handle.',
    },
    sentinel_flagged: {
      subject: 'Incident {reference} is now a sentinel event',
      body: 'Incident {reference} has been marked as a sentinel event. Closing it will need a second person’s sign-off.',
    },
    incident_assigned: {
      subject: 'Incident {reference} is assigned to you',
      body: 'Incident {reference} has been assigned to you.',
    },
    sign_off_requested: {
      subject: 'Sign-off requested: incident {reference}',
      body: 'Incident {reference} is waiting for a second person to sign off its closure. You can sign it off.',
    },
    document_step_review: {
      subject: 'Document {number} awaits your review',
      body: 'Document {number}, version {version}, awaits your review.',
    },
    document_step_approve: {
      subject: 'Document {number} awaits your approval',
      body: 'Document {number}, version {version}, awaits your approval.',
    },
    review_approval_requested: {
      subject: 'Document {number}: a review with no change awaits your signature',
      body: 'The owner of document {number} has confirmed at its periodic review that it needs no change. Its next review date moves once you sign.',
    },
    signing_pin_set: {
      subject: 'Your signing PIN was set',
      body: 'A signing PIN was set for your account in Trustline, and your other sessions were signed out. If it was not you, tell your administrator at once.',
    },
    signing_pin_changed: {
      subject: 'Your signing PIN was changed',
      body: 'The signing PIN of your account in Trustline was changed, and your other sessions were signed out. If it was not you, tell your administrator at once.',
    },
    signing_pin_reset: {
      subject: 'Your signing PIN was reset',
      body: 'An administrator reset the signing PIN of your account in Trustline, and you were signed out. Sign in again to set a new one.',
    },
    signing_pin_locked: {
      subject: 'Signing with your PIN is locked',
      body: 'After too many wrong signing PINs, signing with your PIN in Trustline is locked, and the session they were entered in was signed out. Ask your administrator to reset your PIN; if it was not you, say so.',
    },
    data_export_requested: {
      subject: "A full export of your organization’s data was requested",
      body: "A full export of your organization’s data was requested. It needs a second person’s approval before it is made. Open Trustline to see who asked.",
    },
    data_export_approved: {
      subject: "A full export of your organization’s data was approved",
      body: "A full export of your organization’s data was approved and is being made. Open Trustline to see who approved it.",
    },
    data_export_refused: {
      subject: "A full export of your organization’s data was refused",
      body: "A request for a full export of your organization’s data was refused. Nothing was made. Open Trustline to see why.",
    },
    data_export_cancelled: {
      subject: "A full export of your organization’s data was cancelled",
      body: "A request for a full export of your organization’s data was cancelled by the person who asked. Nothing was made.",
    },
    data_export_lapsed: {
      subject: "A request for a full data export lapsed",
      body: "A request for a full export of your organization’s data was not approved within 7 days, and has lapsed. Nothing was made.",
    },
    data_export_ready: {
      subject: "A full export of your organization’s data is ready",
      body: "A full export of your organization’s data is ready. The person who asked and the approver can download it in Trustline for 7 days.",
    },
    data_export_downloaded: {
      subject: "A full export of your organization’s data was downloaded",
      body: "A full export of your organization’s data was downloaded. Open Trustline to see who downloaded it.",
    },
    data_export_failed: {
      subject: "A full export of your organization’s data could not be made",
      body: "A full export of your organization’s data could not be made. Trustline tried more than once. You can ask for a new one.",
    },
    contract_ending: {
      subject: "Your organization’s contract ends on {day}",
      body: "Your organization’s contract with Trustline ends on {day}. You can export its data before then, from Administration, “Data export”.",
    },
    audit_chain_head: {
      subject: 'This week’s seal of your audit trail',
      body: 'Your organization’s audit trail was checked on {day} and is unbroken up to entry {count}. The seal of that entry is:',
      keep: 'Keep this email: if any entry up to that one were ever changed, removed or added afterwards, this seal would no longer match.',
    },
  },
  signInCode: {
    subject: 'Your Trustline sign-in code',
    body: 'Your sign-in code is {code}.',
    expires: 'It can be used once, within {count} minutes. Do not give it to anyone. If you did not just try to sign in, someone else knows your password: tell the organization that gave you access.',
    footer: 'You receive this email because {organization} gave you access to Trustline as an external reviewer.',
  },
  weekly: {
    subject: 'Overdue acknowledgements this week',
    body: 'Some people in your teams have not acknowledged documents by their due date.',
    overdue: 'Acknowledgements overdue: {overdue}',
    people: 'People concerned: {people}',
    open: 'See who in Trustline',
    stepsSubject: 'Approval steps overdue this week',
    bothSubject: 'Overdue acknowledgements and approval steps this week',
    openSteps: 'See the overdue steps in Trustline',
    stepsBody: 'Some approval steps of the documents you manage have passed their due date.',
    stepsOverdue: 'Approval steps overdue: {count}',
  },
  daily: {
    subject: 'What waits for you in Trustline: {day}',
    intro: 'This is what waits for you today.',
    acknowledge: 'Documents to acknowledge: {count}',
    approve: 'Documents to review or approve: {count}',
    stepsOverdue: 'Approval steps overdue in the documents you manage: {count}',
    reviews: 'Periodic reviews due: {count}',
    incidents: 'Incidents assigned to you: {count}',
    incidentsOverdue: 'Of these, overdue: {count}',
    more: 'And {count} more in Trustline.',
    open: 'Open Trustline',
  },
  footer: {
    alwaysAuditSeal: 'Administrators are always sent the weekly seal of the audit trail by email, whatever their email settings.',
    member: 'You receive this email as a member of {organization} in Trustline.',
    noDetails: 'Emails from Trustline carry no details of the incident or document: sign in to see them.',
    unsubscribeImmediate: 'Stop these immediate emails',
    unsubscribeDigest: 'Stop these summary emails',
    preferences: 'Change your email preferences',
  },
  page: {
    title: 'Trustline emails',
    confirmImmediate: 'Stop receiving the immediate emails from Trustline?',
    confirmDigest: 'Stop receiving the daily and weekly summary emails from Trustline?',
    button: 'Stop these emails',
    doneImmediate: 'You will no longer receive the immediate emails.',
    doneDigest: 'You will no longer receive the summary emails.',
    turnBackOn: 'You can turn them back on in Trustline, in your email preferences.',
    alwaysOn: 'Alerts of serious incidents and sentinel events, for those who triage them, and approval steps assigned to you are always sent: others rely on them.',
    invalid: 'This link is not valid or has expired. You can change your email preferences in Trustline.',
  },
};
