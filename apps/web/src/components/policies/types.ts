import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { codeOf, detailsOf, statusOf } from "@/lib/api";
import { fill } from "@/lib/format";
import { IMPORT_MAX_CHARACTERS, IMPORT_MAX_DOCUMENTS } from "@/lib/policy-import";

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
    /** A day of the client's calendar, in words: "1 March 2027". */
    day?: (day: string) => string;
    /** A number as the reader writes numbers: "600,000". */
    count?: (value: number) => string;
  } = {},
): string {
  const errors = t.errors;
  const code = codeOf(err);
  const details = detailsOf(err);
  const list = (items: string[]) => names.list?.(items) ?? items.join(", ");
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
  // An AI draft with a "To be decided" mark still in it: which sections.
  if (code === "ai_draft_gaps") {
    const gaps = Array.isArray(details.gaps) ? (details.gaps as { section: string }[]) : [];
    return fill(errors.ai_draft_gaps, {
      sections: list([...new Set(gaps.map((g) => names.section?.(g.section) ?? g.section))]),
    });
  }
  if (code === "ai_allowance_reached" && typeof details.resetsOn === "string") {
    return fill(errors.ai_allowance_reached, {
      date: names.day?.(details.resetsOn) ?? details.resetsOn,
    });
  }
  if (code === "missing_sections") {
    const sections = Array.isArray(details.sections)
      ? (details.sections as string[])
      : [];
    return fill(errors.missing_sections, {
      sections: list(sections.map((s) => names.section?.(s) ?? s)),
      language: names.language?.(String(details.locale ?? "")) ?? "",
    });
  }
  const months = (value: unknown) =>
    typeof value === "number"
      ? (names.months?.(value) ?? String(value))
      : String(value ?? "");
  if (code === "batch_too_large") {
    // The limits as the API gives them, else those this app splits by.
    const count = (value: unknown, otherwise: number) => {
      const n = typeof value === "number" ? value : otherwise;
      return names.count?.(n) ?? String(n);
    };
    return fill(errors.batch_too_large, {
      documents: count(details.maxDocuments, IMPORT_MAX_DOCUMENTS),
      characters: count(details.maxCharacters, IMPORT_MAX_CHARACTERS),
    });
  }
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
  const day = (value: unknown) =>
    typeof value === "string" ? (names.day?.(value) ?? value) : "";
  if (code === "review_date_too_far") {
    // Counted from the later of the approval and the last review on paper.
    return fill(errors.review_date_too_far, {
      date: day(details.latest),
      max: months(details.maxReviewMonths),
      from: day(details.from),
    });
  }
  if (code === "review_not_due") {
    return fill(errors.review_not_due, {
      opensOn: day(details.opensOn),
      dueOn: day(details.dueOn),
    });
  }
  if (code === "number_taken") {
    return typeof details.takenBy === "string"
      ? fill(errors.number_taken_by, { number: details.takenBy })
      : errors.number_taken;
  }
  if (code === "content_required") {
    return fill(errors.content_required, {
      language: names.language?.(String(details.locale ?? "")) ?? "",
    });
  }
  if (code === "language_mismatch" && details.field === "content") {
    return errors.language_mismatch_content;
  }
  if (code === "language_mismatch" && details.field === "originalKeptAt") {
    return errors.language_mismatch_kept_at;
  }
  if (code === "language_mismatch" && details.field === "differences") {
    return errors.language_mismatch_differences;
  }
  // Imports are for migration: the latest approval day allowed, and the
  // day the import window closed, when the API gives them.
  if (code === "approved_after_start") {
    // The latest approval day allowed, or the day the module was first
    // switched on (approved before it, then).
    const latest = details.latestApprovedOn ?? details.latest;
    const started = details.startedOn ?? details.since;
    return typeof latest === "string"
      ? fill(errors.approved_after_start_by, { date: day(latest) })
      : typeof started === "string"
        ? fill(errors.approved_after_start_since, { date: day(started) })
        : errors.approved_after_start;
  }
  if (code === "import_window_closed") {
    const closed = details.closedOn ?? details.closesOn ?? details.until;
    return typeof closed === "string"
      ? fill(errors.import_window_closed_on, { date: day(closed) })
      : errors.import_window_closed;
  }
  // A number with letters of a script it may not use: only Latin, or the
  // scripts of the organization's languages.
  if (code === "invalid_number" && details.reason === "script") {
    return errors.number_script;
  }
  // A number mixing scripts, whether said by its own code or as the
  // reason of `invalid_number`.
  const script = /mixed_script|script_mix|scripts/;
  if (
    (code && script.test(code)) ||
    (code === "invalid_number" &&
      script.test(String(details.reason ?? details.problem ?? "")))
  ) {
    return errors.number_mixed_scripts;
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
