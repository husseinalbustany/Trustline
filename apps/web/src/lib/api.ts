export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    /** With `missing_permission`: the permission the caller lacks. */
    readonly permission?: string,
    /** With "too many requests": the seconds to wait before trying again. */
    readonly retryAfter?: number,
    /**
     * The rest of what the API said, for a code that carries more: `limit`
     * and `max` with `limit_reached`, `module` and `requiresAnyOf` with
     * `module_dependency_missing`.
     */
    readonly details: Record<string, unknown> = {},
  ) {
    super(`API error ${status}`);
  }
}

/**
 * Calls the API through this app's own origin. Session cookies are sent
 * automatically and are never readable from here.
 *
 * `withoutSession` is for the pages open to everyone (reporting without
 * sign-in, following up a report): the request then carries no cookie, so
 * nothing ties it to an account even when the reader happens to be signed in.
 */
export async function api<T>(
  path: string,
  init?: { method?: string; body?: unknown; withoutSession?: boolean },
): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
    credentials: init?.withoutSession ? "omit" : "same-origin",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const wait = Number(res.headers.get("Retry-After"));
    throw new ApiError(
      res.status,
      data.code,
      typeof data.permission === "string" ? data.permission : undefined,
      Number.isFinite(wait) && wait > 0 ? wait : undefined,
      data && typeof data === "object" ? data : {},
    );
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const statusOf = (err: unknown) =>
  err instanceof ApiError ? err.status : 0;

export const codeOf = (err: unknown) =>
  err instanceof ApiError ? err.code : undefined;

export const retryAfterOf = (err: unknown) =>
  err instanceof ApiError ? err.retryAfter : undefined;

export const permissionOf = (err: unknown) =>
  err instanceof ApiError ? err.permission : undefined;

export const detailsOf = (err: unknown): Record<string, unknown> =>
  err instanceof ApiError ? err.details : {};

/**
 * What a refusal at a limit of the plan says: which limit, and how many it
 * allows. Null for any other answer.
 */
export function limitOf(
  err: unknown,
): { limit: "users" | "sites"; max: number } | null {
  if (codeOf(err) !== "limit_reached") return null;
  const { limit, max } = detailsOf(err);
  return (limit === "users" || limit === "sites") && typeof max === "number"
    ? { limit, max }
    : null;
}
