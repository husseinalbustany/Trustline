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

/** The same in a sentence: due by when, or by whom and when it was given. */
export function useConfirmationLine(lang: string, t: PoliciesText) {
  const session = useSession();
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  return (c: Confirmation) => {
    const state = stateOf(c);
    return fill(t.confirmation.line[state], {
      date:
        state === "confirmed" && c.confirmedAt
          ? moment.format(new Date(c.confirmedAt))
          : (day(c.dueOn) ?? ""),
      name:
        pick(c.confirmedBy?.name, lang, session.tenant.defaultLocale) ||
        t.document.unknownPerson,
    });
  };
}
