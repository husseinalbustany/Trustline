"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { api, statusOf } from "@/lib/api";
import type { Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/config";
import { AuthCard } from "./auth-card";
import { loadPage, returnPath } from "@/lib/navigate";

const ORG_KEY = "trustline.org";

export function LoginForm({
  lang,
  appName,
  t,
}: {
  lang: Locale;
  appName: string;
  t: Dictionary["auth"];
}) {
  const orgInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Prefill the organization from the link the hospital shares (?org=), or
  // from the last sign-in on this browser.
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).get("org");
    let remembered: string | null = null;
    try {
      remembered = window.localStorage.getItem(ORG_KEY);
    } catch {}
    const value = fromLink ?? remembered;
    if (value && orgInput.current && !orgInput.current.value) {
      orgInput.current.value = value;
    }
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const org = String(data.get("org")).trim();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login", {
        method: "POST",
        body: {
          org,
          email: data.get("email"),
          password: data.get("password"),
        },
      });
      try {
        window.localStorage.setItem(ORG_KEY, org);
      } catch {}
      // Visited pages stay mounted, so clear the password before leaving.
      form.reset();
      if (orgInput.current) orgInput.current.value = org;
      // A full page load, so no page from an earlier session stays mounted.
      // To the page asked for before signing in, when it is a page of the
      // hospital's app in this language; otherwise to the dashboard.
      loadPage(
        returnPath(
          `/${lang}`,
          [`/${lang}/login`, `/${lang}/invite`, `/${lang}/platform`],
          `/${lang}/dashboard`,
        ),
      );
      return;
    } catch (err) {
      const status = statusOf(err);
      // 400: something in the organization ID or the email that cannot be
      // in one, such as a control character pasted with it.
      setError(
        status === 401
          ? t.login.failed
          : status === 400
            ? t.login.invalid
            : t.login.error,
      );
    }
    setBusy(false);
  }

  return (
    <AuthCard eyebrow={appName} title={t.login.title}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label={t.login.org} help={t.login.orgHelp}>
          <input
            name="org"
            required
            dir="ltr"
            autoCapitalize="none"
            ref={orgInput}
            className={inputClass}
          />
        </Field>
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
        <p className="text-xs text-muted">{t.login.forgot}</p>
      </form>
    </AuthCard>
  );
}
