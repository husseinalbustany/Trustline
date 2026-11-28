"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/ui/button-link";
import { Field, inputClass } from "@/components/ui/field";
import { InviteLink } from "@/components/ui/invite-link";
import { LocalizedField } from "@/components/ui/localized-field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, codeOf, detailsOf, statusOf } from "@/lib/api";
import { dateTimeFormat, dayFormat, fill, languageNameIn } from "@/lib/format";
import type { Invite, Role } from "@/lib/identity";
import { pick, readForm, type Localized } from "@/lib/localized";
import { todayIn } from "@/lib/policies";
import { auditPathFor } from "@/lib/audit";
import { AdminTabs } from "./admin-tabs";
import type { AdminProps, AdminText } from "./types";

/** An external reviewer, as the API lists them. */
type Reviewer = {
  id: string;
  name: Localized;
  email: string;
  status: "invited" | "active" | "disabled" | (string & {});
  organization: string;
  purpose: string;
  from: string;
  until: string;
  extendedAt: string | null;
  extensionReason: string | null;
  endedAt: string | null;
  revision: number;
  lastSignInAt: string | null;
  role: { id: string; code: string; name: Localized };
};

/** Where an access stands today, on the organization's calendar. */
const stateOf = (r: Reviewer, today: string) =>
  r.endedAt || r.status === "disabled" || r.until < today
    ? "ended"
    : r.status === "invited"
      ? "invited"
      : r.from > today
        ? "upcoming"
        : "current";

const stateTone = { ended: "neutral", invited: "warn", upcoming: "neutral", current: "ok" } as const;

/** What the API said, in words; a field it names, for the form to mark. */
function explain(x: AdminText["external"], err: unknown) {
  const code = codeOf(err);
  const e = x.errors as Record<string, string>;
  if (code === "access_too_long") {
    return fill(x.errors.access_too_long, { days: String(detailsOf(err).days ?? 30) });
  }
  if (code && Object.hasOwn(e, code)) return e[code];
  return statusOf(err) === 400 ? x.errors.invalid : x.errors.generic;
}

/** Who has, had or will have read-only access from outside, under Users. */
export function ExternalReviewers({ lang, t }: AdminProps) {
  const session = useSession();
  const x = t.external;
  const manages = session.scope?.["users.manage"] === "all";
  const grants = manages && session.scope?.["audit.view"] === "all";
  const [list, setList] = useState<Reviewer[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const today = todayIn(session.tenant.timeZone);
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, session.tenant.defaultLocale);

  useEffect(() => {
    if (!manages) return;
    let current = true;
    api<Reviewer[]>("/users/external").then(
      (answer) => {
        if (!current) return;
        setList(answer);
        setProblem(null);
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 403 ? x.noAccess : x.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [manages, round, x]);

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          grants && (
            <ButtonLink href={`/${lang}/admin/users/external/new`}>
              <Plus className="size-4" aria-hidden />
              {x.add}
            </ButtonLink>
          )
        }
      />
      <AdminTabs lang={lang} t={t} current="external" />
      <div className="mt-6 flex flex-col gap-4">
        <div className="text-sm text-muted">
          <p className="font-medium text-foreground">{x.title}</p>
          <p className="mt-1">{x.description}</p>
          <p className="mt-1">{x.never}</p>
          {manages && !grants && <p className="mt-1">{x.noAccessGrant}</p>}
        </div>
        <Panel>
          {!manages ? (
            <EmptyState>{x.noAccess}</EmptyState>
          ) : problem ? (
            <EmptyState>{problem}</EmptyState>
          ) : !list ? (
            <EmptyState>{x.loading}</EmptyState>
          ) : list.length === 0 ? (
            <EmptyState>{x.empty}</EmptyState>
          ) : (
            <ul>
              {list.map((r) => (
                <ReviewerRow
                  key={r.id}
                  lang={lang}
                  t={t}
                  reviewer={r}
                  state={stateOf(r, today)}
                  name={inLang(r.name)}
                  roleName={inLang(r.role.name)}
                  canChange={grants}
                  onChanged={() => setRound((n) => n + 1)}
                />
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}

function ReviewerRow({
  lang,
  t,
  reviewer: r,
  state,
  name,
  roleName,
  canChange,
  onChanged,
}: AdminProps & {
  reviewer: Reviewer;
  state: keyof typeof stateTone;
  name: string;
  roleName: string;
  canChange: boolean;
  onChanged: () => void;
}) {
  const session = useSession();
  const x = t.external;
  const day = dayFormat(lang);
  const moment = dateTimeFormat(lang, session.tenant.timeZone);
  const [open, setOpen] = useState<"extend" | "end" | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useLayoutEffect(() => () => setMessage(null), []);

  async function change(body: Record<string, unknown>, done: string, form?: HTMLFormElement) {
    setBusy(true);
    setMessage(null);
    try {
      await api(`/users/external/${r.id}`, {
        method: "PATCH",
        body: { ...body, revision: r.revision },
      });
      form?.reset();
      setOpen(null);
      setMessage({ ok: true, text: done });
      onChanged();
    } catch (err) {
      setMessage({ ok: false, text: explain(x, err) });
      if (codeOf(err) === "stale_access") onChanged();
    }
    setBusy(false);
  }

  function extend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    void change(
      { until: String(data.get("until") ?? ""), reason: String(data.get("reason") ?? "").trim() },
      x.extend.done,
      form,
    );
  }

  const live = state !== "ended";
  return (
    <li className="flex flex-col gap-2 border-b border-line px-4 py-3 text-sm last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span>
          <span className="font-medium">
            <bdi>{name}</bdi>
          </span>{" "}
          <span className="inline-block text-muted">
            {"· "}
            <bdi dir="ltr">{r.email}</bdi>
          </span>
        </span>
        <Pill tone={stateTone[state]}>{x.state[state]}</Pill>
      </div>
      <p className="text-muted">
        <bdi dir="auto">{r.organization}</bdi>
        {" · "}
        <bdi dir="auto">{r.purpose}</bdi>
      </p>
      <p>
        {fill(x.days, { from: day(r.from) ?? "", until: day(r.until) ?? "" })}
        <span className="text-muted">
          {" · "}
          <bdi>{roleName}</bdi>
        </span>
      </p>
      {r.extendedAt && (
        <p className="text-muted">
          {fill(x.extendedOn, {
            date: moment.format(new Date(r.extendedAt)),
            reason: r.extensionReason ?? "",
          })}
        </p>
      )}
      {r.endedAt && (
        <p className="text-muted">{fill(x.endedOn, { date: moment.format(new Date(r.endedAt)) })}</p>
      )}
      <p className="text-xs text-muted">
        {r.lastSignInAt
          ? fill(x.lastSignIn, { date: moment.format(new Date(r.lastSignInAt)) })
          : x.neverSignedIn}
        {session.scope?.["audit.view"] === "all" && (
          <>
            {" · "}
            <Link href={auditPathFor(lang, "user", r.id)} className="text-accent hover:underline">
              {t.users.form.auditTrail}
            </Link>
          </>
        )}
      </p>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-accent" : "text-danger"}>
          {message.text}
        </p>
      )}
      {canChange && live && open === null && (
        <div className="flex flex-wrap gap-2">
          {!r.extendedAt && (
            <Button variant="secondary" onClick={() => setOpen("extend")}>
              {x.extend.open}
            </Button>
          )}
          <Button variant="secondary" onClick={() => setOpen("end")}>
            {x.end.open}
          </Button>
        </div>
      )}
      {open === "extend" && (
        <form onSubmit={extend} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
          <p className="font-medium">{x.extend.title}</p>
          <p className="text-muted">{x.extend.help}</p>
          <div className="grid max-w-xl gap-4 sm:grid-cols-2">
            <Field label={x.extend.until}>
              <input type="date" name="until" required min={r.until} dir="ltr" className={inputClass} />
            </Field>
            <Field label={x.extend.reason} help={x.extend.reasonHelp}>
              <input name="reason" required maxLength={500} dir="auto" className={inputClass} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {x.extend.submit}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>
              {t.users.form.cancel}
            </Button>
          </div>
        </form>
      )}
      {open === "end" && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-danger bg-danger-soft p-4">
          <p>{x.end.confirm}</p>
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void change({ end: true }, x.end.done)}>
              {x.end.submit}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(null)} disabled={busy}>
              {t.users.form.cancel}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Giving someone from outside read-only access, and the link they choose a password with. */
export function ExternalReviewerForm({ lang, t }: AdminProps) {
  const session = useSession();
  const x = t.external;
  const f = x.form;
  const grants =
    session.scope?.["users.manage"] === "all" && session.scope?.["audit.view"] === "all";
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const { locales, defaultLocale, timeZone } = session.tenant;
  const today = todayIn(timeZone);
  const languageName = languageNameIn(lang);
  // Visited pages stay mounted: no link and no refusal wait here.
  useLayoutEffect(
    () => () => {
      setInvite(null);
      setError(null);
    },
    [],
  );

  useEffect(() => {
    if (!grants) return;
    let current = true;
    api<{ roles: Role[] }>("/roles").then(
      (answer) => {
        if (current) setRoles(answer.roles);
      },
      (err) => {
        if (current) setProblem(statusOf(err) === 403 ? x.noAccess : x.loadError);
      },
    );
    return () => {
      current = false;
    };
  }, [grants, x]);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { preferredLocale, ...fields } = readForm(form);
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ invite: Invite }>("/users/external", {
        method: "POST",
        body: { ...fields, ...(preferredLocale ? { preferredLocale } : {}) },
      });
      form.reset();
      setInvite(created.invite);
    } catch (err) {
      setError(explain(x, err));
    }
    setBusy(false);
  }

  const suggested = roles?.find((r) => r.code === "external_reviewer")?.id ?? "";
  return (
    <>
      <PageHeader title={f.title} description={x.description} />
      <div className="mt-4">
        <Link href={`/${lang}/admin/users/external`} className="text-sm text-accent hover:underline">
          {x.back}
        </Link>
      </div>
      <div className="mt-6 max-w-2xl">
        {!grants ? (
          <Panel>
            <EmptyState>{x.noAccessGrant}</EmptyState>
          </Panel>
        ) : problem ? (
          <Panel>
            <EmptyState>{problem}</EmptyState>
          </Panel>
        ) : !roles ? (
          <Panel>
            <EmptyState>{x.loading}</EmptyState>
          </Panel>
        ) : invite ? (
          <Panel>
            <div className="flex flex-col gap-4 p-4">
              <InviteLink lang={lang} invite={invite} t={t.inviteLink} />
              <div className="flex flex-wrap gap-3 text-sm">
                <button type="button" onClick={() => setInvite(null)} className="text-accent hover:underline">
                  {f.another}
                </button>
                <Link href={`/${lang}/admin/users/external`} className="text-accent hover:underline">
                  {x.back}
                </Link>
              </div>
            </div>
          </Panel>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-6">
            <Panel>
              <div className="flex flex-col gap-5 p-4">
                <p className="text-sm text-muted">{x.never}</p>
                <LocalizedField label={f.name} name="name" locales={locales} required={defaultLocale} />
                <Field label={f.email}>
                  <input name="email" type="email" required maxLength={254} dir="ltr" autoComplete="off" className={inputClass} />
                </Field>
                <Field label={f.organization} help={f.organizationHelp}>
                  <input name="organization" required maxLength={200} dir="auto" className={inputClass} />
                </Field>
                <Field label={f.purpose} help={f.purposeHelp}>
                  <input name="purpose" required maxLength={500} dir="auto" className={inputClass} />
                </Field>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label={f.from}>
                    <input type="date" name="from" required min={today} defaultValue={today} dir="ltr" className={inputClass} />
                  </Field>
                  <Field label={f.until} help={f.daysHelp}>
                    <input type="date" name="until" required min={today} dir="ltr" className={inputClass} />
                  </Field>
                </div>
                <Field label={f.role} help={f.roleHelp}>
                  <select name="roleId" required defaultValue={suggested} className={inputClass}>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {pick(r.name, lang, defaultLocale)}
                      </option>
                    ))}
                  </select>
                </Field>
                {locales.length > 1 && (
                  <Field label={f.language}>
                    <select name="preferredLocale" defaultValue="" className={inputClass}>
                      <option value="">{f.languageDefault}</option>
                      {locales.map((l) => (
                        <option key={l} value={l}>
                          {languageName(l)}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
            </Panel>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div>
              <Button type="submit" disabled={busy}>
                {f.submit}
              </Button>
            </div>
          </form>
        )}
      </div>
    </>
  );
}
