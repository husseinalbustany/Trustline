import { useSyncExternalStore } from "react";
import type { Localized } from "./localized";

/**
 * An incident just handed to a department outside the user's own scope:
 * it can no longer be shown to them, so the list they are taken back to
 * says where it went. Kept in memory only, for the next list shown.
 */
export type HandOff = { reference: string; unit: Localized };

let handOff: HandOff | null = null;
const listeners = new Set<() => void>();

/** Leaves word of a hand-off for the list, or takes it away (null). */
export function tellHandOff(next: HandOff | null) {
  handOff = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The hand-off waiting to be said, if there is one. */
export const useHandOff = () =>
  useSyncExternalStore(
    subscribe,
    () => handOff,
    () => null,
  );
