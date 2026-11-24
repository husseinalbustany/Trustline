"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import {
  ApiError,
  platformApi,
  type Activity,
  type Client,
} from "@/lib/platform-api";
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
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const listPath = `/${lang}/platform/clients`;
  const f = t.form;

  useEffect(() => {
    if (mode !== "edit") return;
    platformApi<Loaded>(`/tenants/${id}`)
      .then(setClient)
      .catch(() => setMissing(true));
  }, [mode, id]);

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
      setClient(await platformApi<Loaded>(`/tenants/${id}`));
      setMessage({ kind: "ok", text: f.saved });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setMessage({
        kind: "error",
        text:
          status === 409 ? f.slugTaken : status === 400 ? f.invalid : f.error,
      });
    }
    setBusy(false);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { slug, ...settings } = Object.fromEntries(new FormData(form));
    void save(mode === "new" ? { slug, ...settings } : settings, form);
  }

  if (missing) return <EmptyState>{t.notFound}</EmptyState>;
  if (mode === "edit" && !client) return <EmptyState>{t.loading}</EmptyState>;

  const suspended = client?.status === "suspended";
  const dateFormat = new Intl.DateTimeFormat(lang, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <>
      <PageHeader
        title={
          client ? (lang === "ar" ? client.nameAr : client.nameEn) : f.newTitle
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
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={f.nameEn}>
              <input
                name="nameEn"
                required
                maxLength={200}
                dir="ltr"
                defaultValue={client?.nameEn}
                className={inputClass}
              />
            </Field>
            <Field label={f.nameAr}>
              <input
                name="nameAr"
                required
                maxLength={200}
                dir="rtl"
                defaultValue={client?.nameAr}
                className={inputClass}
              />
            </Field>
          </div>

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
              <Select
                name="defaultLocale"
                defaultValue={client?.defaultLocale}
                options={t.options.locale}
              />
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
