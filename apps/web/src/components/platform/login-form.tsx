"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { ApiError, platformApi } from "@/lib/platform-api";
import type { PlatformProps } from "./types";
import { loadPage } from "@/lib/navigate";

export function LoginForm({ lang, t }: PlatformProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formElement = e.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError(null);
    try {
      await platformApi("/auth/login", {
        method: "POST",
        body: { email: form.get("email"), password: form.get("password") },
      });
      // Visited pages stay mounted, so clear the password before leaving.
      formElement.reset();
      // A full page load, so no page from an earlier session stays mounted.
      loadPage(`/${lang}/platform/clients`);
      return;
    } catch (err) {
      const refused = err instanceof ApiError && err.status === 401;
      setError(refused ? t.login.failed : t.login.error);
    }
    setBusy(false);
  }

  return (
    <main className="flex flex-1 items-center justify-center bg-surface px-4 py-12">
      <form
        onSubmit={submit}
        className="flex w-full max-w-sm flex-col gap-5 rounded-lg border border-line bg-background p-6"
      >
        <div>
          <p className="text-sm font-medium text-accent">{t.title}</p>
          <h1 className="mt-1 text-xl font-semibold ltr:tracking-tight">
            {t.login.title}
          </h1>
        </div>
        <Field label={t.login.email}>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            dir="ltr"
            className={inputClass}
          />
        </Field>
        <Field label={t.login.password}>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            dir="ltr"
            className={inputClass}
          />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy} className="h-10">
          {t.login.submit}
        </Button>
      </form>
    </main>
  );
}
