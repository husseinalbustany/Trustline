import type { Wording } from './types.js';

export const en: Wording = {
  dir: 'ltr',
  greeting: 'Hello,',
  open: 'Open in Trustline',
  serious: 'serious',
  overdue: 'overdue',
  version: 'version {version}',
  immediate: {
    incident_reported: {
      subject: 'Serious incident reported: {reference}',
      body: 'A serious incident, {reference}, has been reported where you may triage it.',
    },
    incident_handed_over: {
      subject: 'Serious incident handed to your department: {reference}',
      body: 'A serious incident, {reference}, has been handed to a department you handle.',
    },
    sentinel_flagged: {
      subject: 'Incident {reference} is now a sentinel event',
      body: 'Incident {reference} has been made a sentinel event.',
    },
    incident_assigned: {
      subject: 'Incident {reference} is assigned to you',
      body: 'Incident {reference} has been assigned to you.',
    },
    sign_off_requested: {
      subject: 'Sign-off requested: incident {reference}',
      body: 'Closing incident {reference} awaits a second signature, which you may give.',
    },
    document_step_review: {
      subject: 'Document {number} awaits your review',
      body: 'Document {number}, version {version}, awaits your review.',
    },
    document_step_approve: {
      subject: 'Document {number} awaits your approval',
      body: 'Document {number}, version {version}, awaits your approval.',
    },
  },
  weekly: {
    subject: 'Overdue acknowledgements this week',
    body: 'Some people in your teams have documents to acknowledge whose time has passed.',
    overdue: 'Acknowledgements overdue: {overdue}',
    people: 'People concerned: {people}',
    open: 'See who in Trustline',
  },
  daily: {
    subject: 'What waits for you in Trustline: {day}',
    intro: 'This is what waits for you today.',
    acknowledge: 'Documents to acknowledge: {count}',
    approve: 'Documents to review or approve: {count}',
    reviews: 'Periodic reviews due: {count}',
    incidents: 'Incidents assigned to you: {count}',
    incidentsOverdue: 'Of these, overdue: {count}',
    more: 'And {count} more in Trustline.',
    open: 'Open Trustline',
  },
  footer: {
    member: 'You receive this email as a member of {organization} in Trustline.',
    noDetails: 'Emails from Trustline hold no details: sign in to see them.',
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
    turnBackOn: 'You can turn them back on in Trustline, in your notification preferences.',
    invalid: 'This link is not valid or has expired. You can change your email preferences in Trustline.',
  },
};
