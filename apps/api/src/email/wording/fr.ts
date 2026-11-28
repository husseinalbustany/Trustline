import type { Wording } from './types.js';

// French typography: a no-break space (U+00A0) before « : », a narrow
// no-break space (U+202F) before « ? » (wording.spec.ts checks both).
export const fr: Wording = {
  dir: 'ltr',
  greeting: 'Bonjour,',
  open: 'Ouvrir dans Trustline',
  colon: ' : ',
  overdue: 'en retard',
  immediate: {
    incident_reported: {
      subject: 'Incident grave déclaré : {reference}',
      body: 'Un incident grave, {reference}, a été déclaré dans un périmètre dont vous assurez le tri.',
    },
    incident_handed_over: {
      subject: 'Incident grave confié à votre service : {reference}',
      body: 'Un incident grave, {reference}, a été confié à un service dont vous traitez les incidents.',
    },
    sentinel_flagged: {
      subject: 'L’incident {reference} est désormais un événement sentinelle',
      body: 'L’incident {reference} a été qualifié d’événement sentinelle.',
    },
    incident_assigned: {
      subject: 'L’incident {reference} vous est attribué',
      body: 'L’incident {reference} vous a été attribué.',
    },
    sign_off_requested: {
      subject: 'Validation demandée : incident {reference}',
      body: 'La clôture de l’incident {reference} attend une seconde signature, que vous pouvez donner.',
    },
    document_step_review: {
      subject: 'Le document {number} attend votre vérification',
      body: 'Le document {number}, version {version}, attend votre vérification.',
    },
    document_step_approve: {
      subject: 'Le document {number} attend votre approbation',
      body: 'Le document {number}, version {version}, attend votre approbation.',
    },
  },
  weekly: {
    subject: 'Prises de connaissance en retard cette semaine',
    body: 'Des personnes de vos équipes n’ont pas confirmé à temps leur prise de connaissance de certains documents.',
    overdue: 'Prises de connaissance en retard : {overdue}',
    people: 'Personnes concernées : {people}',
    open: 'Voir le détail dans Trustline',
    stepsSubject: 'Étapes d’approbation en retard cette semaine',
    stepsBody: 'Certaines étapes d’approbation des documents que vous gérez ont dépassé leur échéance.',
    stepsOverdue: 'Étapes d’approbation en retard : {count}',
  },
  daily: {
    subject: 'Ce qui vous attend dans Trustline : {day}',
    intro: 'Voici ce qui vous attend aujourd’hui.',
    acknowledge: 'Documents dont vous devez confirmer la prise de connaissance : {count}',
    approve: 'Documents à vérifier ou à approuver : {count}',
    stepsOverdue: 'Étapes d’approbation en retard dans les documents que vous gérez : {count}',
    reviews: 'Révisions périodiques à faire : {count}',
    incidents: 'Incidents qui vous sont attribués : {count}',
    incidentsOverdue: 'Dont en retard : {count}',
    more: 'Et {count} de plus dans Trustline.',
    open: 'Ouvrir Trustline',
  },
  footer: {
    member: 'Vous recevez cet e-mail en tant que membre de {organization} dans Trustline.',
    noDetails: 'Les e-mails de Trustline ne contiennent aucun détail sur l’incident ou le document : connectez-vous pour les voir.',
    unsubscribeImmediate: 'Ne plus recevoir ces e-mails immédiats',
    unsubscribeDigest: 'Ne plus recevoir ces e-mails de synthèse',
    preferences: 'Modifier vos préférences d’e-mail',
  },
  page: {
    title: 'E-mails de Trustline',
    confirmImmediate: 'Ne plus recevoir les e-mails immédiats de Trustline ?',
    confirmDigest: 'Ne plus recevoir les e-mails de synthèse quotidiens et hebdomadaires de Trustline ?',
    button: 'Ne plus recevoir ces e-mails',
    doneImmediate: 'Vous ne recevrez plus les e-mails immédiats.',
    doneDigest: 'Vous ne recevrez plus les e-mails de synthèse.',
    turnBackOn: 'Vous pouvez les réactiver dans Trustline, dans vos préférences de notification.',
    invalid: 'Ce lien n’est pas valide ou a expiré. Vous pouvez modifier vos préférences d’e-mail dans Trustline.',
  },
};
