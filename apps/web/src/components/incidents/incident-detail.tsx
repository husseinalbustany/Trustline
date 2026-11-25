"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { can, useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/panel";
import { api, statusOf } from "@/lib/api";
import { dateTimeFormat, fill } from "@/lib/format";
import type { OrgUnit } from "@/lib/identity";
import type {
  AssignableUser,
  Incident,
  IncidentCategory,
} from "@/lib/incidents";
import { pick, readForm, type Localized } from "@/lib/localized";
import {
  IncidentComments,
  IncidentReport,
  IncidentTimeline,
} from "./incident-view";
import { IncidentPills } from "./pills";
import { TriagePanel } from "./triage-panel";
import { explain, textareaClass, type IncidentsProps } from "./types";

/** One incident: the report, what has happened to it, and what can be done. */
export function IncidentDetail({ lang, t }: IncidentsProps) {
  const session = useSession();
  const { id } = useParams<{ id: string }>();
  const [loaded, setLoaded] = useState<Incident | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [categories, setCategories] = useState<IncidentCategory[]>([]);
  const [staff, setStaff] = useState<AssignableUser[]>([]);
  const [staffProblem, setStaffProblem] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A later fetch failed: what is shown may be behind what is stored.
  const [behind, setBehind] = useState(false);
  // The list of staff is for people who triage, wherever they do.
  const mayAssign = can(session, "incidents.triage");
  const listPath = `/${lang}/incidents`;

  useEffect(() => {
    let current = true;
    Promise.all([
      api<Incident>(`/incidents/${id}`),
      api<OrgUnit[]>("/org-units"),
      api<IncidentCategory[]>("/incident-categories"),
    ])
      .then(([incident, u, c]) => {
        if (!current) return;
        setLoaded(incident);
        setUnits(u);
        setCategories(c);
        setProblem(null);
        setBehind(false);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 404 ? t.notFound : t.detail.loadError),
      );
    if (mayAssign) {
      api<AssignableUser[]>("/incidents/assignable-users")
        .then((people) => {
          if (!current) return;
          setStaff(people);
          setStaffProblem(false);
        })
        .catch(() => current && setStaffProblem(true));
    }
    return () => {
      current = false;
    };
  }, [id, mayAssign, t]);

  // After a comment, or when a change was refused because the incident had
  // moved on. If this fails the page stays, with what was being written on
  // it, and says it may be behind; only an incident that is gone replaces it.
  const refresh = () =>
    api<Incident>(`/incidents/${id}`)
      .then((incident) => {
        setLoaded(incident);
        setProblem(null);
        setBehind(false);
      })
      .catch((err) =>
        statusOf(err) === 404 ? setProblem(t.notFound) : setBehind(true),
      );

  const back = (
    <p className="mt-6 text-sm">
      <Link href={listPath} className="text-accent hover:underline">
        {t.detail.back}
      </Link>
    </p>
  );
  const incident = loaded?.id === id ? loaded : null;
  if (problem || !incident) {
    return (
      <>
        <EmptyState>{problem ?? t.loading}</EmptyState>
        {problem && <div className="text-center">{back}</div>}
      </>
    );
  }

  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);
  const d = t.detail;
  const view = { lang, t, incident, fallback: session.tenant.defaultLocale };
  // While it waits for a second person: who asked, and when. Someone who
  // sees only their own report is told that it waits, not who asked.
  const requested =
    incident.status !== "awaiting_sign_off"
      ? null
      : incident.closureRequestedBy && incident.closureRequestedAt
        ? fill(d.awaiting, {
            name: inLang(incident.closureRequestedBy.name),
            date: dateTimeFormat(lang).format(
              new Date(incident.closureRequestedAt),
            ),
          })
        : d.awaitingNoName;

  return (
    <>
      <PageHeader
        title={<bdi dir="ltr">{incident.reference}</bdi>}
        description={
          // Names a client wrote: each keeps its own direction.
          <>
            {t.type[incident.type]} ·{" "}
            <bdi>{inLang(incident.category.name)}</bdi> ·{" "}
            <bdi>{inLang(incident.orgUnit.name)}</bdi>
          </>
        }
        actions={
          <IncidentPills
            t={t}
            status={incident.status}
            harmLevel={incident.harmLevel}
            isSentinel={incident.isSentinel}
          />
        }
      />
      {behind && (
        <p
          role="status"
          className="mt-4 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          {d.behind}
        </p>
      )}
      {incident.access === "reporter" && (
        <p className="mt-4 rounded-md bg-surface px-3 py-2 text-sm text-muted">
          {d.reporterView}
        </p>
      )}

      {requested && (
        <p
          role="status"
          className="mt-4 rounded-md bg-accent-soft px-3 py-2 text-sm"
        >
          {requested}
        </p>
      )}

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <IncidentReport {...view} />

        {/* What the API lets this user do now; nothing when that is nothing. */}
        {(incident.canRetriage || incident.moves.length > 0) && (
          <div className="lg:col-start-2 lg:row-span-3 lg:row-start-1">
            <TriagePanel
              lang={lang}
              t={t}
              incident={incident}
              units={units}
              categories={categories}
              staff={staff}
              staffProblem={staffProblem}
              onChange={setLoaded}
              onStale={refresh}
            />
          </div>
        )}

        <IncidentTimeline {...view} />

        <IncidentComments {...view}>
          <CommentBox t={t} incident={incident} onAdded={refresh} />
        </IncidentComments>
      </div>
      {back}
    </>
  );
}

function CommentBox({
  t,
  incident,
  onAdded,
}: {
  t: IncidentsProps["t"];
  incident: Incident;
  onAdded: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const c = t.comments;
  const full = incident.access === "full";

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { body, visibility } = readForm(form);
    setBusy(true);
    setError(null);
    try {
      await api(`/incidents/${incident.id}/comments`, {
        method: "POST",
        // Someone who sees only their own report can only write to everyone.
        body: { body, visibility: full ? visibility : "everyone" },
      });
      form.reset();
      await onAdded();
    } catch (err) {
      setError(explain(err, t.errors));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 p-4">
      <Field label={c.body} help={full ? c.bodyHelp : c.reporterHelp}>
        <textarea
          name="body"
          required
          rows={3}
          maxLength={2000}
          dir="auto"
          className={textareaClass}
        />
      </Field>
      {full && (
        <fieldset className="flex flex-col gap-1.5 text-sm">
          <legend className="mb-1.5 font-medium">{c.visibility}</legend>
          {(["internal", "everyone"] as const).map((value) => (
            <label key={value} className="flex items-start gap-2">
              <input
                type="radio"
                name="visibility"
                value={value}
                defaultChecked={value === "internal"}
                className="mt-1 accent-accent"
              />
              {value === "internal"
                ? c.visibilityInternal
                : c.visibilityEveryone}
            </label>
          ))}
        </fieldset>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" disabled={busy}>
          {c.submit}
        </Button>
      </div>
    </form>
  );
}
