import type { ModuleCode } from "@/config/modules";
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
    /** Whether the hospital takes reports from people who have not signed in. */
    publicReporting: boolean;
    /**
     * The hospital's own clock, an IANA name such as `Asia/Riyadh`. Every
     * date and time its staff see or type is on it, wherever they are.
     */
    timeZone: string;
    /** The modules switched on for this client. Core is never listed. */
    modules: ModuleCode[];
    subscription: {
      status: "trial" | "active" | "past_due" | "suspended";
      /**
       * What this user is to be told: `past_due` only to whoever holds
       * `settings.manage` for the whole organization, `suspended` to all.
       */
      notice: "past_due" | "suspended" | null;
    };
  };
  user: {
    id: string;
    name: Localized;
    email: string;
    /** The unit the user works in, when one was set on their account. */
    orgUnitId: string | null;
    /**
     * Staff, or an external reviewer: someone from outside (a surveyor)
     * who may only read, for a few days. Missing from an older API: staff.
     */
    kind?: "staff" | "external_reviewer";
    /** An external reviewer's first and last day; null for staff. */
    access?: { from: string; until: string } | null;
  };
  permissions: string[];
  /**
   * How the person signs: with their password, with a signing PIN (no
   * password: single sign-on), or not yet (no password and no PIN).
   */
  signingMethod?: "password" | "pin" | "none";
  /**
   * Where each permission applies: "all" for the whole organization, or the
   * org units it covers (the granted units and everything beneath them).
   */
  scope: Record<string, "all" | string[]>;
};

/**
 * An org unit as a user's record names it. The name comes with the record,
 * so a unit switched off since is still shown by name, to everyone who may
 * see the user, whether or not they may list inactive units.
 */
export type UnitRef = { id: string; name: Localized; active: boolean };

export type RoleGrant = {
  roleId: string;
  orgUnitId: string | null;
  /** The unit the role is granted for; null for the whole organization. */
  orgUnit: UnitRef | null;
  code: string;
  name: Localized;
};

export type User = {
  id: string;
  name: Localized;
  email: string;
  orgUnitId: string | null;
  orgUnit: UnitRef | null;
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

/**
 * The pages open to everyone. Their links carry no language: each reader is
 * sent to the one their own browser asks for.
 */
export const publicReportUrl = (slug: string, unitId?: string) =>
  `${window.location.origin}/report/${encodeURIComponent(slug)}${unitId ? `?unit=${encodeURIComponent(unitId)}` : ""}`;

export const followUpUrl = (slug: string) =>
  `${window.location.origin}/follow-up/${encodeURIComponent(slug)}`;

/** Whether the person is an external reviewer, who may only read. */
export const isReviewer = (session: Session) =>
  session.user.kind === "external_reviewer";
