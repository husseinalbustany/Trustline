import type { Locale } from '../i18n/locales.js';

/** Everything a role can allow. The web app shows a label for each. */
export const PERMISSIONS = [
  'incidents.report',
  'incidents.view',
  'incidents.triage',
  // See who reported an incident. Without it a handler is not told.
  'incidents.see_reporter',
  // Give the second signature that closes a sentinel event or a death.
  'incidents.sign_off',
  'actions.manage',
  'policies.view',
  'policies.manage',
  'reports.view',
  'organization.manage',
  'users.manage',
  'roles.manage',
  'settings.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * Roles every client starts with. They cannot be edited or deleted. Named
 * and described in every supported language; a client sees its own.
 *
 * A change here reaches a new client through ensureSystemRoles() and the demo
 * hospitals through the seed. Clients that already exist get it only from a
 * migration: write one with the change, as
 * 0020_built_in_roles_reporter_and_sign_off.sql does.
 */
export const SYSTEM_ROLES: {
  code: string;
  name: Record<Locale, string>;
  description: Record<Locale, string>;
  permissions: Permission[];
}[] = [
  {
    code: 'administrator',
    name: { en: 'Administrator', ar: 'مسؤول النظام', fr: 'Administrateur' },
    description: {
      en: 'Full access, including users, roles and settings.',
      ar: 'صلاحية كاملة تشمل المستخدمين والأدوار والإعدادات.',
      fr: 'Accès complet, y compris les utilisateurs, les rôles et les paramètres.',
    },
    permissions: [...PERMISSIONS],
  },
  {
    code: 'quality_officer',
    name: {
      en: 'Quality officer',
      ar: 'مسؤول الجودة',
      fr: 'Responsable qualité',
    },
    description: {
      en: 'Triages incidents, manages actions and policies, and views reports.',
      ar: 'يفرز الحوادث ويدير الإجراءات التصحيحية والسياسات ويطّلع على التقارير.',
      fr: 'Trie les incidents, gère les actions et les politiques, et consulte les rapports.',
    },
    permissions: [
      'incidents.report',
      'incidents.view',
      'incidents.triage',
      'incidents.see_reporter',
      'incidents.sign_off',
      'actions.manage',
      'policies.view',
      'policies.manage',
      'reports.view',
    ],
  },
  {
    code: 'department_manager',
    name: { en: 'Department manager', ar: 'مدير القسم', fr: 'Chef de service' },
    description: {
      en: 'Sees incidents and manages actions for a department.',
      ar: 'يطّلع على الحوادث ويدير الإجراءات التصحيحية في قسمه.',
      fr: 'Consulte les incidents et gère les actions de son service.',
    },
    permissions: [
      'incidents.report',
      'incidents.view',
      'actions.manage',
      'policies.view',
      'reports.view',
    ],
  },
  {
    code: 'reporter',
    name: { en: 'Reporter', ar: 'مُبلِّغ', fr: 'Déclarant' },
    description: {
      en: 'Reports incidents and reads policies.',
      ar: 'يبلّغ عن الحوادث ويقرأ السياسات.',
      fr: 'Déclare les incidents et lit les politiques.',
    },
    permissions: ['incidents.report', 'policies.view'],
  },
];
