"use client";

import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { FollowUpCode } from "@/components/incidents/follow-up-code";
import {
  ReportFields,
  useReportClock,
  type HarmChoice,
  type ReportBody,
} from "@/components/incidents/report-fields";
import type { IncidentsText } from "@/components/incidents/types";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, codeOf, retryAfterOf, statusOf } from "@/lib/api";
import { clockTimeAt, clockTimeIn, fill } from "@/lib/format";
import { followUpUrl } from "@/lib/identity";
import type { PublicReporting, ReportSent } from "@/lib/incidents";
import { pick } from "@/lib/localized";
import {
  deviceTime,
  wallClock,
  zoneLabel,
  type TimeZone,
} from "@/lib/time-zone";
import { PublicFrame } from "./public-frame";

/**
 * Reporting an incident without signing in: the page a link or a QR code on
 * a ward opens, on a phone more often than not.
 *
 * `slug` and `unit` come from the server page, not from the router hooks: a
 * page kept mounted behind another one is re-rendered with that one's
 * address.
 */
/**
 * "Try again in a second": another report to the same hospital was being
 * stored when this one arrived. Any other 429 asks for longer.
 */
const busyNow = (err: unknown) => {
  const wait = retryAfterOf(err);
  return statusOf(err) === 429 && wait !== undefined && wait <= 1;
};

export function PublicReport({
  lang,
  appName,
  languageLabel,
  t,
  p,
  slug,
  unit,
}: {
  lang: Locale;
  appName: string;
  languageLabel: string;
  t: IncidentsText;
  p: Dictionary["publicReport"];
  slug: string;
  /** The unit a ward's own link starts the form on. */
  unit?: string;
}) {
  const [form, setForm] = useState<PublicReporting | null>(null);
  const [problem, setProblem] = useState<
    "unavailable" | "error" | { tooMany: number | undefined } | null
  >(null);
  // The follow-up code of the report just sent: kept here and nowhere else,
  // and only until this page is left.
  const [code, setCode] = useState<string | null>(null);
  // "When it happened" is typed and sent on the hospital's clock, as on the
  // staff form, whatever zone the sender's phone is set to. The form says
  // which clock that is only when the phone's differs: a visitor otherwise
  // just reads the time on their phone.
  const zone: TimeZone = form?.timeZone ?? deviceTime;
  const [sameClock, setSameClock] = useState(true);
  // When a paused form takes reports again: worked out once, when the form
  // arrives, so the time shown does not move on each time the page is drawn.
  const [resumesAt, setResumesAt] = useState<Date | null>(null);
  const clock = useReportClock(zone);
  const { shown, start } = clock;
  // Called when the form arrives, without asking for it again each time the
  // clock it is shown on changes: every GET counts against a limit.
  const shownOn = useRef(shown);
  useLayoutEffect(() => {
    shownOn.current = shown;
  });
  const followUpPath = `/${lang}/follow-up/${slug}`;

  useEffect(() => {
    let current = true;
    api<PublicReporting>(`/public/reporting/${encodeURIComponent(slug)}`, {
      withoutSession: true,
    })
      .then((loaded) => {
        if (!current) return;
        const now = new Date();
        const hospitalZone = loaded.timeZone ?? deviceTime;
        setForm(loaded);
        setSameClock(
          wallClock(now, hospitalZone) === wallClock(now, deviceTime),
        );
        setResumesAt(
          loaded.paused && loaded.retryAfterSeconds
            ? new Date(now.getTime() + loaded.retryAfterSeconds * 1000)
            : null,
        );
        setProblem(null);
        shownOn.current({ timeZone: hospitalZone });
      })
      .catch((err) => {
        if (!current) return;
        const status = statusOf(err);
        setProblem(
          // The form has been asked for too often from this address: it is
          // there, and can be opened again a little later.
          status === 429
            ? { tooMany: retryAfterOf(err) }
            : // A hospital that does not exist, is suspended or has not
              // switched this on: one answer, and one page, for all three.
              status === 404
              ? "unavailable"
              : "error",
        );
      });
    return () => {
      current = false;
    };
  }, [slug]);

  // Visited pages stay mounted. The code is shown once: it is gone as soon
  // as this page is left, whichever way.
  useLayoutEffect(() => () => setCode(null), []);

  async function send(body: ReportBody) {
    const post = () =>
      api<ReportSent>(`/public/reporting/${encodeURIComponent(slug)}`, {
        method: "POST",
        body,
        withoutSession: true,
      });
    let sent: ReportSent;
    try {
      sent = await post();
    } catch (err) {
      // Another report to this hospital was being stored at that moment.
      // Sent again once, a second later, with the same answers; the button
      // stays busy meanwhile. Refused again, the reader is told (below).
      if (!busyNow(err)) throw err;
      await new Promise((done) => setTimeout(done, 1000));
      sent = await post();
    }
    setCode(sent.followUpCode ?? "");
  }

  // When to try again, on the clock every other time on the form is on:
  // the organization's once the form has arrived (the form says which clock
  // that is), and this device's when it could not be opened, when nothing is
  // known of the organization and nothing is said about clocks.
  const clockTime = clockTimeIn(lang, zone);
  // The form's own answers to a refusal. None of them is the staff wording:
  // "reload the page" would throw away what this reader has written.
  const refusal = (err: unknown) => {
    const status = statusOf(err);
    // Still busy after the second try: nothing is wrong with the report.
    if (busyNow(err)) return `${p.busy}\n${p.urgent}`;
    if (status === 429) {
      const wait = retryAfterOf(err);
      const tooMany = wait
        ? fill(p.tooMany, { time: clockTime(wait) })
        : p.tooManyLater;
      // Someone who cannot send now is told again what to do if it is
      // urgent, on a line of its own.
      return `${tooMany}\n${p.urgent}`;
    }
    // Switched off while the form was open.
    if (status === 404) return p.notSent;
    const code = codeOf(err);
    if (code && Object.hasOwn(p.errors, code)) {
      return p.errors[code as keyof typeof p.errors];
    }
    return status === 400 ? p.errors.invalid : p.errors.generic;
  };

  const hospital = form ? (
    <bdi>{pick(form.name, lang, form.defaultLocale)}</bdi>
  ) : (
    appName
  );
  const frame = (children: ReactNode, languages = true) => (
    <PublicFrame
      lang={lang}
      heading={hospital}
      languageLabel={languageLabel}
      query={unit ? `?unit=${encodeURIComponent(unit)}` : ""}
      languages={languages}
    >
      {children}
    </PublicFrame>
  );
  const notice = (title: string, text?: string, more?: string) =>
    frame(
      <div className="rounded-lg border border-line bg-background p-5">
        <h1 className="text-xl font-semibold">{title}</h1>
        {text && <p className="mt-2 text-base text-muted">{text}</p>}
        {more && <p className="mt-3 text-base">{more}</p>}
      </div>,
    );

  // A hospital with nowhere to say it happened cannot take a report.
  if (problem === "unavailable" || form?.orgUnits.length === 0) {
    return notice(p.unavailableTitle, p.unavailable);
  }
  if (problem && typeof problem === "object") {
    // Someone who cannot open the form now is told what to do if it is
    // urgent, as on the form itself.
    return notice(
      p.loadTooManyTitle,
      problem.tooMany
        ? fill(p.loadTooMany, { time: clockTime(problem.tooMany) })
        : p.loadTooManyLater,
      p.urgent,
    );
  }
  if (problem) return notice(p.loadErrorTitle, p.loadError);
  if (!form) return notice(t.loading);

  if (code !== null) {
    // No language links here: changing language leaves the page, and the
    // code with it.
    return frame(
      <div className="flex flex-col gap-4">
        <div
          role="status"
          className="rounded-lg border border-accent bg-accent-soft p-4"
        >
          <h1 className="text-xl font-semibold">{p.sentTitle}</h1>
          <p className="mt-1 text-base">{p.sentHelp}</p>
        </div>
        {code && (
          <FollowUpCode
            t={t.code}
            code={code}
            followUpHref={followUpPath}
            followUpAddress={followUpUrl(slug)}
          />
        )}
        <Button
          variant="secondary"
          className="h-12 bg-background px-5 text-base"
          onClick={() => {
            setCode(null);
            start();
          }}
        >
          {p.another}
        </Button>
      </div>,
      false,
    );
  }

  // Coming back to a report already sent works whether or not the form
  // takes new ones.
  const followUpLine = (
    <p className="border-t border-line pt-4 text-base">
      {p.haveCode}{" "}
      <Link
        href={followUpPath}
        className="inline-flex min-h-11 items-center font-medium text-accent underline"
      >
        {p.followUp}
      </Link>
    </p>
  );
  // Which clock a time is on, said only when this device shows another.
  const clockNote = !sameClock && (
    <p className="mt-2 text-sm text-muted">
      {fill(p.timeNote, { zone: zoneLabel(lang, zone) })}
    </p>
  );

  // Too many reports this hour: said before anyone starts writing, with
  // when it takes reports again and what to do if it is urgent.
  if (form.paused) {
    return frame(
      <div className="flex flex-col gap-5">
        <div className="rounded-lg border border-line bg-background p-5">
          <h1 className="text-xl font-semibold">{p.pausedTitle}</h1>
          <p className="mt-2 text-base text-muted">
            {resumesAt
              ? fill(p.paused, { time: clockTimeAt(lang, zone)(resumesAt) })
              : p.pausedLater}
          </p>
          {resumesAt && clockNote}
          <p className="mt-3 text-base">{p.urgent}</p>
        </div>
        {followUpLine}
      </div>,
    );
  }

  // A plain question for someone who is not staff, sent as three of the
  // five levels; whoever triages it sets the level.
  const harmChoices: HarmChoice[] = (
    ["none", "moderate", "severe"] as const
  ).map((level) => ({ level, label: p.harm[level] }));

  // The unit a ward's link names, when the hospital still has it.
  const startUnit = form.orgUnits.find((u) => u.id === unit)?.id ?? "";

  return frame(
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold ltr:tracking-tight">{p.title}</h1>
        <p className="mt-1 text-base text-muted">{p.description}</p>
        <p className="mt-3 text-base">{t.form.intro}</p>
        {/* Before they write: nobody is watching this form for emergencies. */}
        <p className="mt-3 rounded-lg border border-line bg-background p-3 text-sm">
          {p.urgent}
        </p>
      </div>
      <ReportFields
        lang={lang}
        t={t}
        categories={form.categories}
        units={form.orgUnits}
        defaultLocale={form.defaultLocale}
        startUnit={startUnit}
        clock={clock}
        timeNote={
          sameClock
            ? p.deviceTime
            : fill(t.form.hospitalTime, { zone: zoneLabel(lang, zone) })
        }
        anonymousChoice={false}
        privacy={() => p.privacy}
        roomy
        labels={p.form}
        harmChoices={harmChoices}
        unitTree={false}
        send={send}
        explain={refusal}
      />
      {followUpLine}
    </div>,
  );
}
