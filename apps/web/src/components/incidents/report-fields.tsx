"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass, roomyInputClass } from "@/components/ui/field";
import {
  harmLevels,
  incidentTypes,
  type HarmLevel,
  type IncidentCategory,
  type IncidentType,
} from "@/lib/incidents";
import { pick, readForm } from "@/lib/localized";
import { momentOf, wallClock, type TimeZone } from "@/lib/time-zone";
import { unitOptions, type TreeUnit } from "@/lib/org-units";
import { textareaClass, type IncidentsProps } from "./types";

/**
 * The times a report form keeps: the present minute, which is the latest
 * time it accepts and what "when" shows until the reporter changes it; the
 * time they chose, if they did; and when the form was opened, so the time a
 * report takes can be measured.
 *
 * "When" is read and written on the clock of `timeZone`: the hospital's for
 * its staff, whatever zone their device is set to, so 14:00 typed on a
 * laptop set to another country is still 14:00 at the hospital.
 */
export function useReportClock(timeZone: TimeZone) {
  const [now, setNow] = useState("");
  const [occurredAt, setOccurredAt] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);

  // "When" shows the present minute until the reporter changes it, and the
  // present moment is what is then sent. So the minute shown keeps up with
  // the clock for as long as the form is open: what the reporter sees is
  // what is stored, even on a workstation left on this page for hours.
  const tick = useCallback(
    () => setNow(wallClock(new Date(), timeZone)),
    [timeZone],
  );
  useEffect(() => {
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, [tick]);

  /** The moment the reporter chose, or null while "when" is still "now". */
  const chosen = useCallback(
    () => (occurredAt ? momentOf(occurredAt, timeZone) : null),
    [occurredAt, timeZone],
  );

  /**
   * The form is on screen: called each time it is shown, also when the
   * reporter comes back to a draft. A time they chose is theirs and stays.
   */
  const shown = useCallback(
    // `on`: the clock to show it on, when it is not yet the one this hook
    // was given (the public form learns its hospital's clock with the form).
    (on?: { timeZone: TimeZone }) => {
      setNow(wallClock(new Date(), on ? on.timeZone : timeZone));
      setStartedAt(new Date().toISOString());
    },
    [timeZone],
  );

  /** A fresh form, for the next report: "when" is the present again. */
  const start = useCallback(() => {
    setOccurredAt(null);
    shown();
  }, [shown]);

  return {
    now,
    occurredAt,
    startedAt,
    setOccurredAt,
    chosen,
    tick,
    shown,
    start,
  };
}

/** What a report form sends, whoever sends it. */
export type ReportBody = Record<string, unknown>;

/** One answer to the harm question: the level it is sent as, in words. */
export type HarmChoice = { level: HarmLevel; label: string; help?: string };

/** Severe harm or a death: the answers this form says more about. */
const serious: readonly string[] = ["severe", "death"];

/**
 * The questions of a report, the same for someone signed in and for someone
 * who is not: short enough to finish on a phone in two minutes.
 */
export function ReportFields({
  lang,
  t,
  categories,
  units,
  defaultLocale,
  startUnit,
  clock,
  timeNote,
  anonymousChoice,
  privacy,
  roomy = false,
  labels,
  harmChoices,
  seriousNote,
  unitTree = true,
  send,
  explain,
  cancel,
}: IncidentsProps & {
  categories: IncidentCategory[];
  units: TreeUnit[];
  /** The hospital's own language, for a name not written in the reader's. */
  defaultLocale: string;
  /** Where "where it happened" starts; the reporter can change it. */
  startUnit: string;
  clock: ReturnType<typeof useReportClock>;
  /** Which clock "when it happened" is typed on, said under the field. */
  timeNote: string;
  /** Whether the reporter chooses between giving their name and not. */
  anonymousChoice: boolean;
  /** Who will see the reporter's name: said before they send. */
  privacy: (anonymous: boolean) => ReactNode;
  /** Larger controls, for the page built for a phone first. */
  roomy?: boolean;
  /** Plainer words for some questions, where the reader is not staff. */
  labels?: Partial<IncidentsProps["t"]["form"]>;
  /**
   * The answers to "harm", where they are not the five levels with their
   * definitions: a reader who is not staff is asked a plainer question.
   */
  harmChoices?: HarmChoice[];
  /** Said under the harm question once severe harm or a death is chosen. */
  seriousNote?: string;
  /** False to list places by name alone, without the marks of the tree. */
  unitTree?: boolean;
  /** Sends the report. The form is emptied once this has succeeded. */
  send: (body: ReportBody, anonymous: boolean) => Promise<void>;
  explain: (err: unknown) => string;
  cancel?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The type chosen: only an incident reached someone, so only it has a
  // harm level to ask about.
  const [type, setType] = useState<IncidentType | null>(null);
  // The harm answer chosen, so that what it means can be said under it.
  const [harm, setHarm] = useState<HarmLevel | null>(null);
  const [anonymous, setAnonymous] = useState(false);
  const f = { ...t.form, ...labels };
  const { now, occurredAt, startedAt, setOccurredAt, chosen, tick } = clock;

  // Visited pages stay mounted: a refusal of the last attempt must not be
  // waiting here when the page is shown again.
  useLayoutEffect(() => () => setError(null), []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { immediateAction, ...fields } = readForm(form);
    // The tick box is read from state; whoever sends decides how to say it.
    delete fields.anonymous;
    setBusy(true);
    setError(null);
    try {
      await send(
        {
          ...fields,
          // A near miss or a hazard harmed no one, so the form does not ask.
          harmLevel: type === "incident" ? fields.harmLevel : "none",
          // Left as it was, "when" means the moment of sending. Changed, it
          // is the moment the clock named under the field showed that time.
          occurredAt: (chosen() ?? new Date()).toISOString(),
          immediateAction: immediateAction || null,
          startedAt,
        },
        anonymous,
      );
      form.reset();
      setType(null);
      setHarm(null);
      setAnonymous(false);
      setOccurredAt(null);
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  }

  const inLang = (text: IncidentCategory["name"]) =>
    pick(text, lang, defaultLocale);
  const choices =
    harmChoices ??
    harmLevels.map((level) => ({
      level,
      label: t.harm[level],
      help: t.harmHelp[level],
    }));
  // A radio card: the answer in bold, what it means under it.
  const card =
    "flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-background p-3 has-checked:border-accent has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent";
  const radio = `mt-1 shrink-0 accent-accent ${roomy ? "size-5" : "size-4"}`;
  const cardHelp = `block text-muted ${roomy ? "text-sm" : "text-xs"}`;
  const input = roomy ? roomyInputClass : inputClass;
  const area = roomy ? `${textareaClass} text-base` : textareaClass;

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{f.type}</legend>
        <div className={`grid gap-2 ${roomy ? "" : "sm:grid-cols-3"}`}>
          {incidentTypes.map((option) => (
            <label key={option} className={card}>
              <input
                type="radio"
                name="type"
                value={option}
                required
                checked={type === option}
                onChange={() => setType(option)}
                className={radio}
              />
              <span>
                <span className="block text-base font-semibold">
                  {t.type[option]}
                </span>
                <span className={cardHelp}>{t.typeHelp[option]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className={`grid gap-5 ${roomy ? "" : "sm:grid-cols-2"}`}>
        <Field label={f.category}>
          <select name="categoryId" required defaultValue="" className={input}>
            <option value="" disabled>
              {f.choose}
            </option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {inLang(c.name)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={f.where}>
          <select
            // Starts again if the unit to start from changes.
            key={startUnit}
            name="orgUnitId"
            required
            defaultValue={startUnit}
            className={input}
          >
            <option value="" disabled>
              {f.choose}
            </option>
            {unitOptions(units, (u) => inLang(u.name), null, unitTree).map(
              (u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ),
            )}
          </select>
        </Field>
      </div>

      <Field label={f.occurredAt} help={`${f.occurredAtHelp} ${timeNote}`}>
        <input
          type="datetime-local"
          required
          dir="ltr"
          // The API takes nothing before 1900: a mistyped year is caught here.
          min="1900-01-01T00:00"
          max={now}
          value={occurredAt ?? now}
          onFocus={tick}
          onChange={(e) => setOccurredAt(e.target.value)}
          className={`${input} sm:max-w-xs`}
        />
      </Field>

      <Field label={f.description} help={f.descriptionHelp}>
        <textarea
          name="description"
          required
          rows={5}
          maxLength={5000}
          dir="auto"
          className={area}
        />
      </Field>

      <Field label={f.immediateAction} help={f.immediateActionHelp}>
        <textarea
          name="immediateAction"
          rows={2}
          maxLength={2000}
          dir="auto"
          className={area}
        />
      </Field>

      {/* Asked once the type is known, and only of an incident: a near miss
          or a hazard reached no one. */}
      {type === "incident" && (
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{f.harmLevel}</legend>
          <div className="grid gap-2">
            {choices.map((choice) => (
              <label key={choice.level} className={card}>
                <input
                  type="radio"
                  name="harmLevel"
                  value={choice.level}
                  required
                  checked={harm === choice.level}
                  onChange={() => setHarm(choice.level)}
                  className={radio}
                />
                <span>
                  <span className="block text-base font-semibold">
                    {choice.label}
                  </span>
                  {choice.help && (
                    <span className={cardHelp}>{choice.help}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
          {seriousNote && harm && serious.includes(harm) && (
            <p
              role="status"
              className="mt-3 rounded-lg border border-line bg-background p-3 text-sm"
            >
              {seriousNote}
            </p>
          )}
        </fieldset>
      )}

      {/* Who will see the reporter's name, before they send. */}
      {anonymousChoice ? (
        <div className="rounded-lg border border-line p-3 text-sm has-checked:border-accent has-checked:bg-accent-soft">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="anonymous"
              checked={anonymous}
              onChange={(e) => setAnonymous(e.target.checked)}
              className="mt-0.5 size-4 shrink-0 accent-accent"
            />
            <span className="font-medium">{f.anonymous}</span>
          </label>
          <p role="status" className="ms-7 mt-1">
            {privacy(anonymous)}
          </p>
        </div>
      ) : (
        <p className="rounded-lg border border-line bg-background p-3 text-sm">
          {privacy(true)}
        </p>
      )}

      {error && (
        <p
          role="alert"
          // A refusal may be two sentences on two lines.
          className={`whitespace-pre-line text-danger ${roomy ? "text-base" : "text-sm"}`}
        >
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={busy}
          className={
            roomy ? "h-12 w-full px-5 text-base" : "h-11 px-5 max-sm:w-full"
          }
        >
          {f.submit}
        </Button>
        {cancel}
      </div>
    </form>
  );
}
