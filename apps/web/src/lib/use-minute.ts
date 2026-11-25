"use client";

import { useSyncExternalStore } from "react";

const subscribe = (changed: () => void) => {
  const timer = setInterval(changed, 5_000);
  return () => clearInterval(timer);
};
const thisMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
const notYet = () => null;

/**
 * The present minute, kept up with the clock, for a time shown on the page.
 * Null on the server and until the page is live in the browser: a clock
 * drawn by the server would be the server's, and already old.
 */
export function useMinute(): Date | null {
  const minute = useSyncExternalStore(subscribe, thisMinute, notYet);
  return minute === null ? null : new Date(minute);
}
