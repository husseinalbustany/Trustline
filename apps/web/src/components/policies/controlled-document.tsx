"use client";

import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, type ReactNode } from "react";
import { useSession } from "@/components/shell/session";
import { direction, hasLocale, localeNames } from "@/i18n/config";
import {
  dateTimeFormat,
  dayFormat,
  fill,
  languageNameIn,
  numberFormat,
} from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import {
  authoritativeOf,
  documentPath,
  notInForce,
  type DocumentVersion,
  type Named,
  type PolicyDocument,
} from "@/lib/policies";
import { useConfirmationLine } from "./import-confirmation";
import { Markup } from "./markup";
import { Words } from "./sentence";
import type { PoliciesText } from "./types";

/** On a button that chooses a language: the language's own name. */
const ownName = (locale: string) =>
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
          {ownName(locale)}
        </button>
      ))}
    </div>
  );
}

/**
 * A version laid out as a controlled document: the control block (number,
 * version, owner, dates, who prepared, reviewed and approved it and when),
 * then the sections in order, numbered, in the language chosen. The control
 * block is in the reader's language; the text in its own, with its own
 * direction, so an Arabic text reads right to left whatever the page is.
 *
 * A section not written in the language chosen is shown in the client's
 * main language, in its place and with a note, so the numbering is the
 * same in every language. A version that is not in force says so at the
 * top, in its control block and across every printed page; every printed
 * page carries what identifies it (see `PrintedPages`).
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
  const languageName = languageNameIn(lang);
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const dayOf = dateTimeFormat(lang, session.tenant.timeZone, {
    dateStyle: "medium",
  });
  const d = t.document;
  const c = version.control;
  const textLang = shown ?? fallback;
  const standing = notInForce(document, version);
  const status = version.languageStatus;
  // The language whose text applies where two differ, as the API says.
  const authoritative = authoritativeOf(version, fallback);
  const stateOf = (key: string) =>
    status?.sections.find((x) => x.key === key)?.locales[textLang];
  const lagging =
    textLang === authoritative ? 0 : (status?.byLocale[textLang]?.lagging ?? 0);

  // Every section written in some language, each in the language chosen
  // when it is written there, else in the authoritative language (or the
  // first that has it), so that section 4 is section 4 in every language.
  const written = (locale: string, key: string) =>
    !!version.content[locale]?.[key]?.trim();
  const sections = version.sections.flatMap((section) => {
    if (written(textLang, section.key)) {
      return [{ section, locale: textLang }];
    }
    const other = [authoritative, ...version.languages].find((l) =>
      written(l, section.key),
    );
    return other ? [{ section, locale: other }] : [];
  });
  const notInMine = shown !== null && shown !== lang;

  const ended =
    standing === "retired"
      ? document.retiredAt
      : standing === "superseded"
        ? version.supersededAt
        : null;
  const rows: [string, ReactNode][] = [
    [d.number, <bdi key="n" dir="ltr">{c.number}</bdi>],
    [d.version, numberFormat(lang).format(c.version)],
    [d.type, <bdi key="t">{inLang(document.type.name)}</bdi>],
    [d.ownerUnit, <bdi key="u">{inLang(document.ownerUnit.name)}</bdi>],
    [d.owner, <bdi key="o">{name(c.owner)}</bdi>],
    [d.effectiveOn, day(c.effectiveOn) ?? d.notYet],
  ];
  if (version.languages.length > 1) {
    // Named on the document itself rather than by the organization: said so.
    rows.push([
      d.authoritative,
      document.authoritativeLocale && document.authoritativeLocale === authoritative
        ? fill(d.authoritativeOwn, { language: languageName(authoritative) })
        : languageName(authoritative),
    ]);
  }
  if (ended) {
    rows.push([d.notInForceSince, dayOf.format(new Date(ended))]);
  }
  // Approved before Trustline: what the original says, never shown as a
  // Trustline approval, and its next review is a re-issue.
  const before =
    c.approvedThrough === "before_trustline"
      ? (c.approvedBeforeTrustline ?? null)
      : null;
  const imported = c.approvedThrough === "before_trustline";
  const notInOriginal = before?.sectionsNotInOriginal ?? [];
  if (!standing) {
    rows.push([
      imported ? t.imported.nextReviewReissue : d.nextReviewOn,
      day(c.nextReviewOn) ?? d.notSet,
    ]);
  }

  // Who prepared it, then each signature: one line each, the date and time
  // kept together.
  const when = (iso: string | null) =>
    iso ? (
      <span className="whitespace-nowrap">{moment.format(new Date(iso))}</span>
    ) : (
      ""
    );
  // An imported version was prepared by nobody in Trustline.
  const preparedBy =
    c.preparedBy !== undefined ? c.preparedBy : version.preparedBy;
  const signedLines = [
    ...(preparedBy && !imported
      ? [
          {
            key: "prepared",
            text: d.preparedBy,
            person: preparedBy,
            at: version.preparedAt,
          },
        ]
      : []),
    ...c.approvals.map((a) => ({
      key: `step-${a.position}`,
      text: a.kind === "review" ? d.reviewedBy : d.approvedBy,
      person: a.signedBy,
      at: a.signedAt,
    })),
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
      {standing && (
        <div
          role="note"
          className="flex flex-col gap-1 rounded-lg border-2 border-danger bg-danger-soft px-4 py-3 text-sm"
        >
          <p className="text-base font-semibold text-danger">
            {t.notInForce[standing]}
          </p>
          <p>
            {fill(t.notInForce[`${standing}Help`], {
              date: ended ? dayOf.format(new Date(ended)) : "",
            })}
          </p>
          {standing === "superseded" && document.published && (
            <p className="print:hidden">
              <Link
                href={documentPath(lang, document.id)}
                className="text-accent hover:underline"
              >
                {t.notInForce.openCurrent}
              </Link>
            </p>
          )}
        </div>
      )}
      {notControlled}
      <header className="rounded-lg border border-line print:rounded-none">
        <div className="border-b border-line px-4 py-3">
          <p
            className={`text-xs ${standing ? "font-semibold text-danger" : "text-muted"}`}
          >
            {standing ? t.notInForce[standing] : d.controlBlock}
          </p>
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
        {imported ? (
          <ApprovedBefore lang={lang} t={t} before={before} ownerId={c.owner.id} />
        ) : (
        <div className="border-t border-line px-4 py-3">
          <p className="text-sm font-medium">{d.approvals}</p>
          <ul className="mt-1 flex flex-col gap-1 text-sm">
            {signedLines.map((line) => (
              <li key={line.key}>
                <Words
                  text={line.text}
                  values={{ name: name(line.person), date: when(line.at) }}
                />
              </li>
            ))}
            {c.approvals.length === 0 && (
              <li className="text-muted">{d.noApprovals}</li>
            )}
          </ul>
        </div>
        )}
      </header>

      {/* Not written in the reader's language at all: said on paper too,
          so a printed copy explains why its text is in another language. */}
      {/* Sections the original came without: the text below numbers only
          what is written, so say which are missing, on paper too. */}
      {notInOriginal.length > 0 && (
        <p className="rounded-md border border-line px-3 py-2 text-sm text-muted">
          {fill(t.imported.notInOriginal, {
            // Each name quoted, so that one does not run into the next.
            sections: new Intl.ListFormat(lang, { type: "unit" }).format(
              notInOriginal.map((x) => {
                const section = version.sections.find((y) => y.key === x.key);
                return fill(t.imported.quoted, {
                  name: section ? inLang(section.name) : x.key,
                });
              }),
            ),
          })}
        </p>
      )}
      {notInMine && hasLocale(lang) && (
        <p
          className={`rounded-md bg-surface px-3 py-2 text-sm text-muted print:border print:border-line ${
            version.languages.includes(lang) ? "print:hidden" : ""
          }`}
        >
          {version.languages.includes(lang)
            ? fill(d.shownIn, { language: languageName(textLang) })
            : fill(d.notInYourLanguage, {
                mine: languageName(lang),
                language: languageName(textLang),
              })}
        </p>
      )}

      {lagging > 0 && (
        <p
          role="note"
          className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm text-warn"
        >
          {fill(d.laggingSummary, {
            count: numberFormat(lang).format(lagging),
            language: languageName(textLang),
            authoritative: languageName(authoritative),
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
          {sections.map(({ section, locale }, i) => (
            <section key={section.key} className="flex flex-col gap-2">
              <h3 className="text-base font-semibold break-after-avoid">
                {/* The number and the name in the text's own language and
                    direction: "1. Purpose", «1. الغرض». */}
                {`${i + 1}. `}
                {pick(section.name, textLang, fallback)}
              </h3>
              {locale === textLang && stateOf(section.key) === "lagging" ? (
                <>
                  <p
                    lang={lang}
                    dir={direction(lang)}
                    className="rounded-md border border-warn bg-warn-soft px-3 py-1.5 text-xs text-warn"
                  >
                    {fill(d.sectionLagging, {
                      language: languageName(textLang),
                      authoritative: languageName(authoritative),
                    })}
                  </p>
                  <Markup text={version.content[textLang][section.key]} />
                  <AuthoritativeText
                    lang={lang}
                    t={t}
                    locale={authoritative}
                    name={languageName(authoritative)}
                    text={version.content[authoritative]?.[section.key] ?? ""}
                  />
                </>
              ) : locale === textLang ? (
                <Markup text={version.content[textLang][section.key]} />
              ) : (
                <>
                  <p
                    lang={lang}
                    dir={direction(lang)}
                    className="rounded-md border border-warn bg-warn-soft px-3 py-1.5 text-xs text-warn"
                  >
                    {fill(d.sectionInOther, {
                      language: languageName(textLang),
                      other: languageName(locale),
                    })}
                  </p>
                  <div lang={locale} dir={direction(locale)}>
                    <Markup text={version.content[locale][section.key]} />
                  </div>
                </>
              )}
            </section>
          ))}
        </div>
      )}
      {printed && notControlled}
      <PrintedPages
        lang={lang}
        t={t}
        document={document}
        version={version}
        title={pick(document.title, textLang, fallback)}
        mark={standing ? t.notInForce[standing] : null}
      />
    </article>
  );
}

/**
 * In place of Trustline's approvals, for a version imported as approved
 * before Trustline: what its original says of its approval, as the
 * importer entered it, and who imported it and signed that this is its
 * text. Said in so many words, on screen and on paper.
 */
function ApprovedBefore({
  lang,
  t,
  before,
  ownerId,
}: {
  lang: string;
  t: PoliciesText;
  before: NonNullable<DocumentVersion["control"]["approvedBeforeTrustline"]> | null;
  /** The document's owner now, against whom a past confirmation is told. */
  ownerId: string;
}) {
  const session = useSession();
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const m = t.imported;
  const confirmationLine = useConfirmationLine(lang, t);
  // Whether the importer noted differences: the signature says "except as
  // noted above" only then.
  const noted =
    !!before?.differences &&
    Object.values(before.differences).some((v) => v?.trim());
  const rows: [string, ReactNode][] = before
    ? [
        ...(before.numberAsGiven
          ? [[m.numberAsGiven, <bdi key="n" dir="ltr">{before.numberAsGiven}</bdi>] as [string, ReactNode]]
          : []),
        ...(before.revisionLabel
          ? [[m.revisionLabel, <bdi key="r">{before.revisionLabel}</bdi>] as [string, ReactNode]]
          : []),
        [m.approvedOn, day(before.approvedOn) ?? ""],
        [m.approvedBy, <bdi key="b" dir="auto">{before.approvedBy}</bdi>],
        ...(before.lastReviewedOn
          ? [[m.lastReviewedOn, day(before.lastReviewedOn) ?? ""] as [string, ReactNode]]
          : []),
        // The owner's confirmation, on screen and on paper.
        ...(before.ownerConfirmation
          ? [[t.confirmation.label, confirmationLine(before.ownerConfirmation, ownerId)] as [string, ReactNode]]
          : []),
        [
          m.originalKeptAt,
          <bdi key="k">{pick(before.originalKeptAt, lang, session.tenant.defaultLocale)}</bdi>,
        ],
      ]
    : [];
  return (
    <div className="border-t border-line px-4 py-3">
      <p className="text-sm font-medium">{m.title}</p>
      <p className="mt-1 text-xs text-muted">{m.notThroughRoute}</p>
      {rows.length > 0 && (
        <dl className="mt-2 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-wrap gap-x-2">
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {/* What the text here does not reproduce of the original: part of
          what the importer signed, so on screen and on paper. */}
      {noted && before?.differences && (
          <div className="mt-2 text-sm">
            <p className="text-muted">{m.differences}</p>
            <p dir="auto" className="font-medium whitespace-pre-wrap break-words">
              {pick(before.differences, lang, session.tenant.defaultLocale)}
            </p>
          </div>
        )}
      {before && (
        <p className="mt-2 text-sm">
          <Words
            text={noted ? m.importedByNoted : m.importedBy}
            values={{
              name: pick(before.importedBy.name, lang, session.tenant.defaultLocale) ||
                t.document.unknownPerson,
              date: (
                <span className="whitespace-nowrap">
                  {moment.format(new Date(before.importedAt))}
                </span>
              ),
            }}
          />
        </p>
      )}
    </div>
  );
}

/**
 * The authoritative text of a section whose translation lags: a click away
 * on screen, printed in full, so a paper copy carries the text that
 * applies.
 */
function AuthoritativeText({
  lang,
  t,
  locale,
  name,
  text,
}: {
  lang: string;
  t: PoliciesText;
  locale: string;
  name: string;
  text: string;
}) {
  if (!text.trim()) return null;
  const body = (
    <div lang={locale} dir={direction(locale)} className="mt-2">
      <Markup text={text} />
    </div>
  );
  return (
    <>
      <details
        lang={lang}
        dir={direction(lang)}
        className="rounded-md border border-line px-3 py-2 print:hidden"
      >
        <summary className="cursor-pointer text-sm text-accent">
          {fill(t.document.showAuthoritative, { language: name })}
        </summary>
        {body}
      </details>
      <div className="hidden rounded-md border border-line px-3 py-2 print:block">
        <p lang={lang} dir={direction(lang)} className="text-xs font-medium">
          {fill(t.document.authoritativeText, { language: name })}
        </p>
        {body}
      </div>
    </>
  );
}

/** A sentence for a CSS `content`: quoted, and safe inside a style sheet. */
const cssString = (text: string) =>
  `"${text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\A ")
    .replace(/</g, "\\3C ")}"`;

/** "Page {page} of {pages}" as a CSS `content`, with the page counters. */
const pageCounter = (text: string) =>
  text
    .split(/(\{pages?\})/)
    .filter(Boolean)
    .map((part) =>
      part === "{page}"
        ? "counter(page)"
        : part === "{pages}"
          ? "counter(pages)"
          : cssString(part),
    )
    .join(" ");

const LONGEST_TITLE = 140;

/**
 * What every printed page carries, in the page's margins: the number,
 * version and title at the head, with a QR code to the document's page
 * (which always shows the version in force); at the foot, the day it was
 * printed, valid that day only, and "page x of y". A version not in force
 * is printed across every page with what it is ("Retired, not in force").
 *
 * The margins are `@page` margin boxes, which Chromium-based browsers draw;
 * the rules are added while the document is on screen and taken away with
 * it, so no other page prints with them. The day is read again just
 * before printing.
 */
function PrintedPages({
  lang,
  t,
  document,
  version,
  title,
  mark,
}: {
  lang: string;
  t: PoliciesText;
  document: PolicyDocument;
  version: DocumentVersion;
  title: string;
  mark: string | null;
}) {
  const session = useSession();
  const qr = useRef<HTMLDivElement>(null);
  const d = t.document;
  const timeZone = session.tenant.timeZone;
  const rtl = direction(lang) === "rtl";
  const start = rtl ? "right" : "left";
  const end = rtl ? "left" : "right";
  const shortTitle =
    title.length > LONGEST_TITLE ? `${title.slice(0, LONGEST_TITLE)}…` : title;
  // An imported version carries the original's revision beside its own.
  const originalRevision = version.control.originalRevision;
  const head = fill(originalRevision ? d.printHeaderOriginal : d.printHeader, {
    number: document.number,
    version: numberFormat(lang).format(version.version),
    revision: originalRevision ?? "",
    title: shortTitle,
  });
  const link =
    typeof window === "undefined"
      ? ""
      : `${window.location.origin}/policies/${document.id}`;

  useEffect(() => {
    const sheet = window.document.createElement("style");
    const svg = qr.current?.querySelector("svg");
    const image = svg
      ? `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
          new XMLSerializer().serializeToString(svg),
        )}")`
      : "none";
    const box = `font-family: ui-sans-serif, system-ui, "Segoe UI", "Noto Sans Arabic", Tahoma, sans-serif; font-size: 8pt; line-height: 1.35; color: #000; direction: ${rtl ? "rtl" : "ltr"};`;
    const write = () => {
      const today = dateTimeFormat(lang, timeZone, {
        dateStyle: "medium",
      }).format(new Date());
      sheet.textContent = `@media print {
@page {
  margin: 26mm 14mm 20mm;
  @top-${start} { content: ${cssString(head)}; ${box} text-align: start; vertical-align: middle; }
  @top-${end} { content: ${image}; vertical-align: middle; text-align: ${end}; width: 22mm; }
  @bottom-${start} { content: ${cssString(fill(d.printedOn, { date: today }))}; ${box} text-align: start; vertical-align: top; }
  @bottom-${end} { content: ${pageCounter(d.pageOf)}; ${box} text-align: ${end}; vertical-align: top; white-space: nowrap; }
}
}`;
    };
    write();
    window.document.head.append(sheet);
    window.addEventListener("beforeprint", write);
    return () => {
      window.removeEventListener("beforeprint", write);
      sheet.remove();
    };
  }, [lang, timeZone, rtl, start, end, head, link, d.printedOn, d.pageOf]);

  return (
    <>
      {/* Drawn once, out of sight, to be copied into the page margins. Black
          on white whatever the screen is set to: a camera needs the
          contrast. */}
      <div ref={qr} hidden>
        {link && <QRCodeSVG value={link} size={80} marginSize={1} level="M" />}
      </div>
      {mark && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-50 hidden items-center justify-center print:flex"
        >
          <p className="-rotate-30 rounded-lg border-8 border-danger/30 px-8 py-4 text-center text-5xl font-bold text-danger/30">
            {mark}
          </p>
        </div>
      )}
    </>
  );
}
