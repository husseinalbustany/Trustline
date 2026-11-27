import type { Locale } from '../i18n/locales.js';

/**
 * The words of the policies module's CSV exports, in every supported
 * language: the files are made by the API, so their headings cannot come
 * from the web app's dictionaries. Worded for any organization, and as the
 * screens word the same things (apps/web/src/i18n/dictionaries). A new
 * language needs its words here too; the type below fails until it has
 * them.
 */

type Words<K extends string> = Record<Locale, Record<K, string>>;

export const DOCUMENT_LIST_HEADINGS: Words<
  | 'number'
  | 'title'
  | 'type'
  | 'category'
  | 'responsibleArea'
  | 'owner'
  | 'status'
  | 'confidentiality'
  | 'version'
  | 'effectiveOn'
  | 'nextReviewOn'
  | 'reviewState'
  | 'lastReviewedOn'
  | 'reviewMonths'
  | 'acknowledgementRequired'
  | 'inProgressVersion'
  | 'inProgressStatus'
> = {
  en: {
    number: 'Number',
    title: 'Title',
    type: 'Type',
    category: 'Category',
    responsibleArea: 'Responsible area',
    owner: 'Owner',
    status: 'Status',
    confidentiality: 'Who can read it',
    version: 'Version in force',
    effectiveOn: 'In force from',
    nextReviewOn: 'Next review',
    reviewState: 'Periodic review',
    lastReviewedOn: 'Last reviewed',
    reviewMonths: 'Review period (months)',
    acknowledgementRequired: 'Acknowledgement asked',
    inProgressVersion: 'Version in progress',
    inProgressStatus: 'Status of the version in progress',
  },
  ar: {
    number: 'الرقم',
    title: 'العنوان',
    type: 'النوع',
    category: 'الفئة',
    responsibleArea: 'الجهة المسؤولة',
    owner: 'المسؤول عن الوثيقة',
    status: 'الحالة',
    confidentiality: 'من يستطيع قراءتها',
    version: 'الإصدار الساري',
    effectiveOn: 'تاريخ السريان',
    nextReviewOn: 'المراجعة القادمة',
    reviewState: 'المراجعة الدورية',
    lastReviewedOn: 'آخر مراجعة',
    reviewMonths: 'دورة المراجعة (بالأشهر)',
    acknowledgementRequired: 'الإقرار بالاطلاع مطلوب',
    inProgressVersion: 'الإصدار قيد الإعداد',
    inProgressStatus: 'حالة الإصدار قيد الإعداد',
  },
  fr: {
    number: 'Numéro',
    title: 'Titre',
    type: 'Type',
    category: 'Catégorie',
    responsibleArea: 'Entité responsable',
    owner: 'Responsable',
    status: 'Statut',
    confidentiality: 'Qui peut le lire',
    version: 'Version en vigueur',
    effectiveOn: 'Date d’entrée en vigueur',
    nextReviewOn: 'Prochaine révision',
    reviewState: 'Révision périodique',
    lastReviewedOn: 'Dernière révision',
    reviewMonths: 'Périodicité de révision (mois)',
    acknowledgementRequired: 'Prise de connaissance demandée',
    inProgressVersion: 'Version en cours',
    inProgressStatus: 'Statut de la version en cours',
  },
};

export const ACKNOWLEDGEMENT_HEADINGS: Words<
  | 'number'
  | 'version'
  | 'versionStatus'
  | 'person'
  | 'email'
  | 'employeeNumber'
  | 'area'
  | 'account'
  | 'assignedOn'
  | 'dueOn'
  | 'state'
  | 'acknowledgedAt'
  | 'signatureFingerprint'
> = {
  en: {
    number: 'Document number',
    version: 'Version',
    versionStatus: 'Status of the version',
    person: 'Person',
    email: 'Email',
    employeeNumber: 'Employee number',
    area: 'Their area',
    account: 'Account',
    assignedOn: 'Asked on',
    dueOn: 'Due on',
    state: 'Where it stands',
    acknowledgedAt: 'Acknowledged at',
    signatureFingerprint: 'Fingerprint of what was signed',
  },
  ar: {
    number: 'رقم الوثيقة',
    version: 'الإصدار',
    versionStatus: 'حالة الإصدار',
    person: 'الشخص',
    email: 'البريد الإلكتروني',
    employeeNumber: 'الرقم الوظيفي',
    area: 'جهته',
    account: 'الحساب',
    assignedOn: 'تاريخ الطلب',
    dueOn: 'الموعد النهائي',
    state: 'الوضع',
    acknowledgedAt: 'تاريخ الإقرار',
    signatureFingerprint: 'البصمة الرقمية لما وُقِّع',
  },
  fr: {
    number: 'Numéro du document',
    version: 'Version',
    versionStatus: 'Statut de la version',
    person: 'Personne',
    email: 'Courriel',
    employeeNumber: 'Matricule',
    area: 'Son entité',
    account: 'Compte',
    assignedOn: 'Sollicité le',
    dueOn: 'Attendu le',
    state: 'Situation',
    acknowledgedAt: 'Confirmé le',
    signatureFingerprint: 'Empreinte de ce qui a été signé',
  },
};

export const EXPORT_VALUES: Words<
  | 'status.draft'
  | 'status.active'
  | 'status.retired'
  | 'version.draft'
  | 'version.in_review'
  | 'version.approved'
  | 'version.published'
  | 'version.superseded'
  | 'version.withdrawn'
  | 'confidentiality.all_staff'
  | 'confidentiality.restricted'
  | 'review.due'
  | 'review.overdue'
  | 'yes'
  | 'no'
  | 'ack.acknowledged'
  | 'ack.pending'
  | 'ack.overdue'
  | 'account.active'
  | 'account.left'
  | 'account.invited'
> = {
  en: {
    'status.draft': 'Draft',
    'status.active': 'Current',
    'status.retired': 'Retired',
    'version.draft': 'Draft',
    'version.in_review': 'In review',
    'version.approved': 'Approved',
    'version.published': 'Published',
    'version.superseded': 'Superseded',
    'version.withdrawn': 'Withdrawn',
    'confidentiality.all_staff': 'All staff',
    'confidentiality.restricted': 'Restricted',
    'review.due': 'Due within 30 days',
    'review.overdue': 'Past its review date',
    yes: 'Yes',
    no: 'No',
    'ack.acknowledged': 'Acknowledged',
    'ack.pending': 'Not yet',
    'ack.overdue': 'Overdue',
    'account.active': 'Active',
    'account.left': 'No longer active',
    'account.invited': 'Invited, never signed in',
  },
  ar: {
    'status.draft': 'مسودة',
    'status.active': 'سارية',
    'status.retired': 'أُوقف العمل بها',
    'version.draft': 'مسودة',
    'version.in_review': 'قيد المراجعة',
    'version.approved': 'معتمد',
    'version.published': 'منشور',
    'version.superseded': 'حلّ محله إصدار أحدث',
    'version.withdrawn': 'مسحوب',
    'confidentiality.all_staff': 'كل الموظفين',
    'confidentiality.restricted': 'مقيّدة',
    'review.due': 'مستحقة خلال 30 يومًا',
    'review.overdue': 'فات موعد مراجعتها',
    yes: 'نعم',
    no: 'لا',
    'ack.acknowledged': 'أقرّ بالاطلاع',
    'ack.pending': 'لم يُقرّ بعد',
    'ack.overdue': 'متأخر',
    'account.active': 'نشط',
    'account.left': 'لم يعد نشطًا',
    'account.invited': 'مدعو، لم يسجّل الدخول قط',
  },
  fr: {
    'status.draft': 'Brouillon',
    'status.active': 'En vigueur',
    'status.retired': 'Retiré',
    'version.draft': 'Brouillon',
    'version.in_review': 'En vérification',
    'version.approved': 'Approuvée',
    'version.published': 'Publiée',
    'version.superseded': 'Remplacée',
    'version.withdrawn': 'Abandonnée',
    'confidentiality.all_staff': 'Tout le personnel',
    'confidentiality.restricted': 'Restreint',
    'review.due': 'À faire dans les 30 jours',
    'review.overdue': 'Date de révision dépassée',
    yes: 'Oui',
    no: 'Non',
    'ack.acknowledged': 'Confirmé',
    'ack.pending': 'Pas encore',
    'ack.overdue': 'En retard',
    'account.active': 'Actif',
    'account.left': 'N’est plus actif',
    'account.invited': 'Invité, jamais connecté',
  },
};

export type ExportValue = keyof (typeof EXPORT_VALUES)['en'];
