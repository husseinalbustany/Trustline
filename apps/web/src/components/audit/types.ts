import type { Dictionary } from "@/i18n/dictionaries";

export type AuditText = Dictionary["audit"];

/** The screens' own words for recorded values, by field, then by value. */
export type ValueWords = Record<string, Record<string, string>>;
