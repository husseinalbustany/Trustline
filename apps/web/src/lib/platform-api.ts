import { api } from "./api";
import type { Localized } from "./localized";

export type Client = {
  id: string;
  slug: string;
  name: Localized;
  locales: string[];
  accreditationStandard: "JCI" | "CBAHI";
  defaultLocale: string;
  plan: "starter" | "professional" | "enterprise";
  signInMethod: "password" | "sso" | "both";
  dataRegion: string | null;
  status: "active" | "suspended";
  createdAt: string;
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
