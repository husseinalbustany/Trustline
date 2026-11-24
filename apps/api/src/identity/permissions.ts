/** Everything a role can allow. The web app shows a label for each. */
export const PERMISSIONS = [
  'incidents.report',
  'incidents.view',
  'incidents.triage',
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

/** Roles every client starts with. They cannot be edited or deleted. */
export const SYSTEM_ROLES: {
  code: string;
  nameEn: string;
  nameAr: string;
  description: string;
  permissions: Permission[];
}[] = [
  {
    code: 'administrator',
    nameEn: 'Administrator',
    nameAr: 'مسؤول النظام',
    description: 'Full access, including users, roles and settings.',
    permissions: [...PERMISSIONS],
  },
  {
    code: 'quality_officer',
    nameEn: 'Quality officer',
    nameAr: 'مسؤول الجودة',
    description: 'Triages incidents and manages actions, policies and reports.',
    permissions: [
      'incidents.report',
      'incidents.view',
      'incidents.triage',
      'actions.manage',
      'policies.view',
      'policies.manage',
      'reports.view',
    ],
  },
  {
    code: 'department_manager',
    nameEn: 'Department manager',
    nameAr: 'مدير القسم',
    description: 'Sees incidents and manages actions for a department.',
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
    nameEn: 'Reporter',
    nameAr: 'مُبلِّغ',
    description: 'Reports incidents and reads policies.',
    permissions: ['incidents.report', 'policies.view'],
  },
];
