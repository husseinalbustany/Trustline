"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { InviteLink } from "@/components/ui/invite-link";
import { PageHeader } from "@/components/ui/page-header";
import { dateTimeFormat } from "@/lib/format";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  ApiError,
  platformApi,
  type Activity,
  type Client,
} from "@/lib/platform-api";
import type { Invite } from "@/lib/identity";
import { hasLocale, localeNames, locales } from "@/i18n/config";
import { pick, readForm } from "@/lib/localized";
import { LocalizedField } from "@/components/ui/localized-field";
import { StatusPill } from "./status-pill";
import type { PlatformProps } from "./types";

type Loaded = Client & { activity: Activity[] };
type Message = { kind: "ok" | "error"; text: string };

function Select({
  name,
  defaultValue,
  options,
}: {
  name: string;
  defaultValue?: string;
  options: Record<string, string>;
}) {
  return (
    <select name={name} defaultValue={defaultValue} className={inputClass}>
      {Object.entries(options).map(([value, label]) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** Adds a client, or edits the one named in the route. */
export function ClientForm({
  lang,
  t,
  mode,
}: PlatformProps & { mode: "new" | "edit" }) {
  const router = useRouter();
  const { id } = useParams<{ id?: string }>();
  const [client, setClient] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  // The client's languages and default, edited here and sent with the form.
  const [langs, setLangs] = useState<string[]>([lang]);
  const [defaultLang, setDefaultLang] = useState<string>(lang);
  const adopt = (loaded: Loaded) => {
    setClient(loaded);
    setLangs(loaded.locales);
    setDefaultLang(loaded.defaultLocale);
  };
  const listPath = `/${lang}/platform/clients`;
  const f = t.form;

  useEffect(() => {
    if (mode !== "edit") return;
    platformApi<Loaded>(`/tenants/${id}`)
      .then((loaded) => {
        adopt(loaded);
        setProblem(null);
      })
      .catch((err) =>
        setProblem(
          err instanceof ApiError && err.status === 404
            ? t.notFound
            : t.loadError,
        ),
      );
  }, [mode, id, t]);

  async function save(body: Record<string, unknown>, form?: HTMLFormElement) {
    setBusy(true);
    setMessage(null);
    try {
      if (mode === "new") {
        await platformApi("/tenants", { method: "POST", body });
        // Visited pages stay mounted, so leave this one empty for next time.
        form?.reset();
        setBusy(false);
        router.push(listPath);
        return;
      }
      await platformApi(`/tenants/${id}`, { method: "PATCH", body });
      adopt(await platformApi<Loaded>(`/tenants/${id}`));
      setMessage({ kind: "ok", text: f.saved });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      const code = err instanceof ApiError ? err.code : undefined;
      setMessage({
        kind: "error",
        text:
          code === "language_mismatch"
            ? f.languageMismatch
            : status === 409
              ? f.slugTaken
              : status === 400
                ? f.invalid
                : f.error,
      });
    }
    setBusy(false);
  }

  async function createAdministrator(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    setAdminError(null);
    try {
      const created = await platformApi<{ invite: Invite }>(
        `/tenants/${id}/administrators`,
        { method: "POST", body: readForm(form) },
      );
      form.reset();
      setInvite(created.invite);
      setClient(await platformApi<Loaded>(`/tenants/${id}`));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : undefined;
      const a = t.administrator;
      setAdminError(
        code === "administrator_exists"
          ? a.exists
          : code === "client_suspended"
            ? a.suspended
            : code === "password_sign_in_disabled"
              ? a.ssoOnly
              : code === "email_taken"
                ? a.emailTaken
                : f.error,
      );
    }
    setBusy(false);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    // Languages are held in state; the rest is read from the form.
    const { slug, ...fields } = readForm(form);
    const settings = { ...fields, locales: langs, defaultLocale: defaultLang };
    void save(mode === "new" ? { slug, ...settings } : settings, form);
  }

  if (problem) return <EmptyState>{problem}</EmptyState>;
  if (mode === "edit" && !client) return <EmptyState>{t.loading}</EmptyState>;

  const suspended = client?.status === "suspended";
  const dateFormat = dateTimeFormat(lang);

  return (
    <>
      <PageHeader
        title={
          client ? pick(client.name, lang, client.defaultLocale) : f.newTitle
        }
        description={client ? undefined : f.newDescription}
        actions={
          client && (
            <StatusPill
              status={client.status}
              label={t.status[client.status]}
            />
          )
        }
      />

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <form
          key={client?.id}
          onSubmit={submit}
          className="flex flex-col gap-5 rounded-lg border border-line p-4 sm:p-6"
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">{f.locales}</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {locales.map((locale) => (
                <label key={locale} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={langs.includes(locale)}
                    // The default language cannot be switched off.
                    disabled={locale === defaultLang}
                    onChange={(e) =>
                      setLangs(
                        e.target.checked
                          ? [...langs, locale]
                          : langs.filter((l) => l !== locale),
                      )
                    }
                  />
                  {localeNames[locale]}
                </label>
              ))}
            </div>
            <p className="text-xs text-muted">{f.localesHelp}</p>
          </fieldset>

          <LocalizedField
            label={f.name}
            name="name"
            locales={langs}
            required={defaultLang}
            value={client?.name}
          />

          <Field label={f.slug} help={f.slugHelp}>
            <input
              name="slug"
              required
              pattern="[a-z0-9][a-z0-9\-]{1,38}[a-z0-9]"
              dir="ltr"
              defaultValue={client?.slug}
              disabled={mode === "edit"}
              className={`${inputClass} disabled:bg-surface disabled:text-muted`}
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={f.accreditationStandard}>
              <Select
                name="accreditationStandard"
                defaultValue={client?.accreditationStandard}
                options={{ JCI: "JCI", CBAHI: "CBAHI" }}
              />
            </Field>
            <Field label={f.defaultLocale}>
              <select
                value={defaultLang}
                onChange={(e) => setDefaultLang(e.target.value)}
                className={inputClass}
              >
                {langs.map((locale) => (
                  <option key={locale} value={locale}>
                    {hasLocale(locale) ? localeNames[locale] : locale}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={f.plan}>
              <Select
                name="plan"
                defaultValue={client?.plan}
                options={t.options.plan}
              />
            </Field>
            <Field label={f.signInMethod}>
              <Select
                name="signInMethod"
                defaultValue={client?.signInMethod}
                options={t.options.signInMethod}
              />
            </Field>
          </div>

          <Field label={f.dataRegion} help={f.dataRegionHelp}>
            <input
              name="dataRegion"
              dir="auto"
              maxLength={100}
              defaultValue={client?.dataRegion ?? ""}
              className={inputClass}
            />
          </Field>

          {message && (
            <p
              role={message.kind === "error" ? "alert" : "status"}
              className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
            >
              {message.text}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {mode === "new" ? f.create : f.save}
            </Button>
            <Link
              href={listPath}
              className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted hover:bg-surface hover:text-foreground"
            >
              {mode === "new" ? f.cancel : f.back}
            </Link>
          </div>
        </form>

        {client && (
          <div className="flex flex-col gap-6">
            <Panel title={t.status.title}>
              <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-sm text-muted">
                  {suspended ? t.status.suspendedHelp : t.status.activeHelp}
                </p>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    save({ status: suspended ? "active" : "suspended" })
                  }
                >
                  {suspended ? t.status.reactivate : t.status.suspend}
                </Button>
              </div>
            </Panel>

            <Panel title={t.administrator.title}>
              <form
                onSubmit={createAdministrator}
                className="flex flex-col gap-4 p-4"
              >
                <p className="text-sm text-muted">{t.administrator.help}</p>
                <LocalizedField
                  label={f.name}
                  name="name"
                  locales={client.locales}
                  required={client.defaultLocale}
                />
                <Field label={t.login.email}>
                  <input
                    name="email"
                    type="email"
                    required
                    dir="ltr"
                    className={inputClass}
                  />
                </Field>
                {adminError && (
                  <p role="alert" className="text-sm text-danger">
                    {adminError}
                  </p>
                )}
                <div>
                  <Button type="submit" variant="secondary" disabled={busy}>
                    {t.administrator.create}
                  </Button>
                </div>
                {invite && (
                  <InviteLink lang={lang} invite={invite} t={t.inviteLink} />
                )}
              </form>
            </Panel>

            <Panel title={t.activity.title}>
              {client.activity.length === 0 ? (
                <EmptyState>{t.activity.empty}</EmptyState>
              ) : (
                <ul className="divide-y divide-line">
                  {client.activity.map((entry) => (
                    <li key={entry.id} className="px-4 py-3 text-sm">
                      <div>
                        {t.activity.actions[
                          entry.action as keyof typeof t.activity.actions
                        ] ?? entry.action}
                      </div>
                      <div className="text-xs text-muted">
                        {[
                          entry.adminName,
                          dateFormat.format(new Date(entry.createdAt)),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}
