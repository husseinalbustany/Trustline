"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useState, type ReactNode } from "react";
import { FollowUpCode } from "@/components/incidents/follow-up-code";
import {
  ReportFields,
  useReportClock,
  type ReportBody,
} from "@/components/incidents/report-fields";
import type { IncidentsText } from "@/components/incidents/types";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/i18n/config";
import type { Dictionary } from "@/i18n/dictionaries";
import { api, codeOf, retryAfterOf, statusOf } from "@/lib/api";
import { clockTimeIn, fill } from "@/lib/format";
import { followUpUrl } from "@/lib/identity";
import type { PublicReporting, ReportSent } from "@/lib/incidents";
import { pick } from "@/lib/localized";
import { deviceTime, zoneLabel } from "@/lib/time-zone";
import { PublicFrame } from "./public-frame";

/**
 * Reporting an incident without signing in: the page a link or a QR code on
 * a ward opens, on a phone more often than not.
 *
 * `slug` and `unit` come from the server page, not from the router hooks: a
 * page kept mounted behind another one is re-rendered with that one's
 * address.
 */
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
  const [problem, setProblem] = useState<"unavailable" | "error" | null>(null);
  // The follow-up code of the report just sent: kept here and nowhere else,
  // and only until this page is left.
  const [code, setCode] = useState<string | null>(null);
  // The form is told nothing of the hospital's clock, and its reader is not
  // staff: "when it happened" is typed on the clock of their own device,
  // and the form says so.
  const clock = useReportClock(deviceTime);
  const { shown, start } = clock;
  const followUpPath = `/${lang}/follow-up/${slug}`;

  useEffect(() => {
    let current = true;
    api<PublicReporting>(`/public/reporting/${encodeURIComponent(slug)}`, {
      withoutSession: true,
    })
      .then((loaded) => {
        if (!current) return;
        setForm(loaded);
        setProblem(null);
        shown();
      })
      .catch(
        (err) =>
          current &&
          // A hospital that does not exist, is suspended or has not switched
          // this on: one answer, and one page, for all three.
          setProblem(statusOf(err) === 404 ? "unavailable" : "error"),
      );
    return () => {
      current = false;
    };
  }, [slug, shown]);

  // Visited pages stay mounted. The code is shown once: it is gone as soon
  // as this page is left, whichever way.
  useLayoutEffect(() => () => setCode(null), []);

  async function send(body: ReportBody) {
    const sent = await api<ReportSent>(
      `/public/reporting/${encodeURIComponent(slug)}`,
      { method: "POST", body, withoutSession: true },
    );
    setCode(sent.followUpCode ?? "");
  }

  const clockTime = clockTimeIn(lang);
  // The form's own answers to a refusal. None of them is the staff wording:
  // "reload the page" would throw away what this reader has written.
  const refusal = (err: unknown) => {
    const status = statusOf(err);
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
  const notice = (title: string, text?: string) =>
    frame(
      <div className="rounded-lg border border-line bg-background p-5">
        <h1 className="text-xl font-semibold">{title}</h1>
        {text && <p className="mt-2 text-base text-muted">{text}</p>}
      </div>,
    );

  // A hospital with nowhere to say it happened cannot take a report.
  if (problem === "unavailable" || form?.orgUnits.length === 0) {
    return notice(p.unavailableTitle, p.unavailable);
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
        timeNote={fill(p.deviceTime, { zone: zoneLabel(lang, deviceTime) })}
        anonymousChoice={false}
        privacy={() => p.privacy}
        roomy
        labels={p.form}
        unitTree={false}
        send={send}
        explain={refusal}
      />
      <p className="border-t border-line pt-4 text-base">
        {p.haveCode}{" "}
        <Link
          href={followUpPath}
          className="inline-flex min-h-11 items-center font-medium text-accent underline"
        >
          {p.followUp}
        </Link>
      </p>
    </div>,
  );
}
