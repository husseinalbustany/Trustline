import type { ModuleCode } from "@/config/modules";
import { api } from "./api";
import type { Localized } from "./localized";

export type Client = {
  id: string;
  slug: string;
  name: Localized;
  locales: string[];
  accreditationStandard: "JCI" | "CBAHI";
  defaultLocale: string;
  signInMethod: "password" | "sso" | "both";
  dataRegion: string | null;
  /** The hospital's own clock: an IANA name, `UTC` until one is chosen. */
  timeZone: string;
  status: "active" | "suspended";
  createdAt: string;
  /** Null only for a client created before subscriptions, if one is left. */
  subscription: {
    status: SubscriptionStatus;
    plan: { id: string; code: string; name: Localized };
  } | null;
};

export type SubscriptionStatus =
  "trial" | "active" | "past_due" | "suspended" | "cancelled";

export const subscriptionStatuses: SubscriptionStatus[] = [
  "trial",
  "active",
  "past_due",
  "suspended",
  "cancelled",
];

export const limitKeys = [
  "users",
  "sites",
  "storageMb",
  "aiCreditsPerMonth",
] as const;
export type LimitKey = (typeof limitKeys)[number];
/** Null, for any of them, is no limit. */
export type Limits = Record<LimitKey, number | null>;

export const extraKeys = [
  "sso",
  "publicReporting",
  "clinicalAiSuggestions",
] as const;
export type ExtraKey = (typeof extraKeys)[number];
export type Extras = Record<ExtraKey, boolean>;

export type Price = {
  /** ISO 4217, such as SAR. */
  currency: string;
  /** In the currency's smallest unit: halalas, cents. */
  amountMinor: number;
  term: "monthly" | "yearly";
  basis: "flat" | "per_user" | "per_site";
};

export type Plan = {
  id: string;
  code: string;
  name: Localized;
  description: Localized | null;
  modules: ModuleCode[];
  limits: Limits;
  extras: Extras;
  prices: Price[];
  /** False: retired. Its clients keep it; no other client can be given it. */
  active: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  subscribers: number;
};

/** A client's subscription, as the portal reads and changes it. */
export type TenantSubscription = {
  tenantId: string;
  plan: { id: string; code: string; name: Localized; active: boolean };
  status: SubscriptionStatus;
  startsOn: string;
  renewsOn: string | null;
  trialEndsOn: string | null;
  addOnModules: ModuleCode[];
  /** Only the limits that differ from the plan's; null is no limit. */
  limitOverrides: Partial<Limits>;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  effective: { modules: ModuleCode[]; limits: Limits; extras: Extras };
  /** What is used now of the two limits that are counted. */
  usage?: { users: number; sites: number };
};

export type Activity = {
  id: string;
  action: string;
  createdAt: string;
  adminName: string | null;
};

export type Admin = { id: string; email: string; name: string };

export { ApiError } from "./api";

/** Calls the admin portal API. */
export const platformApi = <T>(
  path: string,
  init?: { method?: string; body?: unknown },
) => api<T>(`/platform${path}`, init);
