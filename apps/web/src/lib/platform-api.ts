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

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`API error ${status}`);
  }
}

/** Calls the admin portal API. The session cookie is sent automatically. */
export async function platformApi<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`/api/v1/platform${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.code);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}
