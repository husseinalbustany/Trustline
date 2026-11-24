"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { api } from "@/lib/api";
import { pick, type Localized } from "@/lib/localized";
import type { Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/config";
import { AuthCard } from "./auth-card";

type Info = {
  name: Localized;
  email: string;
  organization: Localized;
  defaultLocale: string;
};

const MIN_LENGTH = 12;

/** The page a set-password link opens. The link's details are after the #. */
export function InviteForm({
  lang,
  appName,
  t,
}: {
  lang: Locale;
  appName: string;
  t: Dictionary["auth"];
}) {
  const [link, setLink] = useState<{ org: string; token: string } | null>(null);
  const [info, setInfo] = useState<Info | null>(null);
  const [state, setState] = useState<"checking" | "ready" | "invalid" | "done">(
    "checking",
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.hash.slice(1));
    const found = { org: params.get("org"), token: params.get("token") };
    const check = async () => {
      if (!found.org || !found.token) throw new Error("incomplete link");
      const body = { org: found.org, token: found.token };
      return {
        body,
        data: await api<Info>("/auth/invite/check", { method: "POST", body }),
      };
    };
    check()
      .then(({ body, data }) => {
        setLink(body);
        setInfo(data);
        setState("ready");
      })
      .catch(() => setState("invalid"));
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password"));
    if (password.length < MIN_LENGTH) return setError(t.invite.tooShort);
    if (password !== data.get("confirm")) return setError(t.invite.mismatch);
    setBusy(true);
    setError(null);
    try {
      await api("/auth/invite/accept", {
        method: "POST",
        body: { ...link, password },
      });
      form.reset();
      setState("done");
    } catch {
      setError(t.invite.error);
    }
    setBusy(false);
  }

  const loginHref = `/${lang}/login${link ? `?org=${encodeURIComponent(link.org)}` : ""}`;

  if (state === "checking") {
    return (
      <AuthCard eyebrow={appName} title={t.invite.title}>
        <p className="text-sm text-muted">{t.invite.checking}</p>
      </AuthCard>
    );
  }
  if (state === "invalid") {
    return (
      <AuthCard eyebrow={appName} title={t.invite.invalidTitle}>
        <p className="text-sm text-muted">{t.invite.invalid}</p>
      </AuthCard>
    );
  }
  if (state === "done") {
    return (
      <AuthCard eyebrow={appName} title={t.invite.doneTitle}>
        <p className="text-sm text-muted">{t.invite.done}</p>
        <Link
          href={loginHref}
          className="inline-flex h-10 items-center justify-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          {t.login.submit}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard eyebrow={appName} title={t.invite.title}>
      <p className="text-sm text-muted">
        {pick(info?.name, lang, info?.defaultLocale)}
        {" · "}
        {pick(info?.organization, lang, info?.defaultLocale)}
        <br />
        <span dir="ltr">{info?.email}</span>
      </p>
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field label={t.invite.password} help={t.invite.passwordHelp}>
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={MIN_LENGTH}
            dir="ltr"
            className={inputClass}
          />
        </Field>
        <Field label={t.invite.confirm}>
          <input
            name="confirm"
            type="password"
            autoComplete="new-password"
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
          {t.invite.submit}
        </Button>
      </form>
    </AuthCard>
  );
}
