"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { api, codeOf, statusOf } from "@/lib/api";
import type { Dictionary } from "@/i18n/dictionaries";
import type { Locale } from "@/i18n/config";
import { AuthCard } from "./auth-card";
import { loadPage, returnPath } from "@/lib/navigate";
import { signedOutReasonIn } from "@/lib/signing";

/** The address does not change while the sign-in page is open. */
const noChange = () => () => {};

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
  // Sent here because the session ended while a page was open: said why,
  // for a reason this app knows. Read from the address as the page shows,
  // so the page itself stays the same for everyone.
  const reason = useSyncExternalStore(
    noChange,
    () => signedOutReasonIn(window.location.search),
    () => null,
  );
  const notice = reason ? t.login.signedOut[reason] : null;
  const orgInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // An external reviewer's second step: the code sent by email. Only the
  // challenge is kept, never the password.
  const [challenge, setChallenge] = useState<{ org: string; challenge: string } | null>(
    null,
  );
  const [restartOrg, setRestartOrg] = useState<string | undefined>(undefined);

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
      const answer = await api<{ code?: string; challenge?: string } | undefined>(
        "/auth/login",
        {
          method: "POST",
          body: {
            org,
            email: data.get("email"),
            password: data.get("password"),
          },
        },
      );
      try {
        window.localStorage.setItem(ORG_KEY, org);
      } catch {}
      // Visited pages stay mounted, so clear the password before leaving.
      form.reset();
      if (orgInput.current) orgInput.current.value = org;
      // An external reviewer: a code was emailed, and is asked for next.
      if (answer?.code === "one_time_code_sent" && answer.challenge) {
        setChallenge({ org, challenge: answer.challenge });
        setBusy(false);
        return;
      }
      enter();
      return;
    } catch (err) {
      const status = statusOf(err);
      // 400: something in the organization ID or the email that cannot be
      // in one, such as a control character pasted with it.
      setError(
        codeOf(err) === "code_not_sent"
          ? t.login.codeNotSent
          : status === 401
            ? t.login.failed
            : status === 400
              ? t.login.invalid
              : t.login.error,
      );
    }
    setBusy(false);
  }

  // A full page load, so no page from an earlier session stays mounted.
  // To the page asked for before signing in, when it is a page of the
  // hospital's app in this language; otherwise to the dashboard.
  const enter = () =>
    loadPage(
      returnPath(
        `/${lang}`,
        [`/${lang}/login`, `/${lang}/invite`, `/${lang}/platform`],
        `/${lang}/dashboard`,
      ),
    );

  async function sendCode(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!challenge) return;
    const form = e.currentTarget;
    const code = String(new FormData(form).get("code") ?? "").trim();
    form.reset();
    if (!/^\d{6}$/.test(code)) return setError(t.login.codeInvalid);
    setBusy(true);
    setError(null);
    try {
      await api("/auth/login/code", { method: "POST", body: { ...challenge, code } });
      setChallenge(null);
      enter();
      return;
    } catch (err) {
      const status = statusOf(err);
      setError(
        status === 401
          ? t.login.codeWrong
          : codeOf(err) === "code_not_sent"
            ? t.login.codeNotSent
            : status === 400
              ? t.login.codeInvalid
              : t.login.error,
      );
    }
    setBusy(false);
  }

  if (challenge) {
    return (
      <AuthCard eyebrow={appName} title={t.login.codeTitle}>
        <form onSubmit={sendCode} className="flex flex-col gap-5">
          <p className="text-sm text-muted">{t.login.codeHelp}</p>
          <Field label={t.login.code}>
            <input
              name="code"
              required
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="one-time-code"
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
            {t.login.codeSubmit}
          </Button>
          <button
            type="button"
            onClick={() => {
              setRestartOrg(challenge.org);
              setChallenge(null);
              setError(null);
            }}
            className="text-sm text-accent hover:underline"
          >
            {t.login.restart}
          </button>
        </form>
      </AuthCard>
    );
  }

  return (
    <AuthCard eyebrow={appName} title={t.login.title}>
      <form onSubmit={submit} className="flex flex-col gap-5">
        {notice && (
          <p
            role="status"
            className="rounded-md border border-warn bg-warn-soft px-3 py-2 text-sm"
          >
            {notice}
          </p>
        )}
        <Field label={t.login.org} help={t.login.orgHelp}>
          <input
            name="org"
            required
            // Back from the code step: the organization as it was typed.
            defaultValue={restartOrg}
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
