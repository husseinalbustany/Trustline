import type { Locale } from '../i18n/locales.js';

/**
 * The incident categories every client starts with, named in every supported
 * language like the built-in roles. A client may later rename, reorder or
 * switch off its own copies, so these are only ever added, never overwritten.
 */
export const DEFAULT_INCIDENT_CATEGORIES: {
  code: string;
  name: Record<Locale, string>;
  position: number;
}[] = [
  {
    code: 'medication',
    name: { en: 'Medication', ar: 'الأدوية', fr: 'Médicaments' },
    position: 1,
  },
  {
    code: 'fall',
    name: { en: 'Fall', ar: 'السقوط', fr: 'Chute' },
    position: 2,
  },
  {
    code: 'infection',
    name: { en: 'Infection', ar: 'العدوى', fr: 'Infection' },
    position: 3,
  },
  {
    code: 'equipment',
    name: {
      en: 'Equipment and medical devices',
      ar: 'الأجهزة والمعدات الطبية',
      fr: 'Équipements et dispositifs médicaux',
    },
    position: 4,
  },
  {
    code: 'identification',
    name: {
      en: 'Patient identification',
      ar: 'تحديد هوية المريض',
      fr: 'Identification du patient',
    },
    position: 5,
  },
  {
    code: 'clinical_care',
    name: {
      en: 'Clinical care',
      ar: 'الرعاية السريرية',
      fr: 'Soins et prise en charge clinique',
    },
    position: 6,
  },
  {
    code: 'laboratory',
    name: { en: 'Laboratory', ar: 'المختبر', fr: 'Laboratoire' },
    position: 7,
  },
  {
    code: 'facility',
    name: {
      en: 'Facility and environment',
      ar: 'المرافق والبيئة',
      fr: 'Locaux et environnement',
    },
    position: 8,
  },
  {
    code: 'security',
    name: {
      en: 'Security',
      ar: 'الأمن',
      fr: 'Sécurité des personnes et des biens',
    },
    position: 9,
  },
  {
    code: 'other',
    name: { en: 'Other', ar: 'أخرى', fr: 'Autre' },
    position: 10,
  },
];
