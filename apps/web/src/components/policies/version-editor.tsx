"use client";

import {
  Bold,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  Pilcrow,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useSession } from "@/components/shell/session";
import {
  ReadOnlyFieldset,
  useReadOnly,
} from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { direction, hasLocale, localeNames } from "@/i18n/config";
import { api, codeOf, detailsOf, statusOf } from "@/lib/api";
import { fill, languageNameIn, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { styleLines, toggleBold, type LineStyle } from "@/lib/markup";
import {
  contentChunks,
  documentPath,
  SECTION_MAX,
  VERSION_MAX,
  versionPath,
  type Content,
  type DocumentVersion,
  type PolicyDocument,
} from "@/lib/policies";
import { Markup } from "./markup";
import { textareaClass, type PoliciesProps } from "./types";
import { useExplain } from "./use-explain";

type Loaded = { doc: PolicyDocument; version: DocumentVersion };

/** On a button or a field for one language: the language's own name. */
const languageName = (locale: string) =>
  hasLocale(locale) ? localeNames[locale] : locale;

/** The editor for a draft version. Shows only while the API says `edit`. */
export function VersionEditor({ lang, t }: PoliciesProps) {
  const { id, versionId } = useParams<{ id: string; versionId: string }>();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    Promise.all([
      api<PolicyDocument>(`/policies/documents/${id}`),
      api<DocumentVersion>(`/policies/documents/${id}/versions/${versionId}`),
    ])
      .then(([doc, version]) => {
        if (!current) return;
        setLoaded({ doc, version });
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 404 ? t.notFound : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [id, versionId, t]);

  const shown = loaded?.version.id === versionId ? loaded : null;
  if (problem || !shown) {
    return <EmptyState>{problem ?? t.loading}</EmptyState>;
  }
  if (!shown.version.moves.includes("edit")) {
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center">
        <p className="text-sm">{t.editor.notEditable}</p>
        <Link
          href={versionPath(lang, id, versionId)}
          className="text-sm text-accent hover:underline"
        >
          {t.document.openVersion}
        </Link>
      </div>
    );
  }
  return (
    <Editor
      key={shown.version.id}
      lang={lang}
      t={t}
      doc={shown.doc}
      start={shown.version}
    />
  );
}

const keyOf = (locale: string, key: string) => `${locale}:${key}`;

function Editor({
  lang,
  t,
  doc,
  start,
}: PoliciesProps & { doc: PolicyDocument; start: DocumentVersion }) {
  const session = useSession();
  const router = useRouter();
  const readOnly = useReadOnly();
  const { defaultLocale } = session.tenant;
  const locales = [
    defaultLocale,
    ...session.tenant.locales.filter((l) => l !== defaultLocale),
  ];
  const explainError = useExplain(t, lang, start.sections);
  const e = t.editor;
  const numbers = numberFormat(lang);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, defaultLocale);

  // What is stored, and what is typed here.
  const [saved, setSaved] = useState<DocumentVersion>(start);
  const [drafts, setDrafts] = useState<Content>(start.content);
  const [summary, setSummary] = useState<Localized>(start.changeSummary ?? {});
  const [ackRequired, setAckRequired] = useState(start.acknowledgementRequired);
  const [ackDays, setAckDays] = useState(String(start.acknowledgeWithinDays));
  const [tab, setTab] = useState(locales.includes(lang) ? lang : defaultLocale);
  const [preview, setPreview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const areas = useRef(new Map<string, HTMLTextAreaElement>());

  useLayoutEffect(
    () => () => {
      setMessage(null);
      setProgress(null);
    },
    [],
  );

  const text = (locale: string, key: string) => drafts[locale]?.[key] ?? "";
  const stored = (locale: string, key: string) =>
    saved.content[locale]?.[key] ?? "";
  const changes = locales.flatMap((locale) =>
    saved.sections
      .filter((s) => text(locale, s.key) !== stored(locale, s.key))
      .map((s) => ({
        locale,
        key: s.key,
        text: text(locale, s.key).trim() === "" ? null : text(locale, s.key),
      })),
  );
  const summaryChanged = locales.some(
    (l) => (summary[l] ?? "") !== (saved.changeSummary?.[l] ?? ""),
  );
  const ackChanged =
    ackRequired !== saved.acknowledgementRequired ||
    Number(ackDays) !== saved.acknowledgeWithinDays;
  const dirty = changes.length > 0 || summaryChanged || ackChanged;
  const total = locales.reduce(
    (n, l) =>
      n + saved.sections.reduce((m, s) => m + text(l, s.key).length, 0),
    0,
  );

  // Leaving with unsaved text asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setText = (locale: string, key: string, value: string) => {
    setDrafts((was) => ({
      ...was,
      [locale]: { ...was[locale], [key]: value },
    }));
    setFieldErrors((was) => {
      if (!was[keyOf(locale, key)]) return was;
      const next = { ...was };
      delete next[keyOf(locale, key)];
      return next;
    });
  };

  /** The toolbar: restyles the lines or the words selected in one field. */
  const format = (locale: string, key: string, style: LineStyle | "bold") => {
    const area = areas.current.get(keyOf(locale, key));
    if (!area) return;
    const { selectionStart: from, selectionEnd: to, value } = area;
    const next =
      style === "bold"
        ? toggleBold(value, from, to)
        : styleLines(value, from, to, style);
    setText(locale, key, next.text);
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(next.from, next.to);
    });
  };

  /**
   * Saves what changed, a few sections at a time so no request is larger
   * than the API takes. Answers the revision saved, or null when refused.
   */
  async function save(): Promise<DocumentVersion | null> {
    const tooLong = changes.filter((c) => (c.text?.length ?? 0) > SECTION_MAX);
    if (tooLong.length > 0) {
      setFieldErrors(
        Object.fromEntries(
          tooLong.map((c) => [
            keyOf(c.locale, c.key),
            fill(e.tooLong, { max: numbers.format(SECTION_MAX) }),
          ]),
        ),
      );
      setTab(tooLong[0].locale);
      setMessage({ ok: false, text: e.notSaved });
      return null;
    }
    const days = Number(ackDays);
    if (ackRequired && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
      setMessage({ ok: false, text: e.daysInvalid });
      return null;
    }
    const meta: Record<string, unknown> = {};
    if (summaryChanged) {
      const kept = Object.fromEntries(
        locales
          .map((l) => [l, (summary[l] ?? "").trim()])
          .filter(([, v]) => v !== ""),
      );
      meta.changeSummary = Object.keys(kept).length > 0 ? kept : null;
    }
    if (ackChanged) {
      meta.acknowledgementRequired = ackRequired;
      if (ackRequired) meta.acknowledgeWithinDays = days;
    }
    const chunks = contentChunks(changes);
    const bodies: Record<string, unknown>[] = chunks.map((content, i) =>
      i === 0 ? { content, ...meta } : { content },
    );
    if (bodies.length === 0 && Object.keys(meta).length > 0) bodies.push(meta);
    let current = saved;
    const sent = new Set(changes.map((c) => keyOf(c.locale, c.key)));
    for (const [i, body] of bodies.entries()) {
      if (bodies.length > 1) {
        setProgress(
          fill(e.savingPart, {
            part: numbers.format(i + 1),
            parts: numbers.format(bodies.length),
          }),
        );
      }
      try {
        current = await api<DocumentVersion>(
          `/policies/documents/${doc.id}/versions/${current.id}`,
          {
            method: "PATCH",
            body: { ...body, revision: current.revision },
          },
        );
        setSaved(current);
      } catch (err) {
        setProgress(null);
        const code = codeOf(err);
        const details = detailsOf(err);
        if (
          code === "unsupported_markup" ||
          code === "section_too_long" ||
          code === "unknown_section"
        ) {
          const locale = String(details.locale ?? tab);
          const section = String(details.section ?? "");
          setFieldErrors({
            [keyOf(locale, section)]:
              code === "section_too_long"
                ? fill(e.tooLong, { max: numbers.format(SECTION_MAX) })
                : explainError(err),
          });
          if (locales.includes(locale)) setTab(locale);
        }
        if (code === "stale_version" || code === "not_draft") {
          // Someone else saved or moved it on: what is stored is read
          // again; what was typed here stays, to be saved over it.
          await api<DocumentVersion>(
            `/policies/documents/${doc.id}/versions/${current.id}`,
          )
            .then(setSaved)
            .catch(() => {});
        }
        setMessage({
          ok: false,
          text:
            i > 0
              ? `${fill(e.partlySaved, {
                  part: numbers.format(i),
                  parts: numbers.format(bodies.length),
                })} ${explainError(err)}`
              : explainError(err),
        });
        return null;
      }
    }
    setProgress(null);
    // What the API keeps is trimmed: the fields take what it kept, so
    // they no longer count as changed.
    setDrafts((was) => {
      const next: Content = { ...was };
      for (const locale of locales) {
        for (const s of current.sections) {
          if (sent.has(keyOf(locale, s.key))) {
            next[locale] = {
              ...next[locale],
              [s.key]: current.content[locale]?.[s.key] ?? "",
            };
          }
        }
      }
      return next;
    });
    if (summaryChanged) setSummary(current.changeSummary ?? {});
    return current;
  }

  async function saveDraft() {
    setBusy(true);
    setMessage(null);
    const done = await save();
    if (done) setMessage({ ok: true, text: e.saved });
    setBusy(false);
  }

  async function sendForReview() {
    setBusy(true);
    setMessage(null);
    setSummaryError(null);
    const done = await save();
    if (!done) return setBusy(false);
    try {
      await api(`/policies/documents/${doc.id}/versions/${done.id}/submit`, {
        method: "POST",
        body: { revision: done.revision },
      });
      router.push(versionPath(lang, doc.id, done.id));
      return;
    } catch (err) {
      const code = codeOf(err);
      const details = detailsOf(err);
      if (code === "missing_sections" && Array.isArray(details.sections)) {
        const locale = String(details.locale ?? defaultLocale);
        setFieldErrors(
          Object.fromEntries(
            (details.sections as string[]).map((key) => [
              keyOf(locale, key),
              e.requiredMissing,
            ]),
          ),
        );
        if (locales.includes(locale)) setTab(locale);
      }
      if (code === "change_summary_required") {
        setSummaryError(t.errors.change_summary_required);
      }
      setMessage({ ok: false, text: explainError(err) });
    }
    setBusy(false);
  }

  const missingHere = (locale: string) =>
    locale === defaultLocale
      ? saved.sections.filter((s) => s.required && !text(locale, s.key).trim())
          .length
      : 0;

  const tools: { style: LineStyle | "bold"; icon: ReactNode; label: string }[] =
    [
      { style: "paragraph", icon: <Pilcrow className="size-4" />, label: e.tools.paragraph },
      { style: 1, icon: <Heading1 className="size-4" />, label: e.tools.heading1 },
      { style: 2, icon: <Heading2 className="size-4" />, label: e.tools.heading2 },
      { style: 3, icon: <Heading3 className="size-4" />, label: e.tools.heading3 },
      { style: "bulleted", icon: <List className="size-4 rtl:-scale-x-100" />, label: e.tools.bulleted },
      { style: "numbered", icon: <ListOrdered className="size-4 rtl:-scale-x-100" />, label: e.tools.numbered },
      { style: "bold", icon: <Bold className="size-4" />, label: e.tools.bold },
    ];

  return (
    <>
      <PageHeader
        title={fill(e.title, { version: numbers.format(saved.version) })}
        description={
          <>
            <bdi dir="ltr" className="whitespace-nowrap">
              {doc.number}
            </bdi>{" "}
            <span className="inline-block">
              {"· "}
              <bdi>{inLang(doc.title)}</bdi>
            </span>
          </>
        }
      />

      {saved.returned.length > 0 && (
        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm">
          <p className="font-medium">{t.review.returnedTitle}</p>
          {saved.returned.map((item) => (
            <p key={item.position} dir="auto" className="whitespace-pre-line">
              {item.comment}
            </p>
          ))}
        </div>
      )}

      <p className="mt-4 max-w-3xl text-sm text-muted">
        {fill(e.intro, { language: languageNameIn(lang)(defaultLocale) })}
      </p>

      <ReadOnlyFieldset>
        <div className="mt-4 flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div
              role="group"
              aria-label={e.languages}
              className="flex flex-wrap gap-2"
            >
              {locales.map((locale) => {
                const missing = missingHere(locale);
                return (
                  <button
                    key={locale}
                    type="button"
                    lang={locale}
                    aria-pressed={tab === locale}
                    onClick={() => setTab(locale)}
                    className={`inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm whitespace-nowrap ${
                      tab === locale
                        ? "border-accent bg-accent-soft font-medium text-accent"
                        : "border-line text-muted hover:bg-surface hover:text-foreground"
                    }`}
                  >
                    {languageName(locale)}
                    {missing > 0 && (
                      <span lang={lang} className="text-xs text-warn">
                        {fill(e.missingCount, {
                          count: numbers.format(missing),
                        })}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <label className="flex min-h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-accent"
                checked={preview}
                onChange={(ev) => setPreview(ev.target.checked)}
              />
              {e.showPreview}
            </label>
          </div>
          <p className="-mt-3 text-xs text-muted">
            {tab === defaultLocale ? e.defaultLanguageHelp : e.otherLanguageHelp}
          </p>

          <ol className="flex flex-col gap-6">
            {saved.sections.map((section, i) => {
              const value = text(tab, section.key);
              const error = fieldErrors[keyOf(tab, section.key)];
              const sectionName = pick(section.name, tab, defaultLocale);
              const required = section.required && tab === defaultLocale;
              return (
                <li
                  key={`${tab}:${section.key}`}
                  className={`rounded-lg border ${error ? "border-danger" : "border-line"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
                    <h2
                      lang={tab}
                      dir={direction(tab)}
                      className="text-sm font-semibold"
                    >
                      {`${i + 1}. ${sectionName}`}
                    </h2>
                    <div className="flex flex-wrap items-center gap-2">
                      {required ? (
                        <Pill tone="warn">{e.required}</Pill>
                      ) : (
                        <Pill tone="neutral">{e.optional}</Pill>
                      )}
                      <span
                        className={`text-xs tabular-nums ${value.length > SECTION_MAX ? "font-medium text-danger" : "text-muted"}`}
                      >
                        {fill(e.characters, {
                          count: numbers.format(value.length),
                          max: numbers.format(SECTION_MAX),
                        })}
                      </span>
                    </div>
                  </div>
                  <div
                    role="toolbar"
                    aria-label={fill(e.toolbar, { section: sectionName })}
                    className="flex flex-wrap gap-1 border-b border-line px-2 py-1"
                  >
                    {tools.map((tool) => (
                      <button
                        key={String(tool.style)}
                        type="button"
                        aria-label={tool.label}
                        title={tool.label}
                        onMouseDown={(ev) => ev.preventDefault()}
                        onClick={() => format(tab, section.key, tool.style)}
                        className="inline-flex size-9 items-center justify-center rounded-md text-muted hover:bg-surface hover:text-foreground"
                      >
                        <span aria-hidden>{tool.icon}</span>
                      </button>
                    ))}
                  </div>
                  <div
                    className={`grid gap-0 ${preview ? "lg:grid-cols-2" : ""}`}
                  >
                    <textarea
                      ref={(el) => {
                        if (el) areas.current.set(keyOf(tab, section.key), el);
                        else areas.current.delete(keyOf(tab, section.key));
                      }}
                      aria-label={`${sectionName} · ${languageName(tab)}`}
                      aria-invalid={!!error}
                      value={value}
                      onChange={(ev) => setText(tab, section.key, ev.target.value)}
                      rows={8}
                      lang={tab}
                      dir={direction(tab)}
                      className="min-h-40 w-full resize-y border-0 bg-background px-4 py-3 text-sm leading-relaxed"
                    />
                    {preview && (
                      <div
                        lang={tab}
                        dir={direction(tab)}
                        aria-label={e.preview}
                        className="min-w-0 border-t border-line bg-surface px-4 py-3 lg:border-s lg:border-t-0"
                      >
                        <p lang={lang} dir={direction(lang)} className="mb-2 text-xs text-muted">
                          {e.preview}
                        </p>
                        {value.trim() ? (
                          <Markup text={value} />
                        ) : (
                          <p lang={lang} dir={direction(lang)} className="text-sm text-muted">
                            {e.emptyPreview}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                  {error && (
                    <p role="alert" className="border-t border-line px-4 py-2 text-sm text-danger">
                      {error}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>

          <p className={`text-xs tabular-nums ${total > VERSION_MAX ? "font-medium text-danger" : "text-muted"}`}>
            {fill(e.totalCharacters, {
              count: numbers.format(total),
              max: numbers.format(VERSION_MAX),
            })}
          </p>

          <Panel title={e.aboutVersion}>
            <div className="flex flex-col gap-5 p-4">
              <fieldset className="flex flex-col gap-3">
                <legend className="mb-1 text-sm font-medium">
                  {saved.version >= 2 ? e.changeSummaryRequired : e.changeSummary}
                </legend>
                <p className="text-xs text-muted">{e.changeSummaryHelp}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  {locales.map((locale) => (
                    <Field key={locale} label={languageName(locale)}>
                      <textarea
                        value={summary[locale] ?? ""}
                        onChange={(ev) => {
                          setSummary((was) => ({ ...was, [locale]: ev.target.value }));
                          setSummaryError(null);
                        }}
                        rows={3}
                        maxLength={1000}
                        lang={locale}
                        dir={direction(locale)}
                        className={textareaClass}
                      />
                    </Field>
                  ))}
                </div>
                {summaryError && (
                  <p role="alert" className="text-sm text-danger">
                    {summaryError}
                  </p>
                )}
              </fieldset>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={ackRequired}
                  onChange={(ev) => setAckRequired(ev.target.checked)}
                  className="mt-0.5 size-4 accent-accent"
                />
                <span>
                  <span className="font-medium">{e.ackRequired}</span>
                  <span className="block text-xs text-muted">{e.ackRequiredHelp}</span>
                </span>
              </label>
              {ackRequired && (
                <div className="max-w-56">
                  <Field label={e.ackDays}>
                    <input
                      type="number"
                      min={1}
                      max={365}
                      inputMode="numeric"
                      dir="ltr"
                      value={ackDays}
                      onChange={(ev) => setAckDays(ev.target.value)}
                      className={inputClass}
                    />
                  </Field>
                </div>
              )}
            </div>
          </Panel>

          <div className="sticky bottom-0 z-10 -mx-4 flex flex-col gap-2 border-t border-line bg-background px-4 py-3 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
            {(progress || message) && (
              <p
                role={message && !message.ok ? "alert" : "status"}
                className={`text-sm ${message && !message.ok ? "text-danger" : "text-accent"}`}
              >
                {progress ?? message?.text}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={busy || readOnly} onClick={sendForReview}>
                {e.sendForReview}
              </Button>
              <Button
                variant="secondary"
                disabled={busy || readOnly || !dirty}
                onClick={saveDraft}
              >
                {e.save}
              </Button>
              <span className="text-xs text-muted">
                {dirty ? e.unsaved : e.allSaved}
              </span>
              <Link
                href={documentPath(lang, doc.id)}
                className="ms-auto text-sm text-accent hover:underline"
              >
                {t.review.backToDocument}
              </Link>
            </div>
          </div>
        </div>
      </ReadOnlyFieldset>
    </>
  );
}
