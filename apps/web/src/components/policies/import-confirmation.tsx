"use client";

import { useSession } from "@/components/shell/session";
import { Pill } from "@/components/ui/pill";
import { dateTimeFormat, dayFormat, fill } from "@/lib/format";
import { pick } from "@/lib/localized";
import type { ImportConfirmation } from "@/lib/policies";
import type { PoliciesText } from "./types";

type Confirmation = Omit<ImportConfirmation, "signatureId">;

/** The state as one word: by the import, confirmed, overdue or awaiting. */
const stateOf = (c: Confirmation) =>
  c.state === "confirmed"
    ? c.byImport
      ? "byImport"
      : "confirmed"
    : c.state === "overdue"
      ? "overdue"
      : "awaiting";

/** Where the owner's confirmation of an import stands, as a pill. */
export function ConfirmationPill({ t, c }: { t: PoliciesText; c: Confirmation }) {
  const state = stateOf(c);
  return (
    <Pill
      tone={
        state === "overdue"
          ? "danger"
          : state === "awaiting"
            ? "warn"
            : "ok"
      }
    >
      {t.confirmation.pill[state]}
    </Pill>
  );
}

/**
 * The same in a sentence: due by when and from whom, or by whom and when it
 * was given. Given the document's owner now, a confirmation given by
 * someone else is said to be by the owner then.
 */
export function useConfirmationLine(lang: string, t: PoliciesText) {
  const session = useSession();
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const nameOf = (person: Confirmation["confirmedBy"] | undefined) =>
    pick(person?.name, lang, session.tenant.defaultLocale) ||
    t.document.unknownPerson;
  return (c: Confirmation, ownerId?: string) => {
    const state = stateOf(c);
    const l = t.confirmation.line;
    if (state === "confirmed") {
      const then = !!ownerId && !!c.confirmedBy && c.confirmedBy.id !== ownerId;
      return fill(then ? l.confirmedThen : l.confirmed, {
        date: c.confirmedAt ? moment.format(new Date(c.confirmedAt)) : "",
        name: nameOf(c.confirmedBy),
      });
    }
    if (state === "byImport") return l.byImport;
    const from = c.dueFrom ? (state === "overdue" ? l.overdueFrom : l.awaitingFrom) : l[state];
    return fill(from, { date: day(c.dueOn) ?? "", name: nameOf(c.dueFrom) });
  };
}
