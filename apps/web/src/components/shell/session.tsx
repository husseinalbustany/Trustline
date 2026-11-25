"use client";

import { createContext, useContext } from "react";
import type { Session } from "@/lib/identity";

export const SessionContext = createContext<Session | null>(null);

/** The signed-in user, their hospital and what they are allowed to do. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession used outside the app shell");
  return session;
}

/** Set by the app shell: reads the session again from the API. */
export const SessionRefreshContext = createContext<() => Promise<void>>(
  async () => {},
);

/**
 * For a screen that changes something the session carries, such as a
 * hospital setting: the rest of the app then sees it without a reload.
 */
export const useRefreshSession = () => useContext(SessionRefreshContext);

export const can = (session: Session, permission: string) =>
  session.permissions.includes(permission);

/**
 * Whether the user holds a permission for one org unit: granted for the
 * whole organization, or for that unit or one above it.
 */
export function canIn(
  session: Session,
  permission: string,
  orgUnitId: string | null | undefined,
) {
  const reach = session.scope?.[permission];
  if (reach === "all") return true;
  return !!reach && !!orgUnitId && reach.includes(orgUnitId);
}
