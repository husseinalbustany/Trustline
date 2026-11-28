import type { Wording } from './types.js';

export const fr: Wording = {
  dir: 'ltr',
  greeting: 'Bonjour,',
  open: 'Ouvrir dans Trustline',
  serious: 'grave',
  overdue: 'en retard',
  version: 'version {version}',
  immediate: {
    incident_reported: {
      subject: 'Incident grave signalé : {reference}',
      body: 'Un incident grave, {reference}, a été signalé dans un périmètre que vous pouvez trier.',
    },
    incident_handed_over: {
      subject: 'Incident grave confié à votre service : {reference}',
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
      subject: 'Validation demandée : incident {reference}',
      body: 'La clôture de l’incident {reference} attend une seconde signature, que vous pouvez donner.',
    },
    document_step_review: {
      subject: 'Le document {number} attend votre revue',
      body: 'Le document {number}, version {version}, attend votre revue.',
    },
    document_step_approve: {
      subject: 'Le document {number} attend votre approbation',
      body: 'Le document {number}, version {version}, attend votre approbation.',
    },
  },
  weekly: {
    subject: 'Prises de connaissance en retard cette semaine',
    body: 'Des personnes de vos équipes ont des documents à prendre en compte dont le délai est dépassé.',
    overdue: 'Prises de connaissance en retard : {overdue}',
    people: 'Personnes concernées : {people}',
    open: 'Voir le détail dans Trustline',
  },
  daily: {
    subject: 'Ce qui vous attend dans Trustline : {day}',
    intro: 'Voici ce qui vous attend aujourd’hui.',
    acknowledge: 'Documents à prendre en compte : {count}',
    approve: 'Documents à revoir ou approuver : {count}',
    reviews: 'Revues périodiques à faire : {count}',
    incidents: 'Incidents qui vous sont attribués : {count}',
    incidentsOverdue: 'Dont en retard : {count}',
    more: 'Et {count} de plus dans Trustline.',
    open: 'Ouvrir Trustline',
  },
  footer: {
    member: 'Vous recevez ce courriel en tant que membre de {organization} dans Trustline.',
    noDetails: 'Les courriels de Trustline ne contiennent aucun détail : connectez-vous pour les voir.',
    unsubscribeImmediate: 'Ne plus recevoir ces courriels immédiats',
    unsubscribeDigest: 'Ne plus recevoir ces courriels de synthèse',
    preferences: 'Modifier vos préférences de courriel',
  },
  page: {
    title: 'Courriels de Trustline',
    confirmImmediate: 'Ne plus recevoir les courriels immédiats de Trustline ?',
    confirmDigest: 'Ne plus recevoir les courriels de synthèse quotidiens et hebdomadaires de Trustline ?',
    button: 'Ne plus recevoir ces courriels',
    doneImmediate: 'Vous ne recevrez plus les courriels immédiats.',
    doneDigest: 'Vous ne recevrez plus les courriels de synthèse.',
    turnBackOn: 'Vous pouvez les réactiver dans Trustline, dans vos préférences de notification.',
    invalid: 'Ce lien n’est pas valide ou a expiré. Vous pouvez modifier vos préférences de courriel dans Trustline.',
  },
};
