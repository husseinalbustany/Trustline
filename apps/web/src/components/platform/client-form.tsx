"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { InviteLink } from "@/components/ui/invite-link";
import { PageHeader } from "@/components/ui/page-header";
import { dateTimeFormat, fill } from "@/lib/format";
import { deviceTime } from "@/lib/time-zone";
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
import { limitOf } from "@/lib/api";
import { numberFormat } from "@/lib/format";
import type { Plan } from "@/lib/platform-api";
import { ClientImportWindow } from "./client-import-window";
import { ClientSubscription } from "./client-subscription";
import type { ModuleNames } from "./module-words";
import { StatusPill } from "./status-pill";
import { TimeZoneField } from "./time-zone-field";
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
  moduleNames,
}: PlatformProps & { mode: "new" | "edit"; moduleNames: ModuleNames }) {
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
  // The hospital's own clock. UTC until one is chosen, as the API has it.
  const [timeZone, setTimeZone] = useState("UTC");
  // The plans a new client can start on: those not retired.
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [plansFailed, setPlansFailed] = useState(false);
  const adopt = (loaded: Loaded) => {
    setClient(loaded);
    setLangs(loaded.locales);
    setDefaultLang(loaded.defaultLocale);
    setTimeZone(loaded.timeZone ?? "UTC");
  };
  const listPath = `/${lang}/platform/clients`;
  const f = t.form;

  useEffect(() => {
    if (mode !== "new") return;
    let current = true;
    platformApi<Plan[]>("/plans")
      .then((list) => {
        if (!current) return;
        setPlans(list.filter((p) => p.active));
        setPlansFailed(false);
      })
      .catch(() => current && setPlansFailed(true));
    return () => {
      current = false;
    };
  }, [mode]);

  // The client read again, for its activity after its subscription changed.
  const reload = () =>
    platformApi<Loaded>(`/tenants/${id}`)
      .then(setClient)
      .catch(() => {});

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
        setTimeZone("UTC");
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
            : code === "unknown_plan" ||
                code === "plan_retired" ||
                code === "plan_required"
              ? f.planErrors[code]
              : code === "unknown_time_zone"
                ? f.timeZone.unknown
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
                : code === "subscription_cancelled"
                  ? a.cancelled
                  : limitOf(err)
                    ? fill(a.limitReached, {
                        max: numberFormat(lang).format(limitOf(err)?.max ?? 0),
                      })
                    : f.error,
      );
    }
    setBusy(false);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    // Languages and the time zone are held in state; the rest is read from
    // the form.
    const { slug, ...fields } = readForm(form);
    const settings = {
      ...fields,
      locales: langs,
      defaultLocale: defaultLang,
      timeZone,
    };
    void save(mode === "new" ? { slug, ...settings } : settings, form);
  }

  if (problem) return <EmptyState>{problem}</EmptyState>;
  if (mode === "edit" && !client) return <EmptyState>{t.loading}</EmptyState>;

  const suspended = client?.status === "suspended";
  // The portal belongs to no hospital: its own dates are on the clock of
  // whoever is reading them.
  const dateFormat = dateTimeFormat(lang, deviceTime);

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
        <div className="flex min-w-0 flex-col gap-6">
          <form
            key={client?.id}
            onSubmit={submit}
            className="flex flex-col gap-5 rounded-lg border border-line p-4 sm:p-6"
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{f.locales}</legend>
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {locales.map((locale) => (
                  <label
                    key={locale}
                    className="flex items-center gap-2 text-sm"
                  >
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
              {mode === "new" && (
                <Field
                  label={f.plan}
                  help={plansFailed ? f.plansError : f.planHelp}
                >
                  <select
                    name="planId"
                    required
                    defaultValue=""
                    className={inputClass}
                  >
                    <option value="" disabled>
                      {plans ? f.choosePlan : t.loading}
                    </option>
                    {plans?.map((p) => (
                      <option key={p.id} value={p.id}>
                        {pick(p.name, lang)}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={f.signInMethod}>
                <Select
                  name="signInMethod"
                  defaultValue={client?.signInMethod}
                  options={t.options.signInMethod}
                />
              </Field>
            </div>

            <TimeZoneField
              lang={lang}
              t={f.timeZone}
              value={timeZone}
              onChange={setTimeZone}
            />

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
            <ClientSubscription
              lang={lang}
              t={t}
              moduleNames={moduleNames}
              tenantId={client.id}
              clientName={pick(client.name, lang, client.defaultLocale)}
              onChanged={reload}
            />
          )}
        </div>

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

            <ClientImportWindow
              lang={lang}
              t={t}
              tenantId={client.id}
              onChanged={reload}
            />

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
                      {/* The name and the date each kept whole: a Latin
                          name must not tear an Arabic date apart. */}
                      <div className="text-xs text-muted">
                        {entry.adminName && (
                          <>
                            <bdi>{entry.adminName}</bdi>
                            {" · "}
                          </>
                        )}
                        <time dateTime={entry.createdAt}>
                          {dateFormat.format(new Date(entry.createdAt))}
                        </time>
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
