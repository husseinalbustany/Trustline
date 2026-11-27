"use client";

import { ExternalLink } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
} from "react";
import {
  IncidentComments,
  IncidentReport,
  IncidentTimeline,
} from "@/components/incidents/incident-view";
import { IncidentPills } from "@/components/incidents/pills";
import {
  forReporter,
  textareaClass,
  type IncidentsText,
} from "@/components/incidents/types";
import { Button } from "@/components/ui/button";
import { Field, roomyInputClass } from "@/components/ui/field";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, codeOf, retryAfterOf, statusOf } from "@/lib/api";
import { clockTimeIn, fill } from "@/lib/format";
import type { FollowUpView } from "@/lib/incidents";
import { pick } from "@/lib/localized";
import { deviceTime, wallClock, zoneLabel } from "@/lib/time-zone";
import { PublicFrame } from "./public-frame";

/**
 * A report that is open: what the API answered, the code that opened it,
 * and whether the organization's clock shows what this device's does.
 */
type Open = { code: string; view: FollowUpView; sameClock: boolean };

/** Whether a clock in this zone shows the same time as this device now. */
const showsDeviceTime = (timeZone: string | undefined) => {
  const now = new Date();
  return wallClock(now, timeZone) === wallClock(now, deviceTime);
};

/**
 * The API names no one to a reader who came with a code: whatever staff did
 * is marked `byStaff` and carries no person. This is the one guard this page
 * keeps of its own. Should an answer ever carry a person all the same, they
 * are taken out here, before anything is drawn, and what they did is said
 * by its capacity like the rest.
 */
function withoutNames(view: FollowUpView): FollowUpView {
  return {
    ...view,
    reporter: null,
    assignedTo: null,
    closureRequestedBy: null,
    people: {},
    events: view.events.map((event) =>
      event.actor
        ? { ...event, actor: null, byStaff: !event.byReporter }
        : event,
    ),
    comments: view.comments.map((comment) =>
      comment.author
        ? { ...comment, author: null, byStaff: !comment.byReporter }
        : comment,
    ),
  };
}

/**
 * Coming back to an anonymous report with its follow-up code: its status,
 * the report, what has happened to it, the comments, and a box to add one.
 *
 * The code is held in this component's state for as long as the report is
 * on the page, because each comment has to present it again. It is never put in the address, in storage or in a log, the
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The API refused a comment because work on the report ended while the
  // reader was writing: the page still shows it as it was when opened.
  const [endedSince, setEndedSince] = useState(false);
  // Whether this hospital takes reports without sign-in, asked only once a
  // report is seen to have ended: a link to the form is offered if it does,
  // and staff are pointed to if it does not. Null until it is known.
  const [formOpen, setFormOpen] = useState<boolean | null>(null);
  const path = `/public/follow-up/${encodeURIComponent(slug)}`;
  const clockTime = clockTimeIn(lang);
  // A limit on comments is counted over a day: the time may be tomorrow.
  const dayAndTime = clockTimeIn(lang, { withDay: true });

  // Closed or not taken forward: such a report can be read, not added to.
  const ended =
    open?.view.status === "closed" || open?.view.status === "rejected";
  const over = !!open && (ended || endedSince);
  useEffect(() => {
    if (!over) return;
    let current = true;
    api(`/public/reporting/${encodeURIComponent(slug)}`, {
      withoutSession: true,
    })
      .then(() => current && setFormOpen(true))
      // Off, or not to be known now: no link, and the line reads without.
      .catch(() => current && setFormOpen(false));
    return () => {
      current = false;
    };
  }, [over, slug]);

  const forget = useCallback(() => {
    setOpen(null);
    setError(null);
    setEndedSince(false);
    setFormOpen(null);
  }, []);
  // Visited pages stay mounted: the code and the report it opened do not
  // wait here for whoever comes to this page next.
  useLayoutEffect(() => forget, [forget]);

  const refusal = (err: unknown) => {
    const status = statusOf(err);
    if (status === 429) {
      const wait = retryAfterOf(err);
      return wait ? fill(u.tooMany, { time: clockTime(wait) }) : u.tooManyLater;
    }
    // A code that is wrong, a hospital that does not exist: one answer.
    return status === 404 ? u.wrong : u.error;
  };

  async function enter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const code = String(new FormData(form).get("code") ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const view = await api<FollowUpView>(path, {
        method: "POST",
        body: { code },
        withoutSession: true,
      });
      // The field is emptied: the code is now in memory only.
      form.reset();
      setEndedSince(false);
      setOpen({
        code,
        view: withoutNames(view),
        sameClock: showsDeviceTime(view.hospital.timeZone),
      });
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
      // The answer is the report as it now reads, the new comment included:
      // one attempt at the code, and nothing to read again.
      const view = await api<FollowUpView>(`${path}/comments`, {
        method: "POST",
        body: { code: open.code, body },
        withoutSession: true,
      });
      form.reset();
      // Unless the reader closed the report while it was on its way.
      setOpen((now) =>
        now?.code === open.code ? { ...now, view: withoutNames(view) } : now,
      );
    } catch (err) {
      // Nothing typed is thrown away by a refusal: the box keeps it.
      if (statusOf(err) === 409 && codeOf(err) === "incident_ended") {
        setEndedSince(true);
      } else if (statusOf(err) === 429) {
        // Too many attempts from this address, or too many comments on this
        // report in a day: the page cannot tell which, and says neither.
        const wait = retryAfterOf(err);
        setError(
          wait
            ? fill(u.commentTooMany, { time: dayAndTime(wait) })
            : u.commentTooManyLater,
        );
      } else {
        setError(refusal(err));
      }
    }
    setBusy(false);
  }

  const close = forget;

  // Where to say more once a report has ended. In a new tab: this page, the
  // report and anything typed on it stay open.
  const newReport = formOpen && (
    <a
      href={`/${lang}/report/${encodeURIComponent(slug)}`}
      target="_blank"
      rel="noopener"
      className="inline-flex min-h-11 items-center gap-1 font-medium text-accent underline"
    >
      {u.newReport}
      <ExternalLink className="size-3.5 rtl:-scale-x-100" aria-hidden />
      <span className="sr-only">{t.code.newTab}</span>
    </a>
  );

  // Whose page this is comes with the report, once the code has opened it.
  // Until then nothing is known of the hospital, not even that it exists.
  const hospital = open?.view.hospital;
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

  // The reporter's plain words for where the report stands.
  const words = forReporter(t);
  const view = {
    lang,
    t: words,
    incident: open.view,
    // Names the hospital wrote, in its own language when not in the reader's.
    fallback: hospital?.defaultLocale,
    // On the organization's clock, as the report form is: "when it
    // happened" was typed on it, and staff read every time on it. An API
    // older than this page sends no clock: the device's is used.
    timeZone: hospital?.timeZone ?? deviceTime,
  };
  // Which clock that is, said only when this device shows another time.
  const timeNote =
    hospital?.timeZone && !open.sameClock
      ? fill(u.timeNote, { zone: zoneLabel(lang, hospital.timeZone) })
      : null;

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
            t={words}
            status={open.view.status}
            harmLevel={open.view.harmLevel}
            isSentinel={open.view.isSentinel}
          />
          <p className="text-base text-muted">{u.viewHelp}</p>
          {timeNote && <p className="text-sm text-muted">{timeNote}</p>}
        </div>
        <IncidentReport {...view} />
        <IncidentTimeline {...view} />
        <IncidentComments {...view}>
          {ended ? (
            // Nothing to type into: the report can be read, not added to.
            <div className="p-4 text-base">
              <p>{formOpen === false ? u.endedNoForm : u.ended}</p>
              {newReport}
            </div>
          ) : (
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
              {endedSince ? (
                // It ended while they were writing. The box stays, with
                // what they wrote in it, to copy into a new report.
                <div role="alert" className="text-base">
                  <p className="text-danger">
                    {formOpen === false ? u.endedSinceNoForm : u.endedSince}
                  </p>
                  {newReport}
                </div>
              ) : (
                <Button
                  type="submit"
                  disabled={busy}
                  className="h-12 px-5 text-base max-sm:w-full"
                >
                  {t.comments.submit}
                </Button>
              )}
            </form>
          )}
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
