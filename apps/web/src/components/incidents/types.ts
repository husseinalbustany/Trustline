import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { codeOf, permissionOf, statusOf } from "@/lib/api";

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
