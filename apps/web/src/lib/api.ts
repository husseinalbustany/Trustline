export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`API error ${status}`);
  }
}

/**
 * Calls the API through this app's own origin. Session cookies are sent
 * automatically and are never readable from here.
 */
export async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
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

export const statusOf = (err: unknown) =>
  err instanceof ApiError ? err.status : 0;

export const codeOf = (err: unknown) =>
  err instanceof ApiError ? err.code : undefined;
