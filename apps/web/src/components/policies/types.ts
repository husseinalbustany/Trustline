import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { codeOf, detailsOf, statusOf } from "@/lib/api";
import { fill } from "@/lib/format";

export type PoliciesText = Dictionary["policies"];
export type PoliciesProps = { lang: Locale; t: PoliciesText };

/**
 * What to tell the user when the API refuses something, and what to do
 * next. A refusal because of the subscription is worded by the shell
 * (`useSubscriptionRefusal`), so callers ask it first.
 */
export function explain(
  err: unknown,
  t: PoliciesText,
  names: {
    /** A section's name, for a refusal about one section. */
    section?: (key: string) => string;
    /** A language's name, for a refusal about one language. */
    language?: (locale: string) => string;
  } = {},
): string {
  const errors = t.errors;
  const code = codeOf(err);
  const details = detailsOf(err);
  if (code === "unsupported_markup") {
    const problem = String(details.problem ?? "");
    const why = Object.hasOwn(t.markupProblems, problem)
      ? t.markupProblems[problem as keyof typeof t.markupProblems]
      : t.markupProblems.other;
    return fill(errors.unsupported_markup, {
      section: names.section?.(String(details.section ?? "")) ?? "",
      language: names.language?.(String(details.locale ?? "")) ?? "",
      problem: why,
    });
  }
  if (code === "missing_sections") {
    const sections = Array.isArray(details.sections)
      ? (details.sections as string[])
      : [];
    return fill(errors.missing_sections, {
      sections: sections.map((s) => names.section?.(s) ?? s).join(", "),
      language: names.language?.(String(details.locale ?? "")) ?? "",
    });
  }
  if (code === "unknown_section") {
    return fill(errors.unknown_section, {
      section: String(details.section ?? ""),
    });
  }
  if (code && Object.hasOwn(errors, code)) {
    return errors[code as keyof typeof errors];
  }
  const status = statusOf(err);
  if (status === 401) return errors.signedOut;
  if (status === 404) return errors.notFound;
  if (status === 403) return errors.missing_permission;
  return status === 400 ? errors.invalid : errors.generic;
}

/** A refusal that means the page shows an older state than the API's. */
export const isStale = (err: unknown) =>
  [
    "stale_document",
    "stale_version",
    "stale_route",
    "not_draft",
    "not_in_review",
    "not_in_progress",
    "not_approved",
    "not_current_step",
    "not_active",
    "document_retired",
    "version_in_progress",
    "already_acknowledged",
  ].includes(codeOf(err) ?? "");

export const textareaClass =
  "w-full rounded-md border border-line bg-background px-3 py-2 text-sm font-normal";
