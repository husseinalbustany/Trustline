"use client";

import { FileStack } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useSession } from "@/components/shell/session";
import {
  ReadOnlyFieldset,
  useReadOnly,
} from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, inputClass } from "@/components/ui/field";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { direction, hasLocale, localeNames } from "@/i18n/config";
import { api, ApiError, codeOf, detailsOf } from "@/lib/api";
import { dayFormat, fill, languageNameIn } from "@/lib/format";
import { pick, readForm, type Localized } from "@/lib/localized";
import {
  documentPath,
  importPath,
  todayIn,
  type PolicyDocument,
  type PolicySettings,
  type Section,
} from "@/lib/policies";
import type {
  CheckedDocument,
  ImportDocument,
  ImportProblem,
} from "@/lib/policy-import";
import { DocumentFields, loadLists, readDocumentBody, type Lists } from "./document-form";
import { PasswordPrompt } from "./password-prompt";
import { Sentence, Words } from "./sentence";
import { textareaClass, type PoliciesProps, type PoliciesText } from "./types";
import { useExplain } from "./use-explain";

/** On a field for one language: the language's own name. */
const ownName = (locale: string) =>
  hasLocale(locale) ? localeNames[locale] : locale;

/**
 * The window in which documents may be imported, and the latest approval
 * day allowed, when the API gives them with the settings. Read loosely:
 * the names may still change.
 */
export type ImportWindow = {
  /** The last day documents may be imported. */
  closesOn: string | null;
  /** The latest approval day an imported document may have. */
  latestApprovedOn: string | null;
  /** The day the module was first switched on: approved before it. */
  startedOn: string | null;
  /** Whether imports are accepted today, as the API says. */
  open: boolean | null;
};

export function importWindowOf(settings: unknown): ImportWindow | null {
  if (!settings || typeof settings !== "object") return null;
  const o = settings as Record<string, unknown>;
  const w = (o.importWindow ?? o.imports ?? null) as Record<string, unknown> | null;
  const day = (v: unknown) =>
    typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const closesOn = day(w?.closesOn ?? w?.until ?? w?.endsOn ?? o.importWindowClosesOn);
  const latestApprovedOn = day(w?.latestApprovedOn ?? o.importLatestApprovedOn);
  const startedOn = day(w?.startedOn ?? w?.moduleStartedOn ?? o.policiesStartedOn);
  const open = typeof w?.open === "boolean" ? w.open : null;
  return closesOn || latestApprovedOn || startedOn
    ? { closesOn, latestApprovedOn, startedOn, open }
    : null;
}

/** Whether the window has closed, by the client's calendar. */
export const windowClosed = (w: ImportWindow | null, today: string) =>
  w?.open === false || (!!w?.closesOn && w.closesOn < today);

/** Said at the top of the import screens, when the API says when imports end. */
export function ImportWindowNote({
  lang,
  t,
  window: w,
}: PoliciesProps & { window: ImportWindow | null }) {
  const session = useSession();
  if (!w) return null;
  const day = dayFormat(lang);
  const m = t.importing;
  const closed = windowClosed(w, todayIn(session.tenant.timeZone));
  return (
    <div
      role="note"
      className={`mt-4 flex max-w-3xl flex-col gap-1 rounded-md border px-3 py-2 text-sm ${
        closed ? "border-warn bg-warn-soft" : "border-line bg-surface"
      }`}
    >
      {w.closesOn && (
        <p className={closed ? "font-medium" : undefined}>
          {fill(closed ? t.errors.import_window_closed_on : m.windowCloses, {
            date: day(w.closesOn) ?? "",
          })}
        </p>
      )}
      {!closed && w.latestApprovedOn && (
        <p>{fill(m.latestApproval, { date: day(w.latestApprovedOn) ?? "" })}</p>
      )}
      {!closed && !w.latestApprovedOn && w.startedOn && (
        <p>{fill(m.approvedBeforeStart, { date: day(w.startedOn) ?? "" })}</p>
      )}
    </div>
  );
}

/**
 * A refusal of one document of a batch, worded as the refusal it would
 * have alone: the API gives the same code and details.
 */
export const asRefusal = (problem: ImportProblem) =>
  new ApiError(problem.status, problem.code, undefined, undefined, problem);

/** The sections of a type, a text per language for each, as an import takes them. */
export function SectionsFields({
  lang,
  t,
  sections,
  authoritative,
  value,
}: PoliciesProps & {
  sections: Section[];
  /** The language whose required sections must be written before a re-issue. */
  authoritative: string;
  value?: Record<string, Localized>;
}) {
  const session = useSession();
  const { locales, defaultLocale } = session.tenant;
  const ordered = [authoritative, ...locales.filter((l) => l !== authoritative)];
  const m = t.importing;
  return (
    <ol className="flex flex-col gap-4">
      {sections.map((section, i) => (
        <li key={section.key} className="rounded-lg border border-line">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
            <h3 className="text-sm font-semibold">
              {`${i + 1}. ${pick(section.name, lang, defaultLocale)}`}
            </h3>
            {section.required ? (
              <Pill tone="warn">{t.editor.required}</Pill>
            ) : (
              <Pill tone="neutral">{t.editor.optional}</Pill>
            )}
          </div>
          <div className="grid gap-4 p-4 lg:grid-cols-2">
            {ordered.map((locale) => (
              <Field
                key={locale}
                label={ownName(locale)}
                help={
                  locale === authoritative && section.required
                    ? fill(m.sectionRequiredHelp, {
                        language: languageNameIn(lang)(authoritative),
                      })
                    : undefined
                }
              >
                <textarea
                  name={`section:${section.key}:${locale}`}
                  rows={5}
                  maxLength={40_000}
                  lang={locale}
                  dir={direction(locale)}
                  defaultValue={value?.[section.key]?.[locale] ?? ""}
                  className={textareaClass}
                />
              </Field>
            ))}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The section texts a form holds, per language, per section key. */
export function readSections(form: HTMLFormElement) {
  const content: Record<string, Record<string, string>> = {};
  for (const [name, raw] of new FormData(form)) {
    const parts = /^section:([^:]+):([^:]+)$/.exec(name);
    const text = String(raw).replace(/\r\n?/g, "\n").trim();
    if (!parts || !text) continue;
    content[parts[2]] = { ...content[parts[2]], [parts[1]]: text };
  }
  return content;
}

/** What the original says of its approval: the fields, as it gives them. */
export function OriginalFields({
  t,
  value,
}: {
  t: PoliciesText;
  value?: {
    number?: string;
    revision?: string;
    approvedOn?: string;
    approvedBy?: string;
    lastReviewedOn?: string;
    effectiveOn?: string;
    nextReviewOn?: string;
    keptAt?: Localized;
    differences?: Localized;
  };
}) {
  const session = useSession();
  const { locales, defaultLocale } = session.tenant;
  const m = t.importing;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label={m.number} help={m.numberHelp}>
          <input
            name="number"
            maxLength={40}
            dir="ltr"
            autoComplete="off"
            defaultValue={value?.number ?? ""}
            className={inputClass}
          />
        </Field>
        <Field label={m.revisionLabel} help={m.revisionLabelHelp}>
          <input
            name="revisionLabel"
            maxLength={40}
            dir="auto"
            autoComplete="off"
            defaultValue={value?.revision ?? ""}
            className={inputClass}
          />
        </Field>
        <Field label={m.approvedOn} help={m.approvedOnHelp}>
          <input
            name="approvedOn"
            type="date"
            required
            dir="ltr"
            defaultValue={value?.approvedOn ?? ""}
            className={inputClass}
          />
        </Field>
        <Field label={m.approvedBy} help={m.approvedByHelp}>
          <input
            name="approvedBy"
            required
            maxLength={200}
            dir="auto"
            autoComplete="off"
            defaultValue={value?.approvedBy ?? ""}
            className={inputClass}
          />
        </Field>
        <Field label={m.lastReviewedOn} help={m.lastReviewedOnHelp}>
          <input
            name="lastReviewedOn"
            type="date"
            dir="ltr"
            defaultValue={value?.lastReviewedOn ?? ""}
            className={inputClass}
          />
        </Field>
        <Field label={m.effectiveOn} help={m.effectiveOnHelp}>
          <input
            name="effectiveOn"
            type="date"
            dir="ltr"
            defaultValue={value?.effectiveOn ?? ""}
            className={inputClass}
          />
        </Field>
        <Field label={m.nextReviewOn} help={m.nextReviewOnHelp}>
          <input
            name="nextReviewOn"
            type="date"
            required
            dir="ltr"
            defaultValue={value?.nextReviewOn ?? ""}
            className={inputClass}
          />
        </Field>
      </div>
      <div className="flex flex-col gap-1">
        <LocalizedField
          label={m.keptAt}
          name="keptAt"
          locales={locales}
          required={defaultLocale}
          value={value?.keptAt}
          maxLength={300}
        />
        <p className="text-xs text-muted">{m.keptAtHelp}</p>
      </div>
      <div className="flex flex-col gap-1">
        <LocalizedField
          label={m.differences}
          name="differences"
          locales={locales}
          value={value?.differences}
          maxLength={2000}
          multiline
        />
        <p className="text-xs text-muted">{m.differencesHelp}</p>
      </div>
    </div>
  );
}

/**
 * Under the signing sentence ("matches the approved original, except as
 * noted below"): what is noted, for each document that notes something,
 * or that nothing is.
 */
export function NotedDifferences({
  t,
  items,
}: PoliciesProps & {
  items: { key: string; label?: ReactNode; differences?: Localized | null }[];
}) {
  const session = useSession();
  const m = t.importing;
  const noted = items.filter(
    (x) => x.differences && Object.values(x.differences).some((v) => v?.trim()),
  );
  if (noted.length === 0) {
    return <p className="mt-2 text-sm text-muted">{m.noDifferences}</p>;
  }
  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md border border-line bg-background px-3 py-2">
      <p className="text-xs font-medium text-muted">{m.differencesNoted}</p>
      <ul className="flex flex-col gap-2 text-sm">
        {noted.map((item) => (
          <li key={item.key} className="flex flex-col gap-0.5">
            {item.label && <span className="text-xs text-muted">{item.label}</span>}
            {session.tenant.locales
              .filter((l) => item.differences?.[l]?.trim())
              .map((l) => (
                <p
                  key={l}
                  lang={l}
                  dir={direction(l)}
                  className="whitespace-pre-wrap break-words"
                >
                  {session.tenant.locales.length > 1 && (
                    <span className="text-xs text-muted">{`${ownName(l)}: `}</span>
                  )}
                  {item.differences![l]}
                </p>
              ))}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Only the languages with text. */
const written = (text: unknown): Localized =>
  Object.fromEntries(
    Object.entries((text ?? {}) as Record<string, unknown>)
      .map(([k, v]) => [k, String(v ?? "").trim()])
      .filter(([, v]) => v),
  );

/** What the check found for a document it would import, in a few lines. */
export function CheckedLines({
  lang,
  t,
  checked,
  sections,
  given,
}: PoliciesProps & {
  checked: CheckedDocument;
  sections: Section[];
  /** The number as it was entered, when one was. */
  given?: string;
}) {
  const session = useSession();
  const m = t.importing;
  const list = new Intl.ListFormat(lang, { type: "conjunction" });
  const nameOf = (key: string) => {
    const s = sections.find((x) => x.key === key);
    return s ? pick(s.name, lang, session.tenant.defaultLocale) : key;
  };
  const required = checked.sectionsNotWritten.filter((s) => s.required);
  const other = checked.sectionsNotWritten.filter((s) => !s.required);
  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      <li>
        {checked.numberFrom === "given" && checked.number ? (
          <Sentence
            text={checked.series ? m.numberKeptSeries : m.numberKept}
            number={checked.number}
            values={{ series: checked.series ?? "" }}
          />
        ) : (
          fill(m.numberedByTrustline, { series: checked.series ?? "" })
        )}
      </li>
      {/* Recorded otherwise than it was typed (spaces, a script's digits). */}
      {checked.numberFrom === "given" &&
        checked.number &&
        given &&
        given.trim() !== checked.number && (
          <li className="text-muted">
            <Words
              text={m.numberNormalised}
              values={{
                given: (
                  <span dir="ltr" className="whitespace-nowrap">
                    {given.trim()}
                  </span>
                ),
              }}
            />
          </li>
        )}
      {required.length > 0 && (
        <li className="text-warn">
          {fill(m.requiredNotWritten, { sections: list.format(required.map((s) => nameOf(s.key))) })}
        </li>
      )}
      {other.length > 0 && (
        <li className="text-muted">
          {fill(m.optionalNotWritten, { sections: list.format(other.map((s) => nameOf(s.key))) })}
        </li>
      )}
      <li className="text-muted">
        {checked.acknowledgementRequired ? m.ackAsked : m.ackNotAsked}
      </li>
    </ul>
  );
}

type Ready = { lists: Lists; settings: PolicySettings | null };

/** Importing one document approved before Trustline, from its original. */
export function ImportDocumentPage({ lang, t }: PoliciesProps) {
  const session = useSession();
  const [ready, setReady] = useState<Ready | null>(null);
  const [problem, setProblem] = useState(false);
  const everywhere = session.scope?.["policies.manage"] === "all";
  const m = t.importing;
  useEffect(() => {
    if (!everywhere) return;
    let current = true;
    Promise.all([
      loadLists(),
      api<PolicySettings>("/policies/settings").catch(() => null),
    ])
      .then(([lists, settings]) => current && setReady({ lists, settings }))
      .catch(() => current && setProblem(true));
    return () => {
      current = false;
    };
  }, [everywhere]);
  return (
    <>
      <PageHeader
        title={m.title}
        description={m.description}
        actions={
          everywhere && (
            <ButtonLink variant="secondary" href={importPath(lang, "batch")}>
              <FileStack className="size-4" aria-hidden />
              {m.batchOpen}
            </ButtonLink>
          )
        }
      />
      {!everywhere ? (
        <EmptyState>{m.noAccess}</EmptyState>
      ) : problem ? (
        <EmptyState>{t.loadError}</EmptyState>
      ) : !ready ? (
        <EmptyState>{t.loading}</EmptyState>
      ) : (
        <>
          <ImportWindowNote lang={lang} t={t} window={importWindowOf(ready.settings)} />
          <ImportForm lang={lang} t={t} ready={ready} />
        </>
      )}
    </>
  );
}

function ImportForm({ lang, t, ready }: PoliciesProps & { ready: Ready }) {
  const session = useSession();
  const router = useRouter();
  const readOnly = useReadOnly();
  const { lists, settings } = ready;
  const authoritative = settings?.authoritative ?? session.tenant.defaultLocale;
  // Nothing can be imported once the window has closed.
  const closed = windowClosed(importWindowOf(settings), todayIn(session.tenant.timeZone));
  const m = t.importing;
  const form = useRef<HTMLFormElement>(null);
  const [typeId, setTypeId] = useState("");
  const [whole, setWhole] = useState(true);
  const [ackRequired, setAckRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What was checked, and the answer: signing sends exactly this.
  const [checked, setChecked] = useState<{
    body: ImportDocument;
    result: CheckedDocument;
  } | null>(null);
  const type = lists.types.find((x) => x.id === typeId);
  const sectionsOf = type?.sections ?? [];
  const explainError = useExplain(t, lang, sectionsOf);
  useLayoutEffect(
    () => () => {
      setError(null);
      setChecked(null);
    },
    [],
  );

  function bodyOf(el: HTMLFormElement): ImportDocument | null {
    const base = readDocumentBody(el, whole);
    if (!base) return null;
    const data = new FormData(el);
    const fields = readForm(el);
    const text = (name: string) => String(data.get(name) ?? "").trim();
    const days = Number(data.get("acknowledgeWithinDays") ?? 14);
    const body = {
      ...base,
      typeId,
      title: written(base.title),
      approvedOn: text("approvedOn"),
      approvedBy: text("approvedBy"),
      originalKeptAt: written(fields.keptAt),
      nextReviewOn: text("nextReviewOn"),
      ...(text("lastReviewedOn") ? { lastReviewedOn: text("lastReviewedOn") } : {}),
      ...(Object.keys(written(fields.differences)).length > 0
        ? { differences: written(fields.differences) }
        : {}),
      content: readSections(el),
      acknowledgementRequired: ackRequired,
      ...(ackRequired ? { acknowledgeWithinDays: days } : {}),
      ...(text("number") ? { number: text("number") } : {}),
      ...(text("revisionLabel") ? { revisionLabel: text("revisionLabel") } : {}),
      ...(text("effectiveOn") ? { effectiveOn: text("effectiveOn") } : {}),
    } as ImportDocument;
    return body;
  }

  async function check(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body = bodyOf(e.currentTarget);
    if (!body) return setError(t.form.audienceUnitsMissing);
    setBusy(true);
    setError(null);
    setChecked(null);
    try {
      const answer = await api<{ documents: CheckedDocument[] }>(
        "/policies/imports/check",
        { method: "POST", body: { documents: [body] } },
      );
      setChecked({ body, result: answer.documents[0] });
    } catch (err) {
      const problems = detailsOf(err).problems;
      setError(
        codeOf(err) === "batch_refused" && Array.isArray(problems) && problems[0]
          ? explainError(asRefusal(problems[0] as ImportProblem))
          : explainError(err),
      );
    }
    setBusy(false);
  }

  return (
    <>
      <p className="mt-4 max-w-3xl text-sm text-muted">
        <Link href={importPath(lang, "layout")} className="text-accent hover:underline">
          {m.layoutOpen}
        </Link>
      </p>
      <form
        ref={form}
        onSubmit={check}
        // Anything changed after the check is checked again before signing.
        onChange={() => {
          if (checked) setChecked(null);
        }}
        className="mt-4 flex max-w-3xl flex-col gap-6"
      >
        <ReadOnlyFieldset>
          <DocumentFields
            lang={lang}
            t={t}
            lists={lists}
            doc={null}
            typeId={typeId}
            onTypeChange={(id) => {
              setTypeId(id);
              setChecked(null);
            }}
            whole={whole}
            onWholeChange={setWhole}
            acknowledgement={{ required: ackRequired, onChange: setAckRequired }}
            reviewMonthsHelp={m.reviewMonthsHelp}
          />
          <Panel title={m.original}>
            <div className="flex flex-col gap-4 p-4">
              <p className="text-sm text-muted">{m.originalHelp}</p>
              <OriginalFields t={t} />
            </div>
          </Panel>
          <Panel title={m.text}>
            <div className="flex flex-col gap-4 p-4">
              <p className="text-sm text-muted">
                {fill(m.textHelp, { language: languageNameIn(lang)(authoritative) })}
              </p>
              {type ? (
                <SectionsFields
                  lang={lang}
                  t={t}
                  sections={type.sections}
                  authoritative={authoritative}
                />
              ) : (
                <p className="text-sm text-muted">{m.chooseTypeFirst}</p>
              )}
            </div>
          </Panel>
        </ReadOnlyFieldset>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        {!checked && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={busy || readOnly || !type || closed}>
              {busy ? m.checking : m.check}
            </Button>
            <Link href={`/${lang}/policies`} className="text-sm text-accent hover:underline">
              {t.actions.cancel}
            </Link>
          </div>
        )}
      </form>

      {checked && (
        <section
          aria-label={m.signTitle}
          className="mt-6 flex max-w-3xl flex-col gap-4"
        >
          <div className="rounded-lg border border-accent bg-accent-soft px-4 py-3">
            <p className="text-sm font-medium">{m.checkedOk}</p>
            <div className="mt-1">
              <CheckedLines
                lang={lang}
                t={t}
                checked={checked.result}
                sections={sectionsOf}
                given={checked.body.number}
              />
            </div>
          </div>
          <PasswordPrompt
            t={t}
            intro={
              <>
                <p>{m.signOne}</p>
                <NotedDifferences
                  lang={lang}
                  t={t}
                  items={[{ key: "one", differences: checked.body.differences }]}
                />
              </>
            }
            confirm={m.signOneConfirm}
            explainError={explainError}
            onCancel={() => setChecked(null)}
            submit={async (password) => {
              const created = await api<PolicyDocument>("/policies/documents/import", {
                method: "POST",
                body: { ...checked.body, password },
              });
              // Visited pages stay mounted: the next import starts empty.
              form.current?.reset();
              setTypeId("");
              setWhole(true);
              setAckRequired(false);
              setChecked(null);
              router.push(documentPath(lang, created.id));
            }}
          />
        </section>
      )}
    </>
  );
}
