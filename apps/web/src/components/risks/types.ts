import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { codeOf, detailsOf, statusOf } from "@/lib/api";
import { fill } from "@/lib/format";

export type RisksText = Dictionary["risks"];
export type RisksProps = { lang: Locale; t: RisksText };

/**
 * What to tell the user when the API refuses something about risks. A
 * refusal because of the subscription is worded by the shell
 * (`useSubscriptionRefusal`), so callers ask it first.
 */
export function explain(
  err: unknown,
  t: RisksText,
  names: {
    /** A day of the client's calendar, in words. */
    day?: (day: string) => string;
    /** A number as the reader writes numbers. */
    count?: (value: number) => string;
  } = {},
): string {
  const errors = t.errors;
  const code = codeOf(err);
  const details = detailsOf(err);
  const day = (value: unknown) =>
    typeof value === "string" ? (names.day?.(value) ?? value) : "";
  const count = (value: unknown) =>
    typeof value === "number" ? (names.count?.(value) ?? String(value)) : "";
  if (code === "review_interval_too_long" && typeof details.latest === "string") {
    return fill(errors.review_interval_too_long_by, { date: day(details.latest) });
  }
  if (code === "acceptance_too_long" && typeof details.latest === "string") {
    return fill(errors.acceptance_too_long_by, { date: day(details.latest) });
  }
  if (code === "too_many_domains" && typeof details.max === "number") {
    return fill(errors.too_many_domains, { max: count(details.max) });
  }
  if (code === "no_assignee" && typeof details.position === "number") {
    return fill(errors.no_assignee_at, { position: count(details.position) });
  }
  if (code === "same_person") {
    const reason = String(details.reason ?? "");
    const key = `same_person_${reason}` as keyof typeof errors;
    return Object.hasOwn(errors, key) ? errors[key] : errors.same_person;
  }
  if (code && Object.hasOwn(errors, code)) {
    return errors[code as keyof typeof errors];
  }
  const status = statusOf(err);
  if (status === 401) return errors.signedOut;
  if (status === 404) return errors.notFound;
  if (status === 403) return errors.missing_permission;
  if (status === 429) return errors.tooMany;
  return status === 400 ? errors.invalid : errors.generic;
}

export const textareaClass =
  "w-full rounded-md border border-line bg-background px-3 py-2 text-sm font-normal";
