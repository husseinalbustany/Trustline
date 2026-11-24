"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/panel";
import { api } from "@/lib/api";
import type { OrgUnit } from "@/lib/identity";
import {
  harmLevels,
  incidentTypes,
  type IncidentCategory,
} from "@/lib/incidents";
import { pick, readForm } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import { explain, textareaClass, type IncidentsProps } from "./types";

type Lists = { categories: IncidentCategory[]; units: OrgUnit[] };
type Sent = { id: string; reference: string; anonymous: boolean };

const two = (n: number) => String(n).padStart(2, "0");
/** A moment as a `datetime-local` input writes it, in the user's own time. */
const localMinute = (d: Date) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;

/** The report form: short enough to finish on a phone in two minutes. */
export function ReportForm({
  lang,
  t,
  heading,
}: IncidentsProps & { heading: { title: string; description: string } }) {
  const session = useSession();
  const allowed = can(session, "incidents.report");
  const [lists, setLists] = useState<Lists | null>(null);
  const [problem, setProblem] = useState(false);
  // The latest time the form accepts, and what "when" shows until changed.
  const [now, setNow] = useState("");
  const [occurredAt, setOccurredAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  const f = t.form;
  const listPath = `/${lang}/incidents`;

  useEffect(() => {
    if (!allowed) return;
    Promise.all([
      api<IncidentCategory[]>("/incident-categories"),
      api<OrgUnit[]>("/org-units"),
    ])
      .then(([categories, units]) => {
        setLists({ categories, units });
        setNow(localMinute(new Date()));
        setProblem(false);
      })
      .catch(() => setProblem(true));
  }, [allowed]);

  // Visited pages stay mounted, so nothing of a sent report may be waiting
  // here when the page is shown again.
  const startAgain = () => {
    setSent(null);
    setError(null);
    setOccurredAt(null);
    setNow(localMinute(new Date()));
  };

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { anonymous, immediateAction, ...fields } = readForm(form);
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string; reference: string }>(
        "/incidents",
        {
          method: "POST",
          body: {
            ...fields,
            // Left as it was, "when" means the moment of sending.
            occurredAt: (occurredAt
              ? new Date(occurredAt)
              : new Date()
            ).toISOString(),
            immediateAction: immediateAction || null,
            anonymous: anonymous === "on",
          },
        },
      );
      form.reset();
      setOccurredAt(null);
      setSent({ ...created, anonymous: anonymous === "on" });
    } catch (err) {
      setError(explain(err, t.errors));
    }
    setBusy(false);
  }

  const header = (
    <PageHeader title={heading.title} description={heading.description} />
  );
  const state = (text: string) => (
    <>
      {header}
      <EmptyState>{text}</EmptyState>
    </>
  );
  if (!allowed) return state(f.noPermission);
  if (problem) return state(f.loadError);
  if (!lists) return state(t.loading);
  if (lists.units.length === 0) return state(f.noUnits);

  if (sent) {
    return (
      <>
        <PageHeader title={f.doneTitle} />
        <div
          role="status"
          className="mt-6 flex max-w-xl flex-col gap-4 rounded-lg border border-accent bg-accent-soft p-4 sm:p-6"
        >
          <p className="text-sm">{f.doneHelp}</p>
          <p
            dir="ltr"
            className="text-center text-3xl font-semibold tracking-tight break-all tabular-nums select-all"
          >
            {sent.reference}
          </p>
          {sent.anonymous && (
            <p className="text-sm font-medium">{f.doneAnonymous}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {!sent.anonymous && (
              <Link
                href={`${listPath}/${sent.id}`}
                onClick={startAgain}
                className="inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent-hover"
              >
                {f.view}
              </Link>
            )}
            <Button
              variant="secondary"
              className="h-10 bg-background px-4"
              onClick={startAgain}
            >
              {f.another}
            </Button>
          </div>
        </div>
      </>
    );
  }

  const inLang = (text: IncidentCategory["name"]) =>
    pick(text, lang, session.tenant.defaultLocale);

  return (
    <>
      {header}
      <p className="mt-4 text-sm text-muted">{f.intro}</p>
      <form onSubmit={submit} className="mt-6 flex max-w-2xl flex-col gap-5">
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{f.type}</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {incidentTypes.map((type) => (
              <label
                key={type}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-line p-3 has-checked:border-accent has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
              >
                <input
                  type="radio"
                  name="type"
                  value={type}
                  required
                  className="mt-1 size-4 shrink-0 accent-accent"
                />
                <span>
                  <span className="block text-base font-semibold">
                    {t.type[type]}
                  </span>
                  <span className="block text-xs text-muted">
                    {t.typeHelp[type]}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={f.category}>
            <select
              name="categoryId"
              required
              defaultValue=""
              className={inputClass}
            >
              <option value="" disabled>
                {f.choose}
              </option>
              {lists.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {inLang(c.name)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={f.where}>
            <select
              name="orgUnitId"
              required
              defaultValue=""
              className={inputClass}
            >
              <option value="" disabled>
                {f.choose}
              </option>
              {unitOptions(lists.units, (u) => inLang(u.name)).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label={f.occurredAt} help={f.occurredAtHelp}>
          <input
            type="datetime-local"
            required
            dir="ltr"
            max={now}
            value={occurredAt ?? now}
            onFocus={() => setNow(localMinute(new Date()))}
            onChange={(e) => setOccurredAt(e.target.value)}
            className={`${inputClass} sm:max-w-xs`}
          />
        </Field>

        <Field label={f.description} help={f.descriptionHelp}>
          <textarea
            name="description"
            required
            rows={5}
            maxLength={5000}
            dir="auto"
            className={textareaClass}
          />
        </Field>

        <Field label={f.immediateAction}>
          <textarea
            name="immediateAction"
            rows={2}
            maxLength={2000}
            dir="auto"
            className={textareaClass}
          />
        </Field>

        <Field label={f.harmLevel}>
          <select
            name="harmLevel"
            required
            defaultValue=""
            className={`${inputClass} sm:max-w-xs`}
          >
            <option value="" disabled>
              {f.choose}
            </option>
            {harmLevels.map((level) => (
              <option key={level} value={level}>
                {t.harm[level]}
              </option>
            ))}
          </select>
        </Field>

        <label className="flex items-start gap-3 rounded-lg border border-line p-3 text-sm has-checked:border-accent has-checked:bg-accent-soft">
          <input
            type="checkbox"
            name="anonymous"
            className="mt-0.5 size-4 shrink-0 accent-accent"
          />
          <span>
            <span className="block font-medium">{f.anonymous}</span>
            <span className="mt-1 block">{f.anonymousWarning}</span>
          </span>
        </label>

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={busy}
            className="h-11 px-5 max-sm:w-full"
          >
            {f.submit}
          </Button>
          <Link
            href={listPath}
            className="inline-flex h-11 items-center rounded-md px-3 text-sm text-muted hover:bg-surface hover:text-foreground max-sm:w-full max-sm:justify-center"
          >
            {f.cancel}
          </Link>
        </div>
      </form>
    </>
  );
}
