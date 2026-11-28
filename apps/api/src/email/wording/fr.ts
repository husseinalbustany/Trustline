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
    data_export_requested: {
      subject: "Une exportation complète des données de votre établissement a été demandée",
      body: "Une exportation complète des données de votre établissement a été demandée. Elle doit être approuvée par une deuxième personne avant d’être préparée. Ouvrez Trustline pour voir qui l’a demandée ; si vous ne l’attendiez pas, refusez-la.",
    },
    data_export_approved: {
      subject: "Une exportation complète des données de votre établissement a été approuvée",
      body: "Une exportation complète des données de votre établissement a été approuvée et est en cours de préparation. Ouvrez Trustline pour voir qui l’a approuvée.",
    },
    data_export_refused: {
      subject: "Une exportation complète des données de votre établissement a été refusée",
      body: "Une demande d’exportation complète des données de votre établissement a été refusée. Aucun fichier n’a été créé. Ouvrez Trustline pour en voir le motif.",
    },
    data_export_cancelled: {
      subject: "Une exportation complète des données de votre établissement a été annulée",
      body: "Une demande d’exportation complète des données de votre établissement a été annulée par la personne qui l’avait faite. Aucun fichier n’a été créé.",
    },
    data_export_lapsed: {
      subject: "Une demande d’exportation complète des données a expiré",
      body: "Une demande d’exportation complète des données de votre établissement n’a pas été approuvée dans les 7 jours et a expiré. Aucun fichier n’a été créé.",
    },
    data_export_ready: {
      subject: "L’exportation complète des données de votre établissement est prête",
      body: "L’exportation complète des données de votre établissement est prête. La personne qui l’a demandée et celle qui l’a approuvée peuvent la télécharger dans Trustline, jusqu’à 5 fois dans les 7 jours.",
    },
    data_export_downloaded: {
      subject: "L’exportation complète des données de votre établissement a été téléchargée",
      body: "L’exportation complète des données de votre établissement a été téléchargée. Ouvrez Trustline pour voir qui l’a téléchargée.",
    },
    data_export_failed: {
      subject: "L’exportation complète des données de votre établissement n’a pas pu être préparée",
      body: "L’exportation complète des données de votre établissement n’a pas pu être préparée, malgré plusieurs tentatives. Vous pouvez en demander une nouvelle.",
    },
    contract_ending: {
      subject: "Le contrat de votre établissement prend fin le {day}",
      body: "Le contrat de votre établissement avec Trustline prend fin le {day}. Vous pouvez en exporter les données d’ici là, depuis Administration, « Exportation des données ».",
    },
    audit_chain_head: {
      subject: 'Journal d’audit : le sceau de la semaine',
      body: 'Le journal d’audit de votre établissement a été vérifié le {day} : il est intact jusqu’à l’entrée {count}. Le sceau de cette entrée est :',
      keep: 'Conservez ce message : si une entrée jusqu’à celle-ci était un jour modifiée, supprimée ou ajoutée après coup, ce sceau ne correspondrait plus.',
    },
    risk_escalated: {
      subject: 'Risque extrême remonté : {reference}',
      body: 'Le risque {reference}, évalué Extrême, a été remonté à un comité dont vous êtes membre, ou c’est un risque dont vous êtes propriétaire.',
    },
    risk_step_assigned: {
      subject: 'Une étape de risque à décider : {reference}',
      body: 'Une étape de l’acceptation ou de la clôture du risque {reference} attend votre décision.',
    },
  },
  signInCode: {
    subject: 'Votre code de connexion à Trustline',
    body: 'Votre code de connexion est {code}.',
    expires: 'Il ne peut servir qu’une fois, dans les {count} minutes. Ne le communiquez à personne. Si vous n’avez pas tenté de vous connecter à l’instant, quelqu’un d’autre connaît votre mot de passe : prévenez l’établissement qui vous a donné cet accès.',
    footer: 'Vous recevez cet e-⁠mail car vous disposez d’un accès d’évaluateur externe à Trustline pour {organization}.',
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
  weeklyRisks: {
    subject: 'Revues de risques et actions en retard cette semaine',
    body: 'Des risques que vous gérez ont des revues ou des actions dont l’échéance est passée.',
    reviewsOverdue: 'Revues de risques en retard : {count}',
    actionsOverdue: 'Actions en retard : {count}',
    stepsOverdue: 'Étapes d’acceptation et de clôture en retard : {count}',
    open: 'Voir les revues à faire dans Trustline',
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
    riskReviews: 'Risques à revoir : {count}',
    actionsDue: 'Actions à échéance : {count}',
    riskProposals: 'Risques proposés au registre : {count}',
    riskSteps: 'Étapes de risques à décider : {count}',
    more: 'Et {count} de plus dans Trustline.',
    open: 'Ouvrir Trustline',
  },
  footer: {
    alwaysAuditSeal: 'Les administrateurs reçoivent toujours par e-⁠mail le sceau hebdomadaire du journal d’audit, quels que soient leurs réglages.',
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
