import type { Locale } from '../i18n/locales.js';

/**
 * What every client of the policies module starts with: three document
 * types with their sections, a short list of categories, and one approval
 * route per type. Named in every supported language, like the built-in
 * roles, and worded for any organization. A client renames, reorders,
 * switches off and adds its own; these are only ever added where missing,
 * never overwritten (ProvisioningService.ensurePolicyDefaults, and migration
 * 0039 for the clients that existed before this module).
 */

type Name = Record<Locale, string>;

export type DefaultSection = { key: string; name: Name; required: boolean };

const section = (
  key: string,
  required: boolean,
  en: string,
  ar: string,
  fr: string,
): DefaultSection => ({ key, required, name: { en, ar, fr } });

const PURPOSE = section('purpose', true, 'Purpose', 'الغرض', 'Objet');
const SCOPE = section('scope', true, 'Scope', 'النطاق', 'Champ d’application');
const DEFINITIONS = section(
  'definitions',
  false,
  'Definitions',
  'التعريفات',
  'Définitions',
);
const RESPONSIBILITIES = section(
  'responsibilities',
  true,
  'Responsibilities',
  'المسؤوليات',
  'Responsabilités',
);
const REFERENCES = section(
  'references',
  false,
  'References',
  'المراجع',
  'Références',
);
const STEPS = section('steps', true, 'Steps', 'الخطوات', 'Étapes');
const RECORDS = section(
  'records',
  false,
  'Records',
  'السجلات',
  'Enregistrements',
);

export const DEFAULT_DOCUMENT_TYPES: {
  code: string;
  name: Name;
  numberPrefix: string;
  defaultReviewMonths: number;
  position: number;
  sections: DefaultSection[];
}[] = [
  {
    code: 'policy',
    name: { en: 'Policy', ar: 'سياسة', fr: 'Politique' },
    numberPrefix: 'POL',
    defaultReviewMonths: 36,
    position: 1,
    sections: [
      PURPOSE,
      SCOPE,
      DEFINITIONS,
      section(
        'policy_statements',
        true,
        'Policy statements',
        'بنود السياسة',
        'Énoncés de la politique',
      ),
      RESPONSIBILITIES,
      REFERENCES,
    ],
  },
  {
    code: 'procedure',
    name: { en: 'Procedure', ar: 'إجراء', fr: 'Procédure' },
    numberPrefix: 'PRC',
    defaultReviewMonths: 24,
    position: 2,
    sections: [
      PURPOSE,
      SCOPE,
      DEFINITIONS,
      RESPONSIBILITIES,
      section(
        'equipment_and_forms',
        false,
        'Equipment and forms',
        'المعدات والنماذج',
        'Équipements et formulaires',
      ),
      STEPS,
      RECORDS,
      section(
        'exceptions_and_escalation',
        false,
        'Exceptions and escalation',
        'الاستثناءات والتصعيد',
        'Exceptions et escalade',
      ),
      REFERENCES,
    ],
  },
  {
    code: 'work_instruction',
    name: {
      en: 'Work instruction',
      ar: 'تعليمات عمل',
      fr: 'Instruction de travail',
    },
    numberPrefix: 'WI',
    defaultReviewMonths: 12,
    position: 3,
    sections: [
      PURPOSE,
      STEPS,
      section(
        'safety_notes',
        false,
        'Safety notes',
        'ملاحظات السلامة',
        'Consignes de sécurité',
      ),
      RECORDS,
    ],
  },
];

export const DEFAULT_DOCUMENT_CATEGORIES: {
  code: string;
  name: Name;
  position: number;
}[] = [
  {
    code: 'GOV',
    name: { en: 'Governance', ar: 'الحوكمة', fr: 'Gouvernance' },
    position: 1,
  },
  {
    code: 'QUA',
    name: { en: 'Quality', ar: 'الجودة', fr: 'Qualité' },
    position: 2,
  },
  {
    code: 'SAF',
    name: { en: 'Safety', ar: 'السلامة', fr: 'Sécurité' },
    position: 3,
  },
  {
    code: 'OPS',
    name: { en: 'Operations', ar: 'العمليات', fr: 'Opérations' },
    position: 4,
  },
  {
    code: 'HR',
    name: { en: 'Human resources', ar: 'الموارد البشرية', fr: 'Ressources humaines' },
    position: 5,
  },
  {
    code: 'INF',
    name: { en: 'Information', ar: 'المعلومات', fr: 'Information' },
    position: 6,
  },
];

/**
 * The route every type starts with: a review, then an approval, each by
 * anyone holding a built-in role over the document's owning unit, with a
 * week for each. Named after the type.
 */
export const DEFAULT_ROUTE_STEPS: {
  position: number;
  kind: 'review' | 'approve';
  roleCode: string;
  dueInDays: number;
}[] = [
  { position: 1, kind: 'review', roleCode: 'quality_officer', dueInDays: 7 },
  { position: 2, kind: 'approve', roleCode: 'administrator', dueInDays: 7 },
];

/** "Approval of <type>s", per type code, in every language. */
export const DEFAULT_ROUTE_NAMES: Record<string, Name> = {
  policy: {
    en: 'Policy approval',
    ar: 'اعتماد السياسات',
    fr: 'Approbation des politiques',
  },
  procedure: {
    en: 'Procedure approval',
    ar: 'اعتماد الإجراءات',
    fr: 'Approbation des procédures',
  },
  work_instruction: {
    en: 'Work instruction approval',
    ar: 'اعتماد تعليمات العمل',
    fr: 'Approbation des instructions de travail',
  },
};
