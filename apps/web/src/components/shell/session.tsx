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
