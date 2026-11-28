import type { Locale } from '../i18n/locales.js';

/**
 * What every client of the risks module starts with
 * (docs/specs/risk-management.md, "The matrix", "Appetite and tolerance"
 * and "Escalation"): a 5×5 matrix with its levels, impact domains, four
 * bands and the band of each cell; nine categories; two committees. Named
 * in every supported language and worded for any organization. A client
 * rewords, reorders, switches off and adds its own; these are only ever
 * added where missing, never overwritten (ProvisioningService
 * .ensureRiskDefaults, and migration 0075 for the clients that existed
 * before this module). The starting wording is for the
 * `bilingual-reviewer` to settle.
 */

type Name = Record<Locale, string>;

const t = (en: string, ar: string, fr: string): Name => ({ en, ar, fr });

export type BandCode = 'low' | 'medium' | 'high' | 'extreme';

/** The four bands, lowest first. Always all four (business decision 4). */
export const BAND_CODES: readonly BandCode[] = [
  'low',
  'medium',
  'high',
  'extreme',
] as const;

export const DEFAULT_LIKELIHOOD_LEVELS = 5;
export const DEFAULT_IMPACT_LEVELS = 5;

export type DefaultLevel = {
  level: number;
  label: Name;
  descriptor: Name;
  frequency?: Name;
};

export const DEFAULT_LIKELIHOOD: DefaultLevel[] = [
  {
    level: 1,
    label: t('Rare', 'نادر', 'Rare'),
    descriptor: t(
      'May happen only in exceptional circumstances.',
      'قد يحدث في ظروف استثنائية فقط.',
      'Pourrait se produire seulement dans des circonstances exceptionnelles.',
    ),
    frequency: t(
      'Less than once in five years',
      'أقل من مرة كل خمس سنوات',
      'Moins d’une fois tous les cinq ans',
    ),
  },
  {
    level: 2,
    label: t('Unlikely', 'غير مرجّح', 'Peu probable'),
    descriptor: t(
      'Could happen at some time, but is not expected.',
      'قد يحدث في وقت ما، لكنه غير متوقع.',
      'Pourrait se produire un jour, mais n’est pas attendu.',
    ),
    frequency: t(
      'Once in two to five years',
      'مرة كل سنتين إلى خمس سنوات',
      'Une fois tous les deux à cinq ans',
    ),
  },
  {
    level: 3,
    label: t('Possible', 'ممكن', 'Possible'),
    descriptor: t(
      'Might well happen; has happened here or in similar organizations.',
      'قد يحدث فعلًا، وقد حدث هنا أو في جهات مماثلة.',
      'Pourrait bien se produire ; s’est déjà produit ici ou dans des organisations comparables.',
    ),
    frequency: t('About once a year', 'مرة في السنة تقريبًا', 'Environ une fois par an'),
  },
  {
    level: 4,
    label: t('Likely', 'مرجّح', 'Probable'),
    descriptor: t(
      'Will probably happen in most circumstances.',
      'سيحدث على الأرجح في معظم الظروف.',
      'Se produira probablement dans la plupart des circonstances.',
    ),
    frequency: t('Several times a year', 'عدة مرات في السنة', 'Plusieurs fois par an'),
  },
  {
    level: 5,
    label: t('Almost certain', 'شبه مؤكد', 'Quasi certain'),
    descriptor: t(
      'Is expected to happen in most circumstances.',
      'يُتوقع حدوثه في معظم الظروف.',
      'Devrait se produire dans la plupart des circonstances.',
    ),
    frequency: t('Monthly or more often', 'شهريًا أو أكثر', 'Tous les mois ou plus souvent'),
  },
];

// «جسيم» is avoided for "Major": the app already uses «حدث جسيم» for a
// sentinel event. "Moderate" and the band "Medium" are kept apart in each
// language, so that a band is never read as an impact level.
export const DEFAULT_IMPACT: DefaultLevel[] = [
  {
    level: 1,
    label: t('Negligible', 'ضئيل', 'Négligeable'),
    descriptor: t(
      'Hardly noticed; dealt with in the normal course of work.',
      'بالكاد يُلاحظ، ويُعالج ضمن سير العمل المعتاد.',
      'À peine perceptible ; traité dans le cours normal du travail.',
    ),
  },
  {
    level: 2,
    label: t('Minor', 'طفيف', 'Mineur'),
    descriptor: t(
      'Noticed, and put right quickly within the unit.',
      'يُلاحظ ويُصحَّح سريعًا داخل الوحدة.',
      'Perceptible, et corrigé rapidement au sein de l’unité.',
    ),
  },
  {
    level: 3,
    label: t('Moderate', 'معتدل', 'Modéré'),
    descriptor: t(
      'Needs management attention and resources beyond the unit.',
      'يتطلب اهتمام الإدارة وموارد من خارج الوحدة.',
      'Demande l’attention de la direction et des moyens au-delà de l’unité.',
    ),
  },
  {
    level: 4,
    label: t('Major', 'كبير', 'Majeur'),
    descriptor: t(
      'Serious harm to people or to the organization; leadership must act.',
      'ضرر كبير بالأشخاص أو بالجهة، ويتطلب تدخل القيادة.',
      'Atteinte grave aux personnes ou à l’organisation ; la direction doit agir.',
    ),
  },
  {
    level: 5,
    label: t('Catastrophic', 'كارثي', 'Catastrophique'),
    descriptor: t(
      'Threatens lives or the organization’s ability to carry on.',
      'يهدد الأرواح أو قدرة الجهة على الاستمرار.',
      'Menace des vies ou la capacité de l’organisation à poursuivre son activité.',
    ),
  },
];

export type DefaultDomain = {
  position: number;
  name: Name;
  /** One per impact level, from 1. */
  descriptors: Name[];
};

export const DEFAULT_DOMAINS: DefaultDomain[] = [
  {
    // The people served, staff and visitors. Read alike with the incident
    // harm levels.
    position: 1,
    name: t('Safety of people', 'سلامة الأشخاص', 'Sécurité des personnes'),
    descriptors: [
      t('No harm, or first aid only.', 'لا ضرر، أو إسعافات أولية فقط.', 'Aucun dommage, ou premiers soins seulement.'),
      t('Minor harm, recovered within days.', 'ضرر طفيف يُتعافى منه خلال أيام.', 'Dommage mineur, rétabli en quelques jours.'),
      t(
        'Harm needing professional treatment or time off, recovered within weeks.',
        'ضرر يتطلب علاجًا متخصصًا أو انقطاعًا عن العمل، ويُتعافى منه خلال أسابيع.',
        'Dommage nécessitant des soins professionnels ou un arrêt, rétabli en quelques semaines.',
      ),
      t('Long-term harm or disability.', 'ضرر طويل الأمد أو إعاقة.', 'Dommage durable ou invalidité.'),
      t(
        'Death, or permanent harm to one or more people.',
        'وفاة، أو ضرر دائم لشخص أو أكثر.',
        'Décès, ou dommage permanent pour une ou plusieurs personnes.',
      ),
    ],
  },
  {
    position: 2,
    name: t('Service and operations', 'الخدمة والعمليات', 'Service et activités'),
    descriptors: [
      t('No noticeable disruption.', 'لا اضطراب ملحوظ.', 'Aucune perturbation notable.'),
      t('Brief disruption, absorbed by the unit.', 'اضطراب قصير تستوعبه الوحدة.', 'Courte perturbation, absorbée par l’unité.'),
      t(
        'A service reduced or delayed for days.',
        'تراجع خدمة أو تأخرها لأيام.',
        'Un service réduit ou retardé pendant plusieurs jours.',
      ),
      t(
        'A key service stopped for days, or reduced for weeks.',
        'توقف خدمة رئيسية لأيام، أو تراجعها لأسابيع.',
        'Un service essentiel arrêté plusieurs jours, ou réduit plusieurs semaines.',
      ),
      t(
        'Several key services stopped for a long time.',
        'توقف عدة خدمات رئيسية لمدة طويلة.',
        'Plusieurs services essentiels arrêtés durablement.',
      ),
    ],
  },
  {
    position: 3,
    name: t('Compliance', 'الامتثال', 'Conformité'),
    descriptors: [
      t(
        'A minor departure from internal rules, corrected at once.',
        'مخالفة طفيفة للقواعد الداخلية تُصحَّح فورًا.',
        'Un écart mineur aux règles internes, corrigé aussitôt.',
      ),
      t(
        'A departure from a standard, noted at an inspection.',
        'مخالفة لمعيار تُرصد أثناء تفتيش.',
        'Un écart à une norme, relevé lors d’une inspection.',
      ),
      t(
        'A finding by a regulator or an accrediting body that requires a plan.',
        'ملاحظة من جهة رقابية أو جهة اعتماد تتطلب خطة تصحيح.',
        'Une constatation d’une autorité ou d’un organisme d’accréditation exigeant un plan d’action.',
      ),
      t(
        'A formal notice, a fine, or accreditation put at risk.',
        'إنذار رسمي أو غرامة أو تعريض الاعتماد للخطر.',
        'Une mise en demeure, une amende, ou l’accréditation mise en péril.',
      ),
      t(
        'Loss of a licence or of accreditation, or prosecution.',
        'فقدان ترخيص أو اعتماد، أو ملاحقة قضائية.',
        'Perte d’une autorisation ou de l’accréditation, ou poursuites pénales.',
      ),
    ],
  },
  {
    position: 4,
    name: t('Finance', 'المالية', 'Finances'),
    descriptors: [
      t('A loss absorbed within a unit’s budget.', 'خسارة تُستوعب ضمن ميزانية الوحدة.', 'Une perte absorbée par le budget d’une unité.'),
      t(
        'A loss absorbed within a department’s budget.',
        'خسارة تُستوعب ضمن ميزانية القسم.',
        'Une perte absorbée par le budget d’un service.',
      ),
      t(
        'A loss that needs the organization’s budget to be revised.',
        'خسارة تتطلب مراجعة ميزانية الجهة.',
        'Une perte qui oblige à réviser le budget de l’organisation.',
      ),
      t(
        'A loss that affects the organization’s yearly results.',
        'خسارة تؤثر في النتائج السنوية للجهة.',
        'Une perte qui pèse sur les résultats annuels de l’organisation.',
      ),
      t(
        'A loss that threatens the organization’s survival.',
        'خسارة تهدد بقاء الجهة.',
        'Une perte qui menace la pérennité de l’organisation.',
      ),
    ],
  },
  {
    position: 5,
    name: t('Reputation', 'السمعة', 'Réputation'),
    descriptors: [
      t('Not known outside the unit.', 'لا يُعرف خارج الوحدة.', 'Inconnu hors de l’unité.'),
      t(
        'Complaints from a few people, or local talk.',
        'شكاوى من عدد قليل من الأشخاص، أو حديث محلي.',
        'Plaintes de quelques personnes, ou rumeur locale.',
      ),
      t(
        'Local media coverage, or many complaints.',
        'تغطية إعلامية محلية، أو شكاوى كثيرة.',
        'Couverture par les médias locaux, ou nombreuses plaintes.',
      ),
      t(
        'National media coverage, or loss of partners’ confidence.',
        'تغطية إعلامية وطنية، أو فقدان ثقة الشركاء.',
        'Couverture médiatique nationale, ou perte de confiance des partenaires.',
      ),
      t('Lasting loss of public trust.', 'فقدان دائم لثقة الجمهور.', 'Perte durable de la confiance du public.'),
    ],
  },
];

export type DefaultCommittee = { code: string; name: Name; position: number };

/**
 * Each with no role yet: the settings page warns until one is set, and
 * meanwhile their notices go to the holders of `risks.manage` for the whole
 * organization (spec, "Escalation").
 */
export const DEFAULT_COMMITTEES: DefaultCommittee[] = [
  { code: 'risk_committee', name: t('Risk committee', 'لجنة المخاطر', 'Comité des risques'), position: 1 },
  { code: 'governing_body', name: t('Governing body', 'الهيئة الحاكمة', 'Instance de gouvernance'), position: 2 },
];

export type DefaultBand = {
  code: BandCode;
  name: Name;
  reviewIntervalDays: number;
  /** A starting committee's code, or none. */
  escalateTo: string | null;
  acceptanceNeedsSignature: boolean;
};

export const DEFAULT_BANDS: DefaultBand[] = [
  {
    code: 'low',
    name: t('Low', 'منخفض', 'Faible'),
    reviewIntervalDays: 365,
    escalateTo: null,
    acceptanceNeedsSignature: false,
  },
  {
    code: 'medium',
    name: t('Medium', 'متوسط', 'Moyen'),
    reviewIntervalDays: 180,
    escalateTo: null,
    acceptanceNeedsSignature: true,
  },
  {
    code: 'high',
    name: t('High', 'مرتفع', 'Élevé'),
    reviewIntervalDays: 90,
    escalateTo: 'risk_committee',
    acceptanceNeedsSignature: true,
  },
  {
    code: 'extreme',
    name: t('Extreme', 'بالغ الخطورة', 'Extrême'),
    reviewIntervalDays: 30,
    escalateTo: 'governing_body',
    acceptanceNeedsSignature: true,
  },
];

/**
 * The starting band of a cell of the 5×5 matrix, by score: Low 1 to 3,
 * Medium 4 to 6, High 8 to 12, Extreme 15 to 25.
 */
export function defaultBandOf(likelihood: number, impact: number): BandCode {
  const score = likelihood * impact;
  if (score <= 3) return 'low';
  if (score <= 6) return 'medium';
  if (score <= 12) return 'high';
  return 'extreme';
}

export type DefaultCategory = { code: string; name: Name; position: number };

/**
 * Each starts with the appetite `cautious` and no statement, and a
 * tolerance of Medium (business decision 6): the client sets its own.
 */
export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  { code: 'people_safety', name: t('Safety of the people we serve', 'سلامة من نخدمهم', 'Sécurité des personnes que nous servons'), position: 1 },
  { code: 'staff_safety', name: t('Staff health and safety', 'صحة العاملين وسلامتهم', 'Santé et sécurité du personnel'), position: 2 },
  { code: 'operations', name: t('Service and operations', 'الخدمة والعمليات', 'Service et activités'), position: 3 },
  { code: 'compliance', name: t('Compliance and regulation', 'الامتثال والأنظمة', 'Conformité et réglementation'), position: 4 },
  { code: 'finance', name: t('Finance', 'المالية', 'Finances'), position: 5 },
  { code: 'reputation', name: t('Reputation', 'السمعة', 'Réputation'), position: 6 },
  { code: 'information', name: t('Information and data', 'المعلومات والبيانات', 'Information et données'), position: 7 },
  {
    code: 'facilities',
    name: t('Facilities, equipment and environment', 'المرافق والمعدات والبيئة', 'Locaux, équipements et environnement'),
    position: 8,
  },
  { code: 'strategy', name: t('Strategy', 'الاستراتيجية', 'Stratégie'), position: 9 },
];

export const DEFAULT_APPETITE = 'cautious' as const;
export const DEFAULT_TOLERANCE: BandCode = 'medium';

export type DefaultRiskRoute = {
  subject: 'risk_acceptance' | 'risk_closure';
  /** The band, for an acceptance. */
  variant: 'medium' | 'high' | 'extreme' | null;
  name: Name;
  steps: { kind: 'review' | 'approve'; roleCode: string; dueInDays: number }[];
};

/**
 * The starting routes (business decisions 7 and 9): accepting a risk above
 * its tolerance is approved by the Approving authority (Medium and High),
 * or reviewed by the Quality officer and then approved by the Approving
 * authority (Extreme); a closure that needs a second signature is approved
 * by the Quality officer. Each client edits them in the risk settings. A
 * route is made only where every role it names is there.
 */
export const DEFAULT_RISK_ROUTES: DefaultRiskRoute[] = [
  {
    subject: 'risk_acceptance',
    variant: 'medium',
    name: t(
      'Acceptance of a Medium risk above tolerance',
      'قبول خطر متوسط فوق حدّ التحمّل',
      'Acceptation d’un risque moyen au-delà de la tolérance',
    ),
    steps: [{ kind: 'approve', roleCode: 'approving_authority', dueInDays: 7 }],
  },
  {
    subject: 'risk_acceptance',
    variant: 'high',
    name: t(
      'Acceptance of a High risk above tolerance',
      'قبول خطر مرتفع فوق حدّ التحمّل',
      'Acceptation d’un risque élevé au-delà de la tolérance',
    ),
    steps: [{ kind: 'approve', roleCode: 'approving_authority', dueInDays: 7 }],
  },
  {
    subject: 'risk_acceptance',
    variant: 'extreme',
    name: t(
      'Acceptance of an Extreme risk above tolerance',
      'قبول خطر بالغ الخطورة فوق حدّ التحمّل',
      'Acceptation d’un risque extrême au-delà de la tolérance',
    ),
    steps: [
      { kind: 'review', roleCode: 'quality_officer', dueInDays: 7 },
      { kind: 'approve', roleCode: 'approving_authority', dueInDays: 7 },
    ],
  },
  {
    subject: 'risk_closure',
    variant: null,
    name: t('Closure of a risk', 'إغلاق خطر', 'Clôture d’un risque'),
    steps: [{ kind: 'approve', roleCode: 'quality_officer', dueInDays: 7 }],
  },
];
