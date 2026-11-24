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
