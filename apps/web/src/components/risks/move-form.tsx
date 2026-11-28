"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import type { Localized } from "@/lib/localized";
import { isStale } from "@/lib/risks";
import { textareaClass, type RisksText } from "./types";

/**
 * One thing to do, as a form under the risk: sends, says why when refused,
 * and is emptied once done, or whenever the page is hidden.
 */
export function MoveForm<T>({
  t,
  title,
  intro,
  confirm,
  onSubmit,
  onDone,
  onClose,
  onStale,
  explain,
  children,
  tone = "surface",
}: {
  t: RisksText;
  title: string;
  intro?: ReactNode;
  confirm: string;
  onSubmit: (data: FormData) => Promise<T>;
  onDone: (answer: T) => void;
  onClose: () => void;
  /** The page shows an older state than the API's: read it again. */
  onStale: () => Promise<void>;
  explain: (err: unknown) => string;
  children?: ReactNode;
  tone?: "surface" | "warn";
}) {
  const form = useRef<HTMLFormElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);
  // Hidden pages stay mounted: nothing typed, and no refusal, waits there.
  useLayoutEffect(() => {
    const kept = form.current;
    return () => {
      kept?.reset();
      setError(null);
    };
  }, []);

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const el = e.currentTarget;
    setBusy(true);
    setError(null);
    try {
      const answer = await onSubmit(new FormData(el));
      el.reset();
      setBusy(false);
      onDone(answer);
      onClose();
      return;
    } catch (err) {
      if (isStale(err)) {
        el.reset();
        await onStale();
        setBusy(false);
        onClose();
        return;
      }
      setError(explain(err));
    }
    setBusy(false);
  }

  return (
    <form
      ref={form}
      onSubmit={send}
      className={`flex flex-col gap-4 rounded-lg border p-4 ${
        tone === "warn" ? "border-warn bg-warn-soft" : "border-line bg-surface"
      }`}
    >
      <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">
        {title}
      </h2>
      {intro && <div className="text-sm">{intro}</div>}
      {children}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t.saving : confirm}
        </Button>
        <Button variant="secondary" onClick={onClose} disabled={busy}>
          {t.cancel}
        </Button>
      </div>
    </form>
  );
}

/** A reason or a note, written in one language. */
export function TextBox({
  label,
  help,
  name,
  required = true,
  max = 1000,
  rows = 3,
}: {
  label: string;
  help?: string;
  name: string;
  required?: boolean;
  max?: number;
  rows?: number;
}) {
  return (
    <Field label={label} help={help}>
      <textarea
        name={name}
        required={required}
        rows={rows}
        maxLength={max}
        dir="auto"
        className={textareaClass}
      />
    </Field>
  );
}

export function DayBox({
  label,
  help,
  name,
  required = false,
  min,
  max,
  value,
}: {
  label: string;
  help?: string;
  name: string;
  required?: boolean;
  min?: string;
  max?: string;
  value?: string | null;
}) {
  return (
    <Field label={label} help={help}>
      <input
        type="date"
        name={name}
        required={required}
        min={min}
        max={max}
        defaultValue={value ?? ""}
        dir="ltr"
        className={`${inputClass} sm:max-w-56`}
      />
    </Field>
  );
}

/** A trimmed text from the form; undefined when left empty. */
export function textOf(data: FormData, name: string): string | undefined {
  const value = String(data.get(name) ?? "").trim();
  return value || undefined;
}

/** A text per language from the form; null when every one is empty. */
export function localizedOf(
  data: FormData,
  name: string,
  locales: string[],
): Localized | null {
  const out: Localized = {};
  for (const locale of locales) {
    const value = String(data.get(`${name}.${locale}`) ?? "").trim();
    if (value) out[locale] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Lines or commas into a list, without blanks or repeats. */
export function listOf(data: FormData, name: string): string[] {
  return [
    ...new Set(
      String(data.get(name) ?? "")
        .split(/[\n,،]/)
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}
