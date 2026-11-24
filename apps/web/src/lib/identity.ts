export type Session = {
  tenant: {
    id: string;
    slug: string;
    nameEn: string;
    nameAr: string;
    accreditationStandard: string;
  };
  user: { id: string; nameEn: string; nameAr: string; email: string };
  permissions: string[];
};

export type RoleGrant = {
  roleId: string;
  orgUnitId: string | null;
  code: string;
  nameEn: string;
  nameAr: string;
};

export type User = {
  id: string;
  nameEn: string;
  nameAr: string;
  email: string;
  orgUnitId: string | null;
  employeeNumber: string | null;
  jobTitle: string | null;
  phone: string | null;
  status: "invited" | "active" | "disabled";
  lastSignInAt: string | null;
  roles: RoleGrant[];
};

export type Role = {
  id: string;
  code: string;
  nameEn: string;
  nameAr: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
  assignments: number;
};

export type OrgUnit = {
  id: string;
  parentId: string | null;
  type: "facility" | "department" | "unit";
  code: string;
  nameEn: string;
  nameAr: string;
};

export type Invite = { token: string; expiresAt: string; org: string };

/** The link a new user opens. The token sits after #, so it is never sent to a server log. */
export const inviteUrl = (lang: string, invite: Invite) =>
  `${window.location.origin}/${lang}/invite#org=${encodeURIComponent(invite.org)}&token=${encodeURIComponent(invite.token)}`;
