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
    /** A number of months, in words: "36 months". */
    months?: (count: number) => string;
    /** Several items as one phrase: "1 and 2". */
    list?: (items: string[]) => string;
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
  const months = (value: unknown) =>
    typeof value === "number"
      ? (names.months?.(value) ?? String(value))
      : String(value ?? "");
  const list = (items: string[]) => names.list?.(items) ?? items.join(", ");
  if (code === "review_period_too_long") {
    return fill(errors.review_period_too_long, { max: months(details.max) });
  }
  if (code === "type_exceeds_max") {
    const types = Array.isArray(details.types)
      ? (details.types as { code?: string; defaultReviewMonths?: number }[])
      : [];
    return fill(errors.type_exceeds_max, {
      types: list(
        types.map((x) => `${x.code ?? ""} (${months(x.defaultReviewMonths)})`),
      ),
    });
  }
  if (code === "same_person_in_two_steps") {
    const positions = Array.isArray(details.positions)
      ? (details.positions as unknown[]).map(String)
      : [];
    return fill(errors.same_person_in_two_steps, { positions: list(positions) });
  }
  if (code === "same_person" && details.reason === "decided_earlier_step") {
    return errors.same_person_decided;
  }
  if (code === "same_person" && details.reason === "prepared") {
    return errors.same_person_prepared;
  }
  if (code === "in_review" || code === "awaiting_publication") {
    const field = details.field === "title" ? "title" : "ownerUnitId";
    return fill(errors[`${code}_${field}`], {
      version: String(details.version ?? ""),
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
    "stale_type",
    "stale_category",
    "stale_settings",
  ].includes(codeOf(err) ?? "");

export const textareaClass =
  "w-full rounded-md border border-line bg-background px-3 py-2 text-sm font-normal";
