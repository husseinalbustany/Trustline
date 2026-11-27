import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { codeOf, permissionOf, statusOf } from "@/lib/api";
import type { IncidentView } from "@/lib/incidents";

export type IncidentsText = Dictionary["incidents"];
export type IncidentsProps = { lang: Locale; t: IncidentsText };

/** What to tell the user when the API refuses a change, and what to do next. */
export function explain(err: unknown, errors: IncidentsText["errors"]) {
  const code = codeOf(err);
  // Signing off is a right of its own: said by name, so the reader knows it
  // is not triage they are missing.
  if (
    code === "missing_permission" &&
    permissionOf(err) === "incidents.sign_off"
  ) {
    return errors.missing_sign_off;
  }
  if (code && Object.hasOwn(errors, code)) {
    return errors[code as keyof typeof errors];
  }
  const status = statusOf(err);
  // The session ended while the page was open (they last eight hours).
  if (status === 401) return errors.signedOut;
  if (status === 404) return errors.notFound;
  if (status === 403) return errors.missing_permission;
  return status === 400 ? errors.invalid : errors.generic;
}

export const textareaClass =
  "w-full rounded-md border border-line bg-background px-3 py-2 text-sm font-normal";

/**
 * Who may be reading what the reporter can read, when that may be someone
 * holding a follow-up code rather than a member of staff: said to whoever
 * writes a note or a comment the reporter will see. A reader who may not
 * know who reported it is told only that it may be so.
 */
export function whoReads(
  t: IncidentsText,
  incident: Pick<IncidentView, "reporterShown" | "reporter">,
): string | null {
  if (!incident.reporterShown) return t.reader.maybeAnonymous;
  return incident.reporter ? null : t.reader.anonymous;
}

/**
 * The wording for someone who sees an incident only as its reporter, or
 * comes with its follow-up code: plain words for its status and for what
 * was done, in place of the quality office's ("triaged", "handling
 * department"). Staff keep the office's words.
 */
export function forReporter(t: IncidentsText): IncidentsText {
  const p = t.plain;
  return {
    ...t,
    status: p.status,
    detail: { ...t.detail, ownerUnit: p.ownerUnit },
    timeline: {
      ...t.timeline,
      changed: { ...t.timeline.changed, ownerUnitId: p.ownerUnitChanged },
      events: { ...t.timeline.events, ...p.events },
    },
  };
}
