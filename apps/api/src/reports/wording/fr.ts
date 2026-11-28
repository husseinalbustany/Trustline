import type { ReportsWording } from './types.js';

export const fr: ReportsWording = {
  measures: {
    'incidents.time_to_report': 'Durée de déclaration (médiane en secondes)',
    'incidents.reported': 'Déclarations envoyées',
    'incidents.triaged_on_time': 'Tri dans les délais',
    'actions.overdue': 'Actions correctives en retard',
    'policies.past_review': 'Documents dont la révision est dépassée',
    'policies.acknowledged': 'Taux de prise de connaissance',
  },
  csv: {
    month: 'Mois',
    unit: 'Unité',
    unitPath: 'Place dans la structure',
    measure: 'Indicateur',
    value: 'Valeur',
    numerator: 'Comptés',
    denominator: 'Sur',
    target: 'Objectif',
    met: 'Objectif atteint',
    status: 'Statut',
    method: 'Mode de relevé',
    revision: 'Révision',
    asAt: 'Arrêté au ({zone})',
    definitionVersion: 'Version de la définition',
  },
  organization: 'Tout l’établissement',
  status: { provisional: 'Provisoire', final: 'Définitif' },
  method: { snapshot: 'Relevé en fin de mois', reconstructed: 'Reconstitué à partir des dossiers', corrected: 'Corrigé' },
  yes: 'Oui',
  no: 'Non',
};
