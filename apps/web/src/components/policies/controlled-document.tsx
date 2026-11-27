"use client";

import type { ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { direction, hasLocale, localeNames } from "@/i18n/config";
import { dateTimeFormat, dayFormat, fill } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import type { DocumentVersion, Named, PolicyDocument } from "@/lib/policies";
import { Markup } from "./markup";
import type { PoliciesText } from "./types";

const languageName = (locale: string) =>
  hasLocale(locale) ? localeNames[locale] : locale;

/**
 * The choice among the languages a version is written in. Shown only when
 * there is more than one.
 */
export function LanguageSwitch({
  t,
  languages,
  shown,
  onChange,
}: {
  t: PoliciesText;
  languages: string[];
  shown: string;
  onChange: (locale: string) => void;
}) {
  if (languages.length < 2) return null;
  return (
    <div
      role="group"
      aria-label={t.document.languages}
      className="flex flex-wrap items-center gap-2 print:hidden"
    >
      <span className="text-sm text-muted">{t.document.languages}</span>
      {languages.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          aria-pressed={locale === shown}
          onClick={() => onChange(locale)}
          className={`inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap ${
            locale === shown
              ? "border-accent bg-accent-soft font-medium text-accent"
              : "border-line text-muted hover:bg-surface hover:text-foreground"
          }`}
        >
          {languageName(locale)}
        </button>
      ))}
    </div>
  );
}

/**
 * A version laid out as a controlled document: the control block (number,
 * version, owner, dates, who reviewed and approved it and when), then the
 * sections in order, numbered, in the language chosen. The control block
 * is in the reader's language; the text in its own, with its own
 * direction, so an Arabic text reads right to left whatever the page is.
 */
export function ControlledDocument({
  lang,
  t,
  document,
  version,
  shown,
  printed = false,
}: {
  lang: string;
  t: PoliciesText;
  document: PolicyDocument;
  version: DocumentVersion;
  /** The language the text is shown in; null when it has no text yet. */
  shown: string | null;
  /** The print view: the "not controlled" line is on screen too. */
  printed?: boolean;
}) {
  const session = useSession();
  const fallback = session.tenant.defaultLocale;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, fallback);
  const name = (person: Named | null | undefined) =>
    (person && inLang(person.name)) || t.document.unknownPerson;
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const d = t.document;
  const c = version.control;
  const textLang = shown ?? fallback;
  const sections = version.sections.filter(
    (s) => !!version.content[textLang]?.[s.key]?.trim(),
  );
  const notInMine = shown !== null && shown !== lang;

  const rows: [string, ReactNode][] = [
    [d.number, <bdi key="n" dir="ltr">{c.number}</bdi>],
    [d.version, String(c.version)],
    [d.type, <bdi key="t">{inLang(document.type.name)}</bdi>],
    [d.ownerUnit, <bdi key="u">{inLang(document.ownerUnit.name)}</bdi>],
    [d.owner, <bdi key="o">{name(c.owner)}</bdi>],
    [d.effectiveOn, day(c.effectiveOn) ?? d.notYet],
    [d.nextReviewOn, day(c.nextReviewOn) ?? d.notSet],
  ];

  const notControlled = (
    <p
      className={`rounded-md border border-line px-3 py-2 text-sm font-medium ${
        printed ? "" : "hidden print:block"
      }`}
    >
      {d.notControlled}
    </p>
  );

  return (
    <article className="flex flex-col gap-6 print:gap-4">
      {notControlled}
      <header className="rounded-lg border border-line print:rounded-none">
        <div className="border-b border-line px-4 py-3">
          <p className="text-xs text-muted">{d.controlBlock}</p>
          <h2
            lang={textLang}
            dir={direction(textLang)}
            className="mt-1 text-lg font-semibold break-words"
          >
            {pick(document.title, textLang, fallback)}
          </h2>
        </div>
        <dl className="grid gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-wrap gap-x-2">
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="border-t border-line px-4 py-3">
          <p className="text-sm font-medium">{d.approvals}</p>
          {c.approvals.length === 0 ? (
            <p className="mt-1 text-sm text-muted">{d.noApprovals}</p>
          ) : (
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {c.approvals.map((a) => (
                <li key={a.position}>
                  {fill(a.kind === "review" ? d.reviewedBy : d.approvedBy, {
                    name: name(a.signedBy),
                    date: a.signedAt ? moment.format(new Date(a.signedAt)) : "",
                  })}
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      {notInMine && hasLocale(lang) && (
        <p className="rounded-md bg-surface px-3 py-2 text-sm text-muted print:hidden">
          {version.languages.includes(lang)
            ? fill(d.shownIn, { language: languageName(textLang) })
            : fill(d.notInYourLanguage, {
                mine: languageName(lang),
                language: languageName(textLang),
              })}
        </p>
      )}

      {shown === null || sections.length === 0 ? (
        <p className="text-sm text-muted">{d.noText}</p>
      ) : (
        <div
          lang={textLang}
          dir={direction(textLang)}
          className="flex max-w-3xl flex-col gap-6 text-start"
        >
          {sections.map((section, i) => (
            <section key={section.key} className="flex flex-col gap-2">
              <h3 className="text-base font-semibold">
                {/* The number and the name in the text's own language and
                    direction: "1. Purpose", «1. الغرض». */}
                {`${i + 1}. `}
                {pick(section.name, textLang, fallback)}
              </h3>
              <Markup text={version.content[textLang][section.key]} />
            </section>
          ))}
        </div>
      )}
      {printed && notControlled}
    </article>
  );
}
