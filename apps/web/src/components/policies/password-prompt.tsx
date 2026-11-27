"use client";

import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { codeOf } from "@/lib/api";
import { textareaClass, type PoliciesText } from "./types";

/**
 * A signature: the person types their password again, and it goes with the
 * one request that needs it. The password lives only in the input: it is
 * never kept in state, never put in the address (the form posts, and only
 * by script), and the input is emptied as soon as the answer comes, right
 * or wrong, and whenever the page is hidden.
 */
export function PasswordPrompt({
  t,
  intro,
  confirm,
  submit,
  onCancel,
  comment,
  children,
  explainError,
}: {
  t: PoliciesText;
  /** What is being signed, in a sentence. */
  intro: ReactNode;
  /** The words on the button: what happens. */
  confirm: string;
  /** Sends the request; throws what the API answered when refused. */
  submit: (password: string, comment: string) => Promise<void>;
  /** What to say for a refusal that is not about the password. */
  explainError: (err: unknown) => string;
  onCancel?: () => void;
  /** An optional comment that goes with the signature, and its label. */
  comment?: { label: string; help?: string };
  /** Shown above the password: a box to tick, for instance. */
  children?: ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const data = new FormData(el);
    const password = String(data.get("password") ?? "");
    const note = String(data.get("comment") ?? "");
    setBusy(true);
    setError(null);
    let said: string | null = null;
    try {
      await submit(password, note);
    } catch (err) {
      const code = codeOf(err);
      said =
        code === "wrong_password"
          ? t.errors.wrong_password
          : code === "password_locked"
            ? t.errors.password_locked
            : explainError(err);
    }
    // Emptied whatever the answer: a password is typed for one request.
    const input = el.elements.namedItem("password");
    if (input instanceof HTMLInputElement) input.value = "";
    if (!said) el.reset();
    setError(said);
    setBusy(false);
  }

  return (
    <form
      ref={form}
      method="post"
      onSubmit={send}
      className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="text-sm">{intro}</div>
      {children}
      {comment && (
        <Field label={comment.label} help={comment.help}>
          <textarea
            name="comment"
            rows={2}
            maxLength={1000}
            dir="auto"
            className={textareaClass}
          />
        </Field>
      )}
      <Field label={t.signature.password} help={t.signature.passwordHelp}>
        <input
          name="password"
          type="password"
          required
          autoComplete="current-password"
          maxLength={1024}
          dir="ltr"
          className={inputClass}
        />
      </Field>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? t.signature.signing : confirm}
        </Button>
        {onCancel && (
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t.actions.cancel}
          </Button>
        )}
      </div>
    </form>
  );
}
