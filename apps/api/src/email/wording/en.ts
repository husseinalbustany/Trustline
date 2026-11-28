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
