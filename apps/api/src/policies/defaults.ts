import type { Locale } from '../i18n/locales.js';

/**
 * What every client of the policies module starts with: three document
 * types with their sections, a short list of categories, and one approval
 * route per type. Named in every supported language, like the built-in
 * roles, and worded for any organization. A client renames, reorders,
 * switches off and adds its own; these are only ever added where missing,
 * never overwritten (ProvisioningService.ensurePolicyDefaults, and migration
 * 0039 for the clients that existed before this module). A change of
 * wording here reaches the clients that exist through a migration that
 * rewords only what still reads as it was given, as 0043 does.
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
const STEPS = section('steps', true, 'Steps', 'خطوات العمل', 'Déroulement');
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
  /** Business decision 6: on for policies, off for the others. */
  noChangeNeedsApproval: boolean;
  position: number;
  sections: DefaultSection[];
}[] = [
  {
    code: 'policy',
    name: { en: 'Policy', ar: 'سياسة', fr: 'Politique' },
    numberPrefix: 'POL',
    defaultReviewMonths: 36,
    noChangeNeedsApproval: true,
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
        'Dispositions',
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
    noChangeNeedsApproval: false,
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
        'Exceptions et procédure d’alerte',
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
    noChangeNeedsApproval: false,
    position: 3,
    sections: [
      PURPOSE,
      STEPS,
      section(
        'safety_notes',
        false,
        'Safety notes',
        'تنبيهات السلامة',
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
    name: {
      en: 'Information management',
      ar: 'إدارة المعلومات',
      fr: 'Gestion de l’information',
    },
    position: 6,
  },
];

/**
 * The route every type starts with: a review by the Quality officer, then
 * the approval by the Approving authority (business decision 2), each by
 * anyone holding that built-in role over the document's owning unit, with a
 * week for each. Named after the type. Migration 0045 changed the routes of
 * the clients that existed where they still were the earlier starting route
 * (approval by the Administrator).
 */
export const DEFAULT_ROUTE_STEPS: {
  position: number;
  kind: 'review' | 'approve';
  roleCode: string;
  dueInDays: number;
}[] = [
  { position: 1, kind: 'review', roleCode: 'quality_officer', dueInDays: 7 },
  { position: 2, kind: 'approve', roleCode: 'approving_authority', dueInDays: 7 },
];

/**
 * Who approves in a starting route when the client has no built-in
 * Approving authority (its own role holds that code): the Administrator,
 * which approved in the starting route before business decision 2. A
 * route is never made without an approval step (security review 7,
 * finding 5).
 */
export const FALLBACK_APPROVER = 'administrator';

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
