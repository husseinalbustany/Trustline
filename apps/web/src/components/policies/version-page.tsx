"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
} from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { direction } from "@/i18n/config";
import { api, statusOf } from "@/lib/api";
import {
  dateTimeFormat,
  dayFormat,
  durationFormat,
  fill,
  languageListIn,
  languageNameIn,
  numberFormat,
} from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import {
  authoritativeOf,
  documentPath,
  shownLanguage,
  todayIn,
  versionPath,
  type DocumentVersion,
  type Named,
  type PolicyDocument,
  type RunStep,
  type SectionComparison,
} from "@/lib/policies";
import { ControlledDocument, LanguageSwitch } from "./controlled-document";
import { Markup } from "./markup";
import { PasswordPrompt } from "./password-prompt";
import { VersionStatusPill } from "./pills";
import { RefusalNote } from "./refusal-note";
import { isStale, textareaClass, type PoliciesProps } from "./types";
import { Sentence } from "./sentence";
import { useExplain } from "./use-explain";
import { useSubmitRefusal, type SubmitRefusal } from "./use-submit-refusal";

type Loaded = { doc: PolicyDocument; version: DocumentVersion };

const load = async (id: string, versionId: string): Promise<Loaded> => {
  const [doc, version] = await Promise.all([
    api<PolicyDocument>(`/policies/documents/${id}`),
    api<DocumentVersion>(`/policies/documents/${id}/versions/${versionId}`),
  ]);
  return { doc, version };
};

/**
 * One version: read as a document, or, while it is being prepared or
 * reviewed, with what changed since the published version marked section
 * by section; with the approval steps and what the API lets this person
 * do now (send for review, decide a step, publish, take it back).
 */
export function VersionPage({ lang, t }: PoliciesProps) {
  const { id, versionId } = useParams<{ id: string; versionId: string }>();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // A decision taken here, said even when the version is then out of sight.
  const [decided, setDecided] = useState<string | null>(null);
  useLayoutEffect(() => () => setDecided(null), []);

  useEffect(() => {
    let current = true;
    load(id, versionId)
      .then((next) => {
        if (!current) return;
        setLoaded(next);
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

  const refresh = useCallback(
    () =>
      load(id, versionId)
        .then((next) => {
          setLoaded(next);
          setProblem(null);
        })
        .catch((err) =>
          setProblem(statusOf(err) === 404 ? t.notFound : t.loadError),
        ),
    [id, versionId, t],
  );

  const shown = loaded?.version.id === versionId ? loaded : null;
  if (decided && (problem || !shown)) {
    // The step was the last this person could see: the run has ended.
    return (
      <div className="mx-auto flex max-w-xl flex-col items-center gap-3 py-16 text-center">
        <p role="status" className="text-base font-medium">
          {decided}
        </p>
        <p className="text-sm text-muted">{t.review.outOfSight}</p>
        <Link
          href={`/${lang}/policies/awaiting`}
          className="text-sm text-accent hover:underline"
        >
          {t.awaiting.title}
        </Link>
      </div>
    );
  }
  if (problem || !shown) {
    return (
      <>
        <EmptyState>{problem ?? t.loading}</EmptyState>
        {problem && (
          <p className="text-center text-sm">
            <Link href={`/${lang}/policies`} className="text-accent hover:underline">
              {t.back}
            </Link>
          </p>
        )}
      </>
    );
  }
  return (
    <VersionView
      key={shown.version.id}
      lang={lang}
      t={t}
      loaded={shown}
      refresh={refresh}
      onDecided={setDecided}
      decided={decided}
    />
  );
}

function VersionView({
  lang,
  t,
  loaded,
  refresh,
  onDecided,
  decided,
}: PoliciesProps & {
  loaded: Loaded;
  refresh: () => Promise<void>;
  onDecided: (said: string) => void;
  decided: string | null;
}) {
  const session = useSession();
  const { doc, version } = loaded;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const name = (person: Named | null | undefined) =>
    (person && inLang(person.name)) || t.document.unknownPerson;
  const numbers = numberFormat(lang);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const day = dayFormat(lang);
  const r = t.review;
  const [asked, setAsked] = useState<string | null>(null);
  const inProgress = ["draft", "in_review", "approved"].includes(
    version.status,
  );
  const comparable = !!version.comparison && !!doc.published && inProgress;
  const sinceReturned = inProgress ? version.sinceReturned : null;
  // A reviewer looks first at what changed since they returned it.
  const [mode, setMode] = useState<"changes" | "returned" | "document">(
    sinceReturned ? "returned" : comparable ? "changes" : "document",
  );
  const languages =
    comparable || sinceReturned
      ? [
          ...new Set([
            ...version.languages,
            ...(comparable ? (version.comparison ?? []) : []).flatMap((s) =>
              Object.keys(s.locales),
            ),
            ...(sinceReturned?.comparison ?? []).flatMap((s) =>
              Object.keys(s.locales),
            ),
          ]),
        ]
      : version.languages;
  const status = version.languageStatus;
  const languageName = languageNameIn(lang);
  // Languages left behind where the authoritative text changed, said
  // before anyone signs.
  const behind = inProgress && status?.lagging
    ? Object.entries(status.byLocale).filter(([, n]) => n.lagging > 0)
    : [];
  const shownIn = shownLanguage(languages, asked, lang);

  const chip = (on: boolean) =>
    `inline-flex h-9 items-center rounded-full border px-3 text-sm whitespace-nowrap ${
      on
        ? "border-accent bg-accent-soft font-medium text-accent"
        : "border-line text-muted hover:bg-surface hover:text-foreground"
    }`;

  return (
    <>
      <PageHeader
        title={
          <>
            <bdi>{inLang(doc.title)}</bdi>
          </>
        }
        description={
          <>
            <bdi dir="ltr" className="whitespace-nowrap">
              {doc.number}
            </bdi>{" "}
            <span className="inline-block">
              {"· "}
              {fill(t.versionNumber, { version: numbers.format(version.version) })}
            </span>
          </>
        }
        actions={<VersionStatusPill t={t} status={version.status} />}
      />

      {decided && (
        <p role="status" className="mt-4 rounded-md bg-accent-soft px-3 py-2 text-sm">
          {decided}
        </p>
      )}

      {version.returned.length > 0 && (
        <div className="mt-4 flex flex-col gap-2 rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm">
          <p className="font-medium">{r.returnedTitle}</p>
          {version.returned.map((item) => (
            <div key={item.position}>
              <p className="text-xs">
                {fill(r.returnedBy, {
                  name: name(item.by),
                  date: item.at ? moments.format(new Date(item.at)) : "",
                })}
              </p>
              {item.comment && (
                <p dir="auto" className="mt-0.5 whitespace-pre-line">
                  {item.comment}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {version.scheduledFor && (
        <p className="mt-4 rounded-md bg-accent-soft px-3 py-2 text-sm">
          {fill(r.scheduled, {
            date: day(version.scheduledFor) ?? "",
            name: name(version.scheduledBy),
          })}
        </p>
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          {version.changeSummary && (
            <Panel title={r.changeSummary}>
              <p dir="auto" className="px-4 py-3 text-sm whitespace-pre-line">
                {inLang(version.changeSummary)}
              </p>
            </Panel>
          )}
          <div className="flex flex-wrap items-center gap-3">
            {(comparable || sinceReturned) && (
              <div role="group" aria-label={r.viewLabel} className="flex flex-wrap gap-2">
                {sinceReturned && (
                  <button
                    type="button"
                    aria-pressed={mode === "returned"}
                    onClick={() => setMode("returned")}
                    className={chip(mode === "returned")}
                  >
                    {r.sinceReturned}
                  </button>
                )}
                {comparable && (
                  <button
                    type="button"
                    aria-pressed={mode === "changes"}
                    onClick={() => setMode("changes")}
                    className={chip(mode === "changes")}
                  >
                    {r.showChanges}
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={mode === "document"}
                  onClick={() => setMode("document")}
                  className={chip(mode === "document")}
                >
                  {r.showDocument}
                </button>
              </div>
            )}
            <LanguageSwitch
              t={t}
              languages={languages}
              shown={shownIn ?? ""}
              onChange={setAsked}
            />
          </div>
          {!doc.published && ["draft", "in_review", "approved"].includes(version.status) && (
            <p className="text-sm text-muted">{r.firstVersion}</p>
          )}
          {behind.length > 0 && (
            <div
              role="note"
              className="flex flex-col gap-1 rounded-lg border border-warn bg-warn-soft px-4 py-3 text-sm"
            >
              <p className="font-medium">{r.notUpdatedTitle}</p>
              <ul className="list-disc ps-5">
                {behind.map(([locale, n]) => (
                  <li key={locale}>
                    {fill(r.notUpdatedLine, {
                      language: languageName(locale),
                      count: numbers.format(n.lagging),
                    })}
                  </li>
                ))}
              </ul>
              <p className="text-muted">
                {fill(r.notUpdatedHelp, {
                  authoritative: languageName(authoritativeOf(version, session.tenant.defaultLocale)),
                })}
              </p>
            </div>
          )}
          {sinceReturned && mode === "returned" ? (
            <>
              <p className="text-sm text-muted">
                {fill(r.sinceReturnedHelp, {
                  date: sinceReturned.returnedAt
                    ? moments.format(new Date(sinceReturned.returnedAt))
                    : "",
                })}{" "}
                {sinceReturned.changeSummaryChanged
                  ? r.summaryChanged
                  : r.summaryUnchanged}
              </p>
              <Comparison
                lang={lang}
                t={t}
                version={version}
                sections={sinceReturned.comparison}
                shown={shownIn}
                lagging={false}
              />
            </>
          ) : comparable && mode === "changes" ? (
            <Comparison
              lang={lang}
              t={t}
              version={version}
              sections={version.comparison ?? []}
              shown={shownIn}
              lagging
            />
          ) : (
            <ControlledDocument
              lang={lang}
              t={t}
              document={doc}
              version={version}
              shown={version.languages.includes(shownIn ?? "") ? shownIn : version.languages[0] ?? null}
            />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-6">
          <VersionActions
            lang={lang}
            t={t}
            doc={doc}
            version={version}
            refresh={refresh}
            onDecided={onDecided}
          />
          {version.run && <RunPanel lang={lang} t={t} steps={version.run.steps} current={version.run.status === "in_progress" ? version.run.currentPosition : null} />}
          {version.rounds.length > 1 && (
            <EarlierRounds lang={lang} t={t} rounds={version.rounds} />
          )}
          <Panel title={r.facts}>
            <dl className="flex flex-col gap-3 px-4 py-3 text-sm">
              {version.imported ? (
                <>
                  <div>
                    <dt className="text-xs text-muted">{t.imported.importedByLabel}</dt>
                    <dd>
                      <bdi>{name(version.imported.importedBy)}</bdi>
                      <span className="text-muted">
                        {" · "}
                        {moments.format(new Date(version.imported.importedAt))}
                      </span>
                    </dd>
                  </div>
                  {version.imported.sectionsNotWritten.length > 0 && (
                    <div>
                      <dt className="text-xs text-muted">{t.imported.notWrittenLabel}</dt>
                      <dd>
                        {new Intl.ListFormat(lang, { type: "conjunction" }).format(
                          version.imported.sectionsNotWritten.map((x) => {
                            const section = version.sections.find((y) => y.key === x.key);
                            return section ? inLang(section.name) : x.key;
                          }),
                        )}
                      </dd>
                    </div>
                  )}
                </>
              ) : (
                <div>
                  <dt className="text-xs text-muted">{r.preparedBy}</dt>
                  <dd>
                    <bdi>{name(version.preparedBy)}</bdi>
                    {version.preparedAt && (
                      <span className="text-muted">
                        {" · "}
                        {moments.format(new Date(version.preparedAt))}
                      </span>
                    )}
                  </dd>
                </div>
              )}
              <div>
                <dt className="text-xs text-muted">{r.acknowledgement}</dt>
                <dd>
                  {version.acknowledgementRequired
                    ? fill(r.acknowledgementWithin, {
                        days: durationFormat(lang)(version.acknowledgeWithinDays, "day"),
                      })
                    : r.noAcknowledgement}
                </dd>
              </div>
              {doc.access === "full" && (
                <div>
                  <dt className="text-xs text-muted">{r.fingerprint}</dt>
                  <dd dir="ltr" className="font-mono text-xs break-all text-start">
                    {version.contentHash}
                  </dd>
                </div>
              )}
            </dl>
          </Panel>
        </div>
      </div>

      <p className="mt-6 text-sm">
        <Link href={documentPath(lang, doc.id)} className="text-accent hover:underline">
          {r.backToDocument}
        </Link>
      </p>
    </>
  );
}

/** Each section, in one language: unchanged, or its lines kept, added and removed. */
function Comparison({
  lang,
  t,
  version,
  sections,
  shown,
  lagging: withLagging,
}: PoliciesProps & {
  version: DocumentVersion;
  sections: SectionComparison[];
  shown: string | null;
  /** Mark the sections this language did not follow (against the published version). */
  lagging: boolean;
}) {
  const session = useSession();
  const r = t.review;
  const locale = shown ?? session.tenant.defaultLocale;
  const status = version.languageStatus;
  const languageName = languageNameIn(lang);
  const lags = (key: string) =>
    withLagging &&
    status?.sections.find((x) => x.key === key)?.locales[locale] === "lagging";
  const changed = sections.filter((s) => s.locales[locale]?.changed).length;
  const behind = sections.filter((s) => lags(s.key)).length;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        {changed === 0
          ? r.noChanges
          : fill(r.changedCount, {
              count: numberFormat(lang).format(changed),
              total: numberFormat(lang).format(sections.length),
            })}
      </p>
      {behind > 0 && status && (
        <p className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm text-warn">
          {fill(r.laggingCount, {
            count: numberFormat(lang).format(behind),
            authoritative: languageName(authoritativeOf(version, session.tenant.defaultLocale)),
          })}
        </p>
      )}
      <ol className="flex flex-col gap-4" lang={locale} dir={direction(locale)}>
        {sections.map((section, i) => {
          const here = section.locales[locale];
          const behindHere = lags(section.key);
          const title = `${i + 1}. ${pick(section.name, locale, session.tenant.defaultLocale)}`;
          return (
            <li
              key={section.key}
              className={`rounded-lg border ${here?.changed || behindHere ? "border-warn" : "border-line"}`}
            >
              <div
                dir={direction(lang)}
                lang={lang}
                className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2"
              >
                <h3 lang={locale} dir={direction(locale)} className="text-sm font-semibold">
                  {title}
                </h3>
                {here?.changed ? (
                  <Pill tone="warn">{r.changed}</Pill>
                ) : behindHere ? (
                  <Pill tone="warn">{r.lagging}</Pill>
                ) : (
                  <Pill tone="neutral">{here ? r.unchanged : r.empty}</Pill>
                )}
              </div>
              {behindHere && status && (
                <p
                  lang={lang}
                  dir={direction(lang)}
                  className="border-b border-line px-4 py-2 text-xs text-warn"
                >
                  {fill(r.laggingHere, {
                    language: languageName(locale),
                    authoritative: languageName(authoritativeOf(version, session.tenant.defaultLocale)),
                  })}
                </p>
              )}
              <div className="px-4 py-3">
                {!here ? (
                  <p className="text-sm text-muted">{r.emptyHere}</p>
                ) : here.changed ? (
                  <ul className="flex flex-col gap-0.5 text-sm">
                    {here.lines.map((line, j) => (
                      <li
                        key={j}
                        className={`flex gap-2 rounded px-2 py-0.5 whitespace-pre-wrap break-words ${
                          line.op === "added"
                            ? "bg-accent-soft"
                            : line.op === "removed"
                              ? "bg-danger-soft text-danger line-through"
                              : "text-muted"
                        }`}
                      >
                        <span aria-hidden className="w-3 shrink-0 font-mono no-underline">
                          {line.op === "added" ? "+" : line.op === "removed" ? "−" : ""}
                        </span>
                        <span className="sr-only">
                          {line.op === "added"
                            ? r.addedLine
                            : line.op === "removed"
                              ? r.removedLine
                              : ""}
                        </span>
                        <span className="min-w-0">{line.text || " "}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <details>
                    <summary className="cursor-pointer text-sm text-accent">
                      {r.showText}
                    </summary>
                    <div className="mt-2">
                      <Markup text={version.content[locale]?.[section.key] ?? ""} />
                    </div>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function RunPanel({
  lang,
  t,
  steps,
  current,
}: PoliciesProps & { steps: RunStep[]; current: number | null }) {
  return (
    <Panel title={t.review.steps}>
      <StepList lang={lang} t={t} steps={steps} current={current} />
    </Panel>
  );
}

/**
 * The rounds before the latest: each with its steps, who decided them and
 * what they wrote, so comments made on a round that was returned stay in
 * sight after the version is sent again.
 */
function EarlierRounds({
  lang,
  t,
  rounds,
}: PoliciesProps & { rounds: DocumentVersion["rounds"] }) {
  const session = useSession();
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const r = t.review;
  return (
    <Panel title={r.rounds}>
      <ol>
        {rounds.slice(1).map((round, i) => (
          <li key={round.id} className="border-b border-line last:border-b-0">
            <details>
              <summary className="cursor-pointer px-4 py-3 text-sm">
                <span className="font-medium">
                  {fill(r.roundTitle, {
                    number: numberFormat(lang).format(rounds.length - 1 - i),
                  })}
                </span>
                {" · "}
                {Object.hasOwn(r.roundStatus, round.status)
                  ? r.roundStatus[round.status as keyof typeof r.roundStatus]
                  : r.roundStatus.other}
                <span className="block text-xs text-muted">
                  {fill(r.roundStarted, {
                    date: moments.format(new Date(round.startedAt)),
                  })}
                </span>
              </summary>
              <StepList lang={lang} t={t} steps={round.steps} current={null} />
            </details>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

function StepList({
  lang,
  t,
  steps,
  current,
}: PoliciesProps & { steps: RunStep[]; current: number | null }) {
  const session = useSession();
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const moments = dateTimeFormat(lang, session.tenant.timeZone);
  const r = t.review;
  return (
    <ol className="flex flex-col">
        {steps.map((step) => (
          <li
            key={step.position}
            className={`border-b border-line px-4 py-3 text-sm last:border-b-0 ${
              step.position === current ? "border-s-4 border-s-accent ps-3" : ""
            }`}
          >
            <p className="flex flex-wrap items-center gap-2 font-medium">
              {fill(r.stepTitle, {
                position: String(step.position),
                kind: t.stepKind[step.kind],
              })}
              <Pill
                tone={
                  step.status === "approved"
                    ? "ok"
                    : step.status === "returned"
                      ? "warn"
                      : step.overdue
                        ? "danger"
                        : "neutral"
                }
              >
                {step.overdue && step.status === "pending"
                  ? r.stepOverdue
                  : Object.hasOwn(r.stepStatus, step.status)
                    ? r.stepStatus[step.status as keyof typeof r.stepStatus]
                    : step.status}
              </Pill>
            </p>
            <p className="mt-1 text-muted">
              <bdi>
                {step.assignee.type === "role"
                  ? fill(r.anyoneWithRole, { role: inLang(step.assignee.role.name) })
                  : inLang(step.assignee.user?.name) || t.document.unknownPerson}
              </bdi>
            </p>
            {step.dueAt && step.status === "pending" && (
              <p className={`mt-1 text-xs ${step.overdue ? "font-medium text-danger" : "text-muted"}`}>
                {fill(r.dueBy, { date: moments.format(new Date(step.dueAt)) })}
              </p>
            )}
            {step.decidedAt && (
              <p className="mt-1 text-xs text-muted">
                {fill(r.decidedBy, {
                  name: inLang(step.decidedBy?.name) || t.document.unknownPerson,
                  date: moments.format(new Date(step.decidedAt)),
                })}
              </p>
            )}
            {step.comment && (
              <p dir="auto" className="mt-1 whitespace-pre-line">
                {step.comment}
              </p>
            )}
          </li>
        ))}
    </ol>
  );
}

/** What the API lets this person do with the version now, and nothing else. */
function VersionActions({
  lang,
  t,
  doc,
  version,
  refresh,
  onDecided,
}: PoliciesProps & {
  doc: PolicyDocument;
  version: DocumentVersion;
  refresh: () => Promise<void>;
  onDecided: (said: string) => void;
}) {
  const session = useSession();
  const explainError = useExplain(t, lang, version.sections);
  const submitRefusal = useSubmitRefusal(t, lang, doc, version.sections);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<
    "approve" | "return" | "withdraw" | "recall" | null
  >(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [refused, setRefused] = useState<SubmitRefusal | null>(null);
  const [when, setWhen] = useState<"now" | "later">("now");
  const r = t.review;
  const x = t.actions;
  const moves = version.moves;
  const base = `/policies/documents/${doc.id}/versions/${version.id}`;
  const today = todayIn(session.tenant.timeZone);
  const numbers = numberFormat(lang);
  useLayoutEffect(
    () => () => {
      setOpen(null);
      setMessage(null);
      setRefused(null);
    },
    [],
  );

  async function act(path: string, body: Record<string, unknown>, said: string) {
    setBusy(true);
    setMessage(null);
    setRefused(null);
    try {
      await api(`${base}/${path}`, {
        method: "POST",
        body: { ...body, revision: version.revision },
      });
      setOpen(null);
      setMessage({ ok: true, text: said });
      await refresh();
      setBusy(false);
      return true;
    } catch (err) {
      if (path === "submit") setRefused(await submitRefusal(err));
      else setMessage({ ok: false, text: explainError(err) });
      if (isStale(err)) await refresh();
      setBusy(false);
      return false;
    }
  }

  async function publish(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const date = String(new FormData(form).get("effectiveOn") ?? "");
    const later = when === "later" && date && date !== today;
    if (
      await act(
        "publish",
        later ? { effectiveOn: date } : {},
        later ? x.scheduled : x.published,
      )
    ) {
      form.reset();
      setWhen("now");
    }
  }

  async function giveBack(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const comment = String(new FormData(form).get("comment") ?? "").trim();
    setBusy(true);
    setMessage(null);
    try {
      await api(`${base}/return`, {
        method: "POST",
        body: { comment, revision: version.revision },
      });
      form.reset();
      setOpen(null);
      onDecided(r.returnedDone);
      await refresh();
    } catch (err) {
      setMessage({ ok: false, text: explainError(err) });
      if (isStale(err)) await refresh();
    }
    setBusy(false);
  }

  async function withdraw(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const reason = String(new FormData(form).get("reason") ?? "").trim();
    if (await act("withdraw", { reason }, x.withdrawn)) form.reset();
  }

  const shown = moves.filter((m) => m !== "acknowledge");
  if (shown.length === 0 && !version.myStep) return null;

  return (
    <Panel title={x.title}>
      {/* The API offers only what stays open while the account is
          suspended (publish, retire, acknowledge): no fieldset turns it off. */}
      <>
        <div className="flex flex-col gap-4 p-4">
          {version.myStep && !moves.includes("approve") && version.myStep.samePerson && (
            <p className="text-sm text-muted">{r.samePerson}</p>
          )}

          {moves.includes("edit") && (
            <div>
              <ButtonLink href={`${versionPath(lang, doc.id, version.id)}/edit`}>
                {x.edit}
              </ButtonLink>
            </div>
          )}

          {moves.includes("submit") && (
            <div className="flex flex-col gap-1">
              <div>
                <Button
                  variant={moves.includes("edit") ? "secondary" : "primary"}
                  disabled={busy}
                  onClick={() => act("submit", {}, x.submitted)}
                >
                  {x.submit}
                </Button>
              </div>
              <p className="text-xs text-muted">{x.submitHelp}</p>
            </div>
          )}

          {moves.includes("approve") && version.myStep && (
            open === "approve" ? (
              <PasswordPrompt
                t={t}
                intro={
                  <Sentence
                    text={version.myStep.kind === "review" ? r.signReview : r.signApprove}
                    number={doc.number}
                    values={{
                      version: numbers.format(version.version),
                      // A signature covers every language the version is
                      // written in, so the prompt names them all.
                      languages: languageListIn(lang)(version.languages),
                    }}
                  />
                }
                confirm={version.myStep.kind === "review" ? r.confirmReviewed : r.confirmApproved}
                comment={{ label: r.approveComment }}
                explainError={explainError}
                onCancel={() => setOpen(null)}
                submit={async (password, comment) => {
                  try {
                    await api(`${base}/approve`, {
                      method: "POST",
                      body: {
                        password,
                        revision: version.revision,
                        ...(comment.trim() ? { comment: comment.trim() } : {}),
                      },
                    });
                  } catch (err) {
                    if (isStale(err)) void refresh();
                    throw err;
                  }
                  setOpen(null);
                  onDecided(version.myStep?.kind === "review" ? r.reviewedDone : r.approvedDone);
                  await refresh();
                }}
              />
            ) : (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">
                  {version.myStep.kind === "review" ? r.yourReview : r.yourApproval}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setOpen("approve")}>
                    {version.myStep.kind === "review" ? r.approveReview : r.approve}
                  </Button>
                  {moves.includes("return") && (
                    <Button variant="secondary" onClick={() => setOpen("return")}>
                      {r.return}
                    </Button>
                  )}
                </div>
              </div>
            )
          )}

          {moves.includes("return") && open === "return" && (
            <form onSubmit={giveBack} className="flex flex-col gap-3">
              <Field label={r.returnComment} help={r.returnHelp}>
                <textarea
                  name="comment"
                  required
                  rows={4}
                  maxLength={2000}
                  dir="auto"
                  className={textareaClass}
                />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy}>
                  {r.returnConfirm}
                </Button>
                <Button variant="secondary" onClick={() => setOpen(null)}>
                  {x.cancel}
                </Button>
              </div>
            </form>
          )}

          {moves.includes("publish") && (
            <form onSubmit={publish} className="flex flex-col gap-3">
              <fieldset className="flex flex-col gap-2 text-sm">
                <legend className="mb-1 font-medium">{x.publishWhen}</legend>
                <label className="flex min-h-9 items-center gap-2">
                  <input
                    type="radio"
                    name="when"
                    checked={when === "now"}
                    onChange={() => setWhen("now")}
                    className="accent-accent"
                  />
                  {x.publishNow}
                </label>
                <label className="flex min-h-9 items-center gap-2">
                  <input
                    type="radio"
                    name="when"
                    checked={when === "later"}
                    onChange={() => setWhen("later")}
                    className="accent-accent"
                  />
                  {x.publishLater}
                </label>
              </fieldset>
              {when === "later" && (
                <Field label={x.effectiveOn} help={x.effectiveOnHelp}>
                  <input
                    type="date"
                    name="effectiveOn"
                    required
                    dir="ltr"
                    min={today}
                    className={inputClass}
                  />
                </Field>
              )}
              {version.acknowledgementRequired && (
                <p className="text-xs text-muted">
                  {fill(x.publishAcknowledge, {
                    days: durationFormat(lang)(version.acknowledgeWithinDays, "day"),
                  })}
                </p>
              )}
              <div>
                <Button type="submit" disabled={busy}>
                  {when === "later" ? x.schedule : x.publish}
                </Button>
              </div>
            </form>
          )}

          {moves.includes("recall") &&
            (open === "recall" ? (
              <div className="flex flex-col gap-2">
                <p role="alert" className="text-sm">
                  {x.recallConfirm}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => act("recall", {}, x.recalled)}>
                    {x.recallYes}
                  </Button>
                  <Button variant="secondary" onClick={() => setOpen(null)}>
                    {x.keep}
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button variant="secondary" onClick={() => setOpen("recall")}>
                  {x.recall}
                </Button>
              </div>
            ))}

          {moves.includes("withdraw") &&
            (open === "withdraw" ? (
              <form onSubmit={withdraw} className="flex flex-col gap-3">
                <Field label={x.withdrawReason}>
                  <textarea
                    name="reason"
                    required
                    rows={2}
                    maxLength={1000}
                    dir="auto"
                    className={textareaClass}
                  />
                </Field>
                <p role="alert" className="text-sm text-danger">
                  {fill(x.withdrawConfirm, {
                    version: numbers.format(version.version),
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={busy} className="bg-danger hover:bg-danger">
                    {x.withdrawYes}
                  </Button>
                  <Button variant="secondary" onClick={() => setOpen(null)}>
                    {x.keep}
                  </Button>
                </div>
              </form>
            ) : (
              <div>
                <Button variant="secondary" onClick={() => setOpen("withdraw")}>
                  {x.withdraw}
                </Button>
              </div>
            ))}

          {refused && <RefusalNote refusal={refused} />}
          {message && (
            <p
              role={message.ok ? "status" : "alert"}
              className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}
            >
              {message.text}
            </p>
          )}
          {message?.ok && version.status === "published" && (
            <p className="text-sm">
              <Link href={documentPath(lang, doc.id)} className="text-accent hover:underline">
                {r.backToDocument}
              </Link>
            </p>
          )}
        </div>
      </>
    </Panel>
  );
}
