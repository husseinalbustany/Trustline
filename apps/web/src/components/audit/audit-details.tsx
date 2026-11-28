"use client";

import type { ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { dateTimeFormat, dayFormat, fill, languageNameIn, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import type { AuditEntry } from "@/lib/audit";
import type { AuditText, ValueWords } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * Not shown: identifiers and fingerprints, which say nothing to a reader
 * and are all in the CSV and the chain file; a staff member's email, which
 * entries no longer keep; and what masking leaves out.
 */
const HIDDEN = new Set([
  "commentId",
  "contentHash",
  "listHash",
  "signatureId",
  "platformAdminId",
  "platformAdminEmail",
  "versionId",
  "runId",
  "routeId",
  "batchId",
  "copiedFromVersionId",
  "supersededVersionId",
  "withdrawnVersionId",
  "recordId",
]);

/** Fields whose values are languages. */
const LANGUAGE_FIELDS = new Set(["locale", "language", "authoritativeLocale", "authoritative"]);
/** Fields whose values are permissions, and those that name other fields. */
const PERMISSION_FIELDS = new Set(["permissions", "permissionsAdded", "permissionsRemoved"]);
/** A switch, said "on" or "off" rather than "yes" or "no". */
const SWITCH_FIELDS = new Set(["enabled", "immediate", "digest", "weekly"]);

const isLocalized = (v: object, locales: string[]): v is Localized =>
  Object.keys(v).length > 0 &&
  Object.entries(v).every(([k, x]) => locales.includes(k) && (typeof x === "string" || x === null));

const isChange = (v: object): v is { from: unknown; to: unknown } =>
  "from" in v && "to" in v;

/**
 * What an entry recorded, worded per field: the field first, then its
 * value ("Status: In progress → Closed"), so no verb has to agree with a
 * name. Values are worded as the screens word them; identifiers are left
 * out; anything this app has no words for is shown as it was recorded.
 */
export function AuditDetails({
  lang,
  t,
  values,
  permissions,
  entry,
}: {
  lang: string;
  t: AuditText;
  values: ValueWords;
  permissions: Record<string, string>;
  entry: AuditEntry;
}) {
  const session = useSession();
  const { defaultLocale, locales, timeZone } = session.tenant;
  const numbers = numberFormat(lang);
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, timeZone);
  const languageName = languageNameIn(lang);
  const fields = t.fields as Record<string, string>;
  const details = entry.details;
  if (!details) return null;

  // A value in words; null when there is nothing a reader could use.
  const word = (field: string, v: unknown, switched = false): ReactNode | null => {
    if (v === null || v === undefined || v === "") return t.none;
    if (typeof v === "boolean") return switched ? (v ? t.on : t.off) : v ? t.yes : t.no;
    if (typeof v === "number") return numbers.format(v);
    if (typeof v === "string") {
      if (UUID.test(v)) return null;
      if (LANGUAGE_FIELDS.has(field)) return languageName(v) ?? v;
      if (PERMISSION_FIELDS.has(field)) return permissions[v] ?? <bdi dir="ltr">{v}</bdi>;
      if (field === "changed") return fields[v] ?? <bdi dir="ltr">{v}</bdi>;
      const worded = values[field]?.[v];
      if (worded) return worded;
      if (DAY.test(v)) return day(v) ?? v;
      if (MOMENT.test(v)) {
        const at = new Date(v);
        if (!Number.isNaN(at.getTime())) return moment.format(at);
      }
      return <bdi dir="auto">{v}</bdi>;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) return t.none;
      // A list of records: how many.
      if (v.some((x) => typeof x === "object" || (typeof x === "string" && UUID.test(x)))) {
        return numbers.format(v.length);
      }
      const parts = v.map((x) => word(field, x, switched)).filter((x) => x !== null);
      return (
        <>
          {parts.map((p, i) => (
            <span key={i}>
              {i > 0 && ", "}
              {p}
            </span>
          ))}
        </>
      );
    }
    if (typeof v === "object") {
      if (isLocalized(v, locales)) return <bdi>{pick(v, lang, defaultLocale)}</bdi>;
      if (isChange(v)) return change(field, v.from, v.to, switched);
      // Anything else as it was recorded, left to right.
      return (
        <code dir="ltr" className="text-xs break-all">
          {JSON.stringify(v)}
        </code>
      );
    }
    return null;
  };

  // A value that changed: "before → after"; "changed" when both are records.
  const change = (field: string, from: unknown, to: unknown, switched: boolean) => {
    const a = word(field, from, switched);
    const b = word(field, to, switched);
    if (a === null || b === null) return t.changedValue;
    const [before, after] = fill(t.change, { from: "\u0000", to: "\u0001" }).split(/\u0000|\u0001/);
    return (
      <>
        {before}
        {a}
        {after}
        {b}
      </>
    );
  };

  const rows: { label: string; value: ReactNode }[] = [];
  const changeOf = t.changeOf as Record<string, string>;
  const topChange = "from" in details && "to" in details;
  if (topChange) {
    const switched = entry.action === "public_reporting_changed";
    rows.push({
      label: changeOf[entry.action] ?? fields.status,
      value: change("status", details.from, details.to, switched),
    });
  }
  for (const [field, v] of Object.entries(details)) {
    if (HIDDEN.has(field) || (topChange && (field === "from" || field === "to"))) continue;
    const value = word(field, v, SWITCH_FIELDS.has(field));
    if (value === null) continue;
    rows.push({ label: fields[field] ?? field, value });
  }
  if (rows.length === 0) return null;

  // "{field}: {value}" in each language's own form.
  const [lead, middle, tail] = fill(t.detail, { field: "\u0000", value: "\u0001" }).split(
    /\u0000|\u0001/,
  );
  return (
    <ul className="mt-1 flex flex-col gap-0.5 text-sm">
      {rows.map((row, i) => (
        <li key={i} className="break-words">
          {lead}
          <span className="text-muted">{row.label}</span>
          {middle}
          {row.value}
          {tail}
        </li>
      ))}
    </ul>
  );
}
