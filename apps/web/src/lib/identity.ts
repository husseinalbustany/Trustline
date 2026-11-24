import type { Localized } from "./localized";

export type Session = {
  tenant: {
    id: string;
    slug: string;
    name: Localized;
    /** The languages this hospital works in, and the one its text must exist in. */
    locales: string[];
    defaultLocale: string;
    accreditationStandard: string;
  };
  user: {
    id: string;
    name: Localized;
    email: string;
    /** The unit the user works in, when one was set on their account. */
    orgUnitId: string | null;
  };
  permissions: string[];
  /**
   * Where each permission applies: "all" for the whole organization, or the
   * org units it covers (the granted units and everything beneath them).
   */
  scope: Record<string, "all" | string[]>;
};

export type RoleGrant = {
  roleId: string;
  orgUnitId: string | null;
  code: string;
  name: Localized;
};

export type User = {
  id: string;
  name: Localized;
  email: string;
  orgUnitId: string | null;
  employeeNumber: string | null;
  jobTitle: string | null;
  phone: string | null;
  status: "invited" | "active" | "disabled";
  /** The day of the last sign-in, as "2026-11-24": a date, not a moment. */
  lastSignInAt: string | null;
  roles: RoleGrant[];
};

export type Role = {
  id: string;
  code: string;
  name: Localized;
  description: Localized | null;
  isSystem: boolean;
  permissions: string[];
  assignments: number;
};

export type OrgUnit = {
  id: string;
  parentId: string | null;
  type: "facility" | "department" | "unit";
  code: string;
  name: Localized;
  /** Switched off: kept for history, no longer chosen for anything new. */
  active: boolean;
};

export type Invite = { token: string; expiresAt: string; org: string };

/** The link a new user opens. The token sits after #, so it is never sent to a server log. */
export const inviteUrl = (lang: string, invite: Invite) =>
  `${window.location.origin}/${lang}/invite#org=${encodeURIComponent(invite.org)}&token=${encodeURIComponent(invite.token)}`;
