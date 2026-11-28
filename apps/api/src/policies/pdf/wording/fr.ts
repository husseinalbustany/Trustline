import type { PdfWording } from './types.js';

/** Word for word as the web's print view (dictionaries, `policies.document`, `policies.imported`, `policies.notInForce`). */
export const fr: PdfWording = {
  "dir": "ltr",
  "languages": {
    "en": "anglais",
    "ar": "arabe",
    "fr": "français"
  },
  "controlBlock": "Document maîtrisé",
  "number": "Numéro",
  "version": "Version",
  "title": "Titre",
  "owner": "Responsable",
  "ownerUnit": "Entité responsable",
  "effectiveOn": "En vigueur à compter du",
  "nextReviewOn": "Prochaine révision",
  "authoritative": "Langue qui fait foi",
  "approvals": "Rédigé, vérifié et approuvé",
  "noApprovals": "Aucune signature pour l’instant.",
  "preparedBy": "Rédigé par {name} le {date}",
  "reviewedBy": "Vérifié par {name} le {date}",
  "approvedBy": "Approuvé par {name} le {date}",
  "notSet": "Non fixée",
  "unknownPerson": "Un ancien utilisateur",
  "notControlled": "Les copies imprimées ne sont pas maîtrisées. Vérifiez la version en vigueur dans Trustline.",
  "printHeader": "{number} · Version {version} · {title}",
  "printHeaderOriginal": "{number} · Version {version} ({revision} sur l’original) · {title}",
  "printedOn": "Imprimé le {date}, valable ce jour-là uniquement.",
  "pageOf": "Page {page} sur {pages}",
  "sectionInOther": "Cette section n’est pas rédigée en {language} : elle est affichée ici en {other}.",
  "sectionLagging": "Cette section n’a pas été mise à jour en {language} après la modification du texte en {authoritative}. En cas de différence, le texte en {authoritative} fait foi.",
  "notInForce": {
    "retired": "Retiré, n’est plus en vigueur",
    "superseded": "Remplacée, n’est plus en vigueur",
    "withdrawn": "Abandonnée, jamais entrée en vigueur",
    "unpublished": "Non publiée, pas en vigueur"
  },
  "imported": {
    "title": "Approuvé avant Trustline",
    "notThroughRoute": "Saisi à partir de son original signé. Il n’est pas passé par le circuit d’approbation de Trustline ; il est réédité par le circuit lors de sa prochaine révision.",
    "revisionLabel": "Indice de révision",
    "approvedOn": "Approuvé le",
    "approvedBy": "Approuvé par (tel qu’écrit sur l’original)",
    "originalKeptAt": "Lieu de conservation de l’original signé",
    "differences": "Écarts par rapport à l’original"
  },
  "contentHash": "Empreinte du texte signé (SHA-256)",
  "aiDraft": "Brouillon IA",
  "aiNotice": "Ce texte a été rédigé par un assistant d’IA. Il peut contenir des erreurs ou des oublis : vérifiez chaque partie au regard du fonctionnement de votre établissement avant de vous y fier. Seule une personne peut approuver ou publier ce qu’il rédige."
};
