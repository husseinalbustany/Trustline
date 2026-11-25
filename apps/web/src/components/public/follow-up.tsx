"use client";

import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import {
  IncidentComments,
  IncidentReport,
  IncidentTimeline,
} from "@/components/incidents/incident-view";
import { IncidentPills } from "@/components/incidents/pills";
import {
  textareaClass,
  type IncidentsText,
} from "@/components/incidents/types";
import { Button } from "@/components/ui/button";
import { Field, roomyInputClass } from "@/components/ui/field";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, retryAfterOf, statusOf } from "@/lib/api";
import { fill, timeUntilFormat } from "@/lib/format";
import type {
  FollowUpView,
  IncidentComment,
  PublicReporting,
} from "@/lib/incidents";
import { pick } from "@/lib/localized";
import { PublicFrame } from "./public-frame";

/** A report that is open: what the API answered, and the code that opened it. */
type Open = { code: string; view: FollowUpView };

/**
 * Coming back to an anonymous report with its follow-up code: its status,
 * the report, what has happened to it, the comments, and a box to add one.
 *
 * The code is held in this component's state for as long as the report is
 * on the page, because each comment and each refresh has to present it
 * again. It is never put in the address, in storage or in a log, the
 * browser is asked not to remember the field, and it is dropped when the
 * page is left or the reader closes the report. Nothing here uses the
 * reader's session, if they have one.
 */
export function FollowUp({
  lang,
  appName,
  languageLabel,
  t,
  u,
  slug,
}: {
  lang: Locale;
  appName: string;
  languageLabel: string;
  t: IncidentsText;
  u: Dictionary["followUp"];
  slug: string;
}) {
  const [open, setOpen] = useState<Open | null>(null);
  // The hospital's name and own language, when it says them to everyone
  // (it does where reporting without sign-in is on). The page works the
  // same without: it is only so the reader sees whose page they are on.
  const [hospital, setHospital] = useState<Pick<
    PublicReporting,
    "name" | "defaultLocale"
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A comment was sent but the report could not be read again after it.
  const [behind, setBehind] = useState(false);
  const path = `/public/follow-up/${encodeURIComponent(slug)}`;
  const until = timeUntilFormat(lang);

  useEffect(() => {
    let current = true;
    api<PublicReporting>(`/public/reporting/${encodeURIComponent(slug)}`, {
      withoutSession: true,
    })
      .then(
        ({ name, defaultLocale }) =>
          current && setHospital({ name, defaultLocale }),
      )
      .catch(() => current && setHospital(null));
    return () => {
      current = false;
    };
  }, [slug]);

  // Visited pages stay mounted: the code and the report it opened do not
  // wait here for whoever comes to this page next.
  useLayoutEffect(
    () => () => {
      setOpen(null);
      setError(null);
      setBehind(false);
    },
    [],
  );

  const refusal = (err: unknown) => {
    const status = statusOf(err);
    if (status === 429) {
      const wait = retryAfterOf(err);
      return wait ? fill(u.tooMany, { when: until(wait) }) : u.tooManyLater;
    }
    // A code that is wrong, a hospital that does not exist: one answer.
    return status === 404 ? u.wrong : u.error;
  };

  const read = (code: string) =>
    api<FollowUpView>(path, {
      method: "POST",
      body: { code },
      withoutSession: true,
    });

  async function enter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const code = String(new FormData(form).get("code") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const view = await read(code);
      // The field is emptied: the code is now in memory only.
      form.reset();
      setBehind(false);
      setOpen({ code, view });
    } catch (err) {
      setError(refusal(err));
    }
    setBusy(false);
  }

  async function comment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!open) return;
    const form = e.currentTarget;
    const body = String(new FormData(form).get("body") ?? "");
    setBusy(true);
    setError(null);
    try {
      const added = await api<Pick<IncidentComment, "id" | "createdAt">>(
        `${path}/comments`,
        {
          method: "POST",
          body: { code: open.code, body },
          withoutSession: true,
        },
      );
      form.reset();
      // Shown at once, as it was stored; then the report is read again for
      // what else has changed. If that fails the comment is still here.
      const written: IncidentComment = {
        ...added,
        author: null,
        byReporter: true,
        body,
        visibility: "everyone",
      };
      setOpen({
        code: open.code,
        view: { ...open.view, comments: [...open.view.comments, written] },
      });
      try {
        const view = await read(open.code);
        setOpen((now) => (now?.code === open.code ? { ...now, view } : now));
        setBehind(false);
      } catch {
        setBehind(true);
      }
    } catch (err) {
      setError(refusal(err));
    }
    setBusy(false);
  }

  const close = () => {
    setOpen(null);
    setError(null);
    setBehind(false);
  };

  const heading = hospital ? (
    <bdi>{pick(hospital.name, lang, hospital.defaultLocale)}</bdi>
  ) : (
    appName
  );
  const alert = error && (
    <p role="alert" className="text-base text-danger">
      {error}
    </p>
  );

  if (!open) {
    return (
      <PublicFrame lang={lang} heading={heading} languageLabel={languageLabel}>
        <div className="flex flex-col gap-5">
          <div>
            <h1 className="text-2xl font-semibold ltr:tracking-tight">
              {u.title}
            </h1>
            <p className="mt-1 text-base text-muted">{u.intro}</p>
          </div>
          <form
            onSubmit={enter}
            className="flex flex-col gap-5 rounded-lg border border-line bg-background p-4"
          >
            <Field label={u.code} help={u.codeHelp}>
              <input
                name="code"
                required
                maxLength={80}
                dir="ltr"
                // Not remembered by the browser, not corrected, not guessed.
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                placeholder={u.codeExample}
                className={`${roomyInputClass} font-mono tracking-wider uppercase placeholder:normal-case`}
              />
            </Field>
            {alert}
            <Button
              type="submit"
              disabled={busy}
              className="h-12 w-full px-5 text-base"
            >
              {u.submit}
            </Button>
          </form>
          <p className="text-sm text-muted">{u.notKept}</p>
          <p className="text-sm text-muted">{u.lost}</p>
        </div>
      </PublicFrame>
    );
  }

  // Whoever holds the code is not shown a person's name: `names="hidden"`.
  const view = {
    lang,
    t,
    incident: open.view,
    fallback: hospital?.defaultLocale,
    names: "hidden" as const,
  };

  return (
    // No language links while a report is open: changing language leaves
    // the page, and the code would have to be typed again.
    <PublicFrame
      lang={lang}
      heading={heading}
      languageLabel={languageLabel}
      languages={false}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold ltr:tracking-tight">
            {u.viewTitle}
          </h1>
          <IncidentPills
            t={t}
            status={open.view.status}
            harmLevel={open.view.harmLevel}
            isSentinel={open.view.isSentinel}
          />
          <p className="text-base text-muted">{u.viewHelp}</p>
        </div>
        {behind && (
          <p
            role="status"
            className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            {t.detail.behind}
          </p>
        )}
        <IncidentReport {...view} />
        <IncidentTimeline {...view} />
        <IncidentComments {...view}>
          <form onSubmit={comment} className="flex flex-col gap-3 p-4">
            <Field label={t.comments.body} help={t.comments.reporterHelp}>
              <textarea
                name="body"
                required
                rows={3}
                maxLength={2000}
                dir="auto"
                className={`${textareaClass} text-base`}
              />
            </Field>
            {alert}
            <Button
              type="submit"
              disabled={busy}
              className="h-12 px-5 text-base max-sm:w-full"
            >
              {t.comments.submit}
            </Button>
          </form>
        </IncidentComments>
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            className="h-12 bg-background px-5 text-base"
            onClick={close}
          >
            {u.close}
          </Button>
          <p className="text-sm text-muted">{u.closeHelp}</p>
        </div>
      </div>
    </PublicFrame>
  );
}
