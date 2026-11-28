import type { Locale } from '../i18n/locales.js';
import type { ModuleCode, ModuleKey } from '../subscriptions/modules.js';

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
  // May be named in a step of an approval route by role. Being assigned a
  // step gives the right to see that version and decide that step, nothing
  // else.
  'policies.approve',
  // Read every document, restricted ones and drafts included, and see the
  // acknowledgement figures. For the quality team and auditors.
  'policies.view_all',
  // Import an organization's existing documents as approved before
  // Trustline, for the whole organization (business decision 1): the
  // Quality officer's, not the Administrator's.
  'policies.import',
  'reports.view',
  'organization.manage',
  'users.manage',
  'roles.manage',
  'settings.manage',
  // Read the audit trail and its seal (docs/specs/audit-trail.md). Only a
  // grant for the whole organization counts: a trail for one unit would
  // still name records and people outside it.
  'audit.view',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * What an external reviewer may hold: reading only. Anything else, and the
 * reporter's name (`incidents.see_reporter`), is refused for them (400
 * `not_read_only`): a just culture does not show reporters to outsiders.
 */
export const READ_ONLY_PERMISSIONS: readonly Permission[] = [
  'incidents.view',
  'policies.view',
  'policies.view_all',
  'reports.view',
  'audit.view',
];

/**
 * The module each permission belongs to. A role keeps a permission of a
 * module the client does not have, so that switching the module back on
 * restores everything; meanwhile the permission does nothing, and the
 * session (`/auth/me`) does not list it. A new permission must say here
 * where it belongs.
 */
export const PERMISSION_MODULE: Record<Permission, ModuleKey> = {
  'incidents.report': 'incidents',
  'incidents.view': 'incidents',
  'incidents.triage': 'incidents',
  'incidents.see_reporter': 'incidents',
  'incidents.sign_off': 'incidents',
  'actions.manage': 'actions',
  'policies.view': 'policies',
  'policies.manage': 'policies',
  'policies.approve': 'policies',
  'policies.view_all': 'policies',
  'policies.import': 'policies',
  // Reports draw on whichever modules are on.
  'reports.view': 'core',
  'organization.manage': 'core',
  'users.manage': 'core',
  'roles.manage': 'core',
  'settings.manage': 'core',
  'audit.view': 'core',
};

/** Whether a permission does anything for a client with these modules. */
export const permissionInUse = (
  permission: string,
  modules: readonly ModuleCode[],
) => {
  const module = (PERMISSION_MODULE as Record<string, ModuleKey | undefined>)[
    permission
  ];
  return (
    module === 'core' || (module !== undefined && modules.includes(module))
  );
};

/**
 * Roles every client starts with. They cannot be edited or deleted. Named
 * and described in every supported language; a client sees its own.
 *
 * A change here reaches a new client through ensureSystemRoles() and the demo
 * hospitals through the seed. Clients that already exist get it only from a
 * migration: write one with the change, and an audit entry per client, as
 * 0039_policies_grants_and_existing_clients.sql does.
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
    // Everything but importing documents, which is the Quality officer's
    // (business decision 1): the Administrator is often IT.
    permissions: PERMISSIONS.filter((p) => p !== 'policies.import'),
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
      'policies.approve',
      'policies.view_all',
      'policies.import',
      'reports.view',
      'audit.view',
    ],
  },
  {
    code: 'department_manager',
    name: { en: 'Department manager', ar: 'مدير القسم', fr: 'Chef de service' },
    description: {
      en: 'Sees incidents, manages actions, and reads and approves documents for a department.',
      ar: 'يطّلع على الحوادث ويدير الإجراءات التصحيحية ويقرأ الوثائق ويعتمدها في قسمه.',
      fr: 'Consulte les incidents, gère les actions, et lit et approuve les documents de son service.',
    },
    permissions: [
      'incidents.report',
      'incidents.view',
      'actions.manage',
      'policies.view',
      'policies.approve',
      'policies.view_all',
      'reports.view',
    ],
  },
  {
    // Named at onboarding: whoever gives the final approval of the
    // organization's documents (a medical director, a chief executive, a
    // plant manager, a head teacher). The starting approval route ends with
    // it (policies/defaults.ts). Given to the clients that existed before it
    // by migration 0045.
    code: 'approving_authority',
    name: {
      en: 'Approving authority',
      ar: 'صاحب صلاحية الاعتماد',
      fr: 'Autorité d’approbation',
    },
    description: {
      en: 'Gives the final approval of controlled documents, and reads every document, restricted ones and drafts included.',
      ar: 'يمنح الاعتماد النهائي للوثائق المضبوطة، ويقرأ كل الوثائق بما فيها المقيّدة والمسودات.',
      fr: 'Donne l’approbation finale des documents maîtrisés, et lit tous les documents, y compris les documents restreints et les brouillons.',
    },
    permissions: ['policies.view', 'policies.view_all', 'policies.approve'],
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
  {
    // A surveyor or auditor from outside, for a few days
    // (docs/specs/audit-trail.md): reading only, and never reporters'
    // names. Given to the clients that existed before it by migration
    // 0061. A narrower role of the client's may be given instead.
    code: 'external_reviewer',
    name: { en: 'External reviewer', ar: 'مراجع خارجي', fr: 'Évaluateur externe' },
    description: {
      en: 'A surveyor or auditor from outside, for a few days: reads the audit trail, every document, incidents without their reporters, and reports.',
      ar: 'مُقيِّم أو مدقق من خارج المؤسسة لبضعة أيام: يطّلع على سجل التدقيق وكل الوثائق والحوادث دون أسماء المُبلِّغين والتقارير.',
      fr: 'Un évaluateur ou un auditeur extérieur, pour quelques jours : consulte le journal d’audit, tous les documents, les incidents sans leurs déclarants, et les rapports.',
    },
    permissions: ['audit.view', 'policies.view_all', 'incidents.view', 'reports.view'],
  },
];
