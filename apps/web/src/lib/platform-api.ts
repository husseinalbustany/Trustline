import { api } from "./api";

export type Client = {
  id: string;
  slug: string;
  nameEn: string;
  nameAr: string;
  accreditationStandard: "JCI" | "CBAHI";
  defaultLocale: "en" | "ar";
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
