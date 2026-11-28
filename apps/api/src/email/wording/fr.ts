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
      body: 'L’incident {reference} a été qualifié d’événement sentinelle. Sa clôture devra être validée par une deuxième personne.',
    },
    incident_assigned: {
      subject: 'L’incident {reference} vous est attribué',
      body: 'L’incident {reference} vous a été attribué.',
    },
    sign_off_requested: {
      subject: 'Validation demandée : incident {reference}',
      body: 'La clôture de l’incident {reference} attend la validation d’une deuxième personne. Vous pouvez la donner.',
    },
    document_step_review: {
      subject: 'Le document {number} attend votre vérification',
      body: 'Le document {number}, version {version}, attend votre vérification.',
    },
    document_step_approve: {
      subject: 'Le document {number} attend votre approbation',
      body: 'Le document {number}, version {version}, attend votre approbation.',
    },
    review_approval_requested: {
      subject: 'Document {number} : une révision sans modification attend votre signature',
      body: 'Le responsable du document {number} a confirmé lors de sa révision périodique qu’il n’a pas besoin de modification. Sa prochaine révision n’est fixée qu’après votre signature.',
    },
    signing_pin_set: {
      subject: 'Votre code de signature a été défini',
      body: 'Un code de signature a été défini pour votre compte Trustline, et vos autres sessions ont été fermées. Si ce n’était pas vous, prévenez aussitôt votre administrateur.',
    },
    signing_pin_changed: {
      subject: 'Votre code de signature a été modifié',
      body: 'Le code de signature de votre compte Trustline a été modifié, et vos autres sessions ont été fermées. Si ce n’était pas vous, prévenez aussitôt votre administrateur.',
    },
    signing_pin_reset: {
      subject: 'Votre code de signature a été réinitialisé',
      body: 'Un administrateur a réinitialisé le code de signature de votre compte Trustline, et vous avez été déconnecté. Reconnectez-vous pour en définir un nouveau.',
    },
    signing_pin_locked: {
      subject: 'La signature par votre code est bloquée',
      body: 'Après trop de codes de signature erronés, la signature par votre code est bloquée dans Trustline, et la session où ils ont été saisis a été fermée. Demandez à votre administrateur de réinitialiser votre code ; si ce n’était pas vous, dites-le-lui.',
    },
    audit_chain_head: {
      subject: 'Le sceau de votre journal d’audit cette semaine',
      body: 'Le journal d’audit de votre organisation a été vérifié et il est intact jusqu’à l’entrée {count}, dont le sceau est {hash}. Conservez ce message : si le journal antérieur à cette entrée était un jour réécrit, ce sceau ne correspondrait plus.',
    },
  },
  signInCode: {
    subject: 'Votre code de connexion à Trustline',
    body: 'Votre code de connexion est {code}.',
    expires: 'Il ne peut servir qu’une fois, dans les {count} minutes. Si vous n’avez pas tenté de vous connecter, prévenez l’organisation qui vous a invité.',
  },
  weekly: {
    subject: 'Prises de connaissance en retard cette semaine',
    body: 'Des personnes de vos équipes n’ont pas confirmé à temps leur prise de connaissance de certains documents.',
    overdue: 'Prises de connaissance en retard : {overdue}',
    people: 'Personnes concernées : {people}',
    open: 'Voir le détail dans Trustline',
    stepsSubject: 'Étapes d’approbation en retard cette semaine',
    bothSubject: 'Prises de connaissance et étapes d’approbation en retard cette semaine',
    openSteps: 'Voir les étapes en retard dans Trustline',
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
    turnBackOn: 'Vous pouvez les réactiver dans Trustline, dans vos préférences d’e-mail.',
    alwaysOn: 'Les alertes d’incidents graves et d’événements sentinelles, pour celles et ceux qui les trient, et les étapes d’approbation qui vous sont attribuées sont toujours envoyées : d’autres en dépendent.',
    invalid: 'Ce lien n’est pas valide ou a expiré. Vous pouvez modifier vos préférences d’e-mail dans Trustline.',
  },
};
