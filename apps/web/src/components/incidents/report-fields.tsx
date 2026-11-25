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
  type IncidentCategory,
  type IncidentType,
} from "@/lib/incidents";
import { pick, readForm } from "@/lib/localized";
import { unitOptions, type TreeUnit } from "@/lib/org-units";
import { textareaClass, type IncidentsProps } from "./types";

const two = (n: number) => String(n).padStart(2, "0");
/** A moment as a `datetime-local` input writes it, in the user's own time. */
const localMinute = (d: Date) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;

/**
 * The times a report form keeps: the present minute, which is the latest
 * time it accepts and what "when" shows until the reporter changes it; the
 * time they chose, if they did; and when the form was opened, so the time a
 * report takes can be measured.
 */
export function useReportClock() {
  const [now, setNow] = useState("");
  const [occurredAt, setOccurredAt] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<string | null>(null);

  // "When" shows the present minute until the reporter changes it, and the
  // present moment is what is then sent. So the minute shown keeps up with
  // the clock for as long as the form is open: what the reporter sees is
  // what is stored, even on a workstation left on this page for hours.
  const tick = useCallback(() => setNow(localMinute(new Date())), []);
  useEffect(() => {
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, [tick]);

  /**
   * The form is on screen: called each time it is shown, also when the
   * reporter comes back to a draft. A time they chose is theirs and stays.
   */
  const shown = useCallback(() => {
    setNow(localMinute(new Date()));
    setStartedAt(new Date().toISOString());
  }, []);

  /** A fresh form, for the next report: "when" is the present again. */
  const start = useCallback(() => {
    setOccurredAt(null);
    shown();
  }, [shown]);

  return { now, occurredAt, startedAt, setOccurredAt, tick, shown, start };
}

/** What a report form sends, whoever sends it. */
export type ReportBody = Record<string, unknown>;

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
  anonymousChoice,
  privacy,
  roomy = false,
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
  /** Whether the reporter chooses between giving their name and not. */
  anonymousChoice: boolean;
  /** Who will see the reporter's name: said before they send. */
  privacy: (anonymous: boolean) => ReactNode;
  /** Larger controls, for the page built for a phone first. */
  roomy?: boolean;
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
  const [anonymous, setAnonymous] = useState(false);
  const f = t.form;
  const { now, occurredAt, startedAt, setOccurredAt, tick } = clock;

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
          // Left as it was, "when" means the moment of sending.
          occurredAt: (occurredAt
            ? new Date(occurredAt)
            : new Date()
          ).toISOString(),
          immediateAction: immediateAction || null,
          startedAt,
        },
        anonymous,
      );
      form.reset();
      setType(null);
      setAnonymous(false);
      setOccurredAt(null);
    } catch (err) {
      setError(explain(err));
    }
    setBusy(false);
  }

  const inLang = (text: IncidentCategory["name"]) =>
    pick(text, lang, defaultLocale);
  const input = roomy ? roomyInputClass : inputClass;
  const area = roomy ? `${textareaClass} text-base` : textareaClass;

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium">{f.type}</legend>
        <div className={`grid gap-2 ${roomy ? "" : "sm:grid-cols-3"}`}>
          {incidentTypes.map((option) => (
            <label
              key={option}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-line bg-background p-3 has-checked:border-accent has-checked:bg-accent-soft has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent"
            >
              <input
                type="radio"
                name="type"
                value={option}
                required
                checked={type === option}
                onChange={() => setType(option)}
                className={`mt-1 shrink-0 accent-accent ${roomy ? "size-5" : "size-4"}`}
              />
              <span>
                <span className="block text-base font-semibold">
                  {t.type[option]}
                </span>
                <span
                  className={`block text-muted ${roomy ? "text-sm" : "text-xs"}`}
                >
                  {t.typeHelp[option]}
                </span>
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
            {unitOptions(units, (u) => inLang(u.name)).map((u) => (
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

      <Field label={f.immediateAction}>
        <textarea
          name="immediateAction"
          rows={2}
          maxLength={2000}
          dir="auto"
          className={area}
        />
      </Field>

      {type !== "near_miss" && type !== "hazard" && (
        <Field label={f.harmLevel}>
          <select
            name="harmLevel"
            required
            defaultValue=""
            className={`${input} sm:max-w-xs`}
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
          className={`text-danger ${roomy ? "text-base" : "text-sm"}`}
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
