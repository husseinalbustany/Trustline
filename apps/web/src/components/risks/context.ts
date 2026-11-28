"use client";

import { useEffect, useState } from "react";
import { can, useSession } from "@/components/shell/session";
import { api } from "@/lib/api";
import type { Locale } from "@/i18n/config";
import type { Localized } from "@/lib/localized";
import type {
  Band,
  Committee,
  Matrix,
  PickerPerson,
  Risk,
  RiskAnswer,
  RiskSettings,
} from "@/lib/risks";
import type { RisksText } from "./types";

/** What every part of a risk's page reads. */
export type RiskContext = {
  t: RisksText;
  lang: Locale;
  risk: Risk;
  settings: RiskSettings | null;
  matrix: Matrix | null;
  word: (band: Band) => string;
  inLang: (text: Localized | null | undefined) => string;
  name: {
    person: (id: string | null | undefined) => string;
    unit: (id: string | null | undefined) => string;
    category: (id: string | null | undefined) => string;
    committee: (id: string | null | undefined) => string;
  };
  day: (day: string | null | undefined) => string | null;
  moment: (iso: string | null | undefined) => string;
  number: (n: number) => string;
  explain: (err: unknown) => string;
  /** The risk as the API answered after a change. */
  adopt: (answer: RiskAnswer) => void;
  /** Read the risk again, saying it changed meanwhile. */
  reload: (stale?: boolean) => Promise<void>;
  /** Someone who may only read: offered nothing to do. */
  readOnly: boolean;
  /** The subscription is suspended: only safety work stays open. */
  suspended: boolean;
  /** The client's clock, for "today". */
  timeZone: string;
  /** A number of months, in words. */
  months: (n: number) => string;
  /** The documents module is on: controls may name a procedure. */
  policiesOn: boolean;
};

/**
 * The people one may choose as an owner: everyone active, for whoever
 * manages risks; else those the page already names, and oneself.
 */
export function usePeople(known: Record<string, Localized> = {}) {
  const session = useSession();
  const manages = can(session, "risks.manage");
  const [people, setPeople] = useState<PickerPerson[] | null>(null);
  useEffect(() => {
    if (!manages) return;
    let current = true;
    api<PickerPerson[]>("/risks/people")
      .then((list) => current && setPeople(list))
      .catch(() => current && setPeople([]));
    return () => {
      current = false;
    };
  }, [manages]);
  if (manages && people && people.length > 0) return people;
  const fallback: PickerPerson[] = Object.entries(known).map(([id, name]) => ({
    id,
    name,
    orgUnitId: null,
  }));
  if (!fallback.some((p) => p.id === session.user.id)) {
    fallback.unshift({ id: session.user.id, name: session.user.name, orgUnitId: null });
  }
  return fallback;
}

/**
 * How high a committee sits: the highest band that escalates to it in the
 * matrix in use, or -1 for one no band names.
 */
export function committeeRank(matrix: Matrix | null, committeeId: string | null) {
  if (!matrix || !committeeId) return -1;
  return matrix.bands.reduce(
    (rank, band, i) => (band.escalateToCommitteeId === committeeId ? i : rank),
    -1,
  );
}

/** The committees a risk may be put before by hand: only higher ones. */
export function committeesAbove(
  committees: Committee[],
  matrix: Matrix | null,
  currentId: string | null,
) {
  const others = committees.filter((c) => c.active && c.id !== currentId);
  const rank = committeeRank(matrix, currentId);
  if (!currentId || rank < 0) return others;
  return others.filter((c) => committeeRank(matrix, c.id) > rank);
}
