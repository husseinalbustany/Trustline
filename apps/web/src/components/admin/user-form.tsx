"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { useSession } from "@/components/shell/session";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { InviteLink } from "@/components/ui/invite-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, codeOf, statusOf } from "@/lib/api";
import type { Invite, OrgUnit, Role, User } from "@/lib/identity";
import type { AdminProps } from "./types";
import { statusTone } from "./users-list";

type Message = { kind: "ok" | "error"; text: string; at?: "roles" };
// roleId -> org unit id, or "" for the whole organization
type Grants = Record<string, string>;

const indent = { facility: "", department: "— ", unit: "— — " };

/** Adds a user, or edits the one named in the route. */
export function UserForm({
  lang,
  t,
  mode,
}: AdminProps & { mode: "new" | "edit" }) {
  const session = useSession();
  const { id } = useParams<{ id?: string }>();
  const [user, setUser] = useState<User | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [grants, setGrants] = useState<Grants>({});
  const [invite, setInvite] = useState<Invite | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const ar = lang === "ar";
  const f = t.users.form;
  const listPath = `/${lang}/admin/users`;
  const isSelf = user?.id === session.user.id;

  const adopt = (u: User) => {
    setUser(u);
    setGrants(
      Object.fromEntries(u.roles.map((r) => [r.roleId, r.orgUnitId ?? ""])),
    );
  };

  useEffect(() => {
    Promise.all([
      api<{ roles: Role[] }>("/roles"),
      api<OrgUnit[]>("/org-units"),
      mode === "edit" ? api<User>(`/users/${id}`) : null,
    ])
      .then(([r, o, u]) => {
        setRoles(r.roles);
        setUnits(o);
        if (u) adopt(u);
        setProblem(null);
        setReady(true);
      })
      .catch((err) => {
        const status = statusOf(err);
        setProblem(
          status === 403
            ? t.noAccess
            : status === 404
              ? t.users.notFound
              : t.loadError,
        );
      });
  }, [mode, id, t]);

  const grantList = () =>
    Object.entries(grants).map(([roleId, orgUnitId]) => ({
      roleId,
      orgUnitId: orgUnitId || null,
    }));

  const explain = (err: unknown) => {
    const code = codeOf(err);
    if (code === "email_taken") return f.emailTaken;
    if (code === "cannot_change_self") return f.ownAccount;
    if (code?.endsWith("higher_access")) return f.higherAccess;
    if (statusOf(err) === 403) return t.noAccess;
    return statusOf(err) === 400 ? f.invalid : f.error;
  };

  // `at` says where a failure is shown: beside the part that was acted on.
  async function run(work: () => Promise<void>, at?: "roles") {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (err) {
      setMessage({ kind: "error", text: explain(err), at });
    }
    setBusy(false);
  }

  // Visited pages stay mounted, so a one-time link and a "saved" note must
  // not be waiting here when the page is shown again.
  const leave = () => {
    setInvite(null);
    setMessage(null);
    if (mode === "new") setUser(null);
  };

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { email, orgUnitId, ...rest } = Object.fromEntries(
      new FormData(form),
    );
    const profile = { ...rest, orgUnitId: orgUnitId || null };
    void run(async () => {
      if (mode === "new") {
        const created = await api<{ user: User; invite: Invite }>("/users", {
          method: "POST",
          body: { ...profile, email, roles: grantList() },
        });
        form.reset();
        setGrants({});
        setInvite(created.invite);
        setUser(created.user);
        return;
      }
      adopt(
        await api<User>(`/users/${id}`, { method: "PATCH", body: profile }),
      );
      setMessage({ kind: "ok", text: f.saved });
    });
  }

  const saveRoles = () =>
    run(async () => {
      adopt(
        await api<User>(`/users/${id}/roles`, {
          method: "PUT",
          body: { roles: grantList() },
        }),
      );
      setMessage({ kind: "ok", text: f.rolesSaved, at: "roles" });
    }, "roles");

  const setStatus = (status: "active" | "disabled") =>
    run(async () => {
      adopt(
        await api<User>(`/users/${id}`, { method: "PATCH", body: { status } }),
      );
      setInvite(null);
    });

  const newLink = () =>
    run(async () => {
      setInvite(await api<Invite>(`/users/${id}/invite`, { method: "POST" }));
    });

  if (problem) return <EmptyState>{problem}</EmptyState>;
  if (!ready) return <EmptyState>{t.loading}</EmptyState>;

  // After creating someone, show only their link and the way back.
  if (mode === "new" && user && invite) {
    return (
      <>
        <PageHeader
          title={ar ? user.nameAr : user.nameEn}
          description={f.created}
        />
        <div className="mt-6 flex max-w-2xl flex-col gap-4">
          <InviteLink lang={lang} invite={invite} t={t.inviteLink} />
          <div className="flex gap-2">
            <Link
              href={listPath}
              onClick={leave}
              className="inline-flex h-9 items-center rounded-md bg-accent px-3 text-sm font-medium text-accent-fg hover:bg-accent-hover"
            >
              {f.back}
            </Link>
            <Button
              variant="secondary"
              onClick={() => {
                setUser(null);
                setInvite(null);
              }}
            >
              {f.addAnother}
            </Button>
          </div>
        </div>
      </>
    );
  }

  // Built-in roles are described in the reader's language. A custom role
  // shows what its author wrote.
  const builtIn = t.roles.builtInDescriptions as Record<string, string>;
  const describe = (role: Role) =>
    role.isSystem ? builtIn[role.code] : role.description;

  const roleBoxes = (
    <fieldset className="flex flex-col gap-3" disabled={isSelf}>
      <legend className="mb-2 text-sm font-medium">{f.roles}</legend>
      {roles.map((role) => {
        const checked = role.id in grants;
        return (
          <div
            key={role.id}
            className="flex flex-wrap items-start gap-x-4 gap-y-2"
          >
            <label className="flex min-w-0 flex-1 basis-56 items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 accent-accent"
                checked={checked}
                onChange={(e) => {
                  const next = { ...grants };
                  if (e.target.checked) next[role.id] = "";
                  else delete next[role.id];
                  setGrants(next);
                }}
              />
              <span>
                <span className="font-medium">
                  {ar ? role.nameAr : role.nameEn}
                </span>
                {describe(role) && (
                  <span dir="auto" className="block text-xs text-muted">
                    {describe(role)}
                  </span>
                )}
              </span>
            </label>
            {checked && (
              <select
                aria-label={f.scope}
                value={grants[role.id]}
                onChange={(e) =>
                  setGrants({ ...grants, [role.id]: e.target.value })
                }
                className={`${inputClass} h-9 max-w-64`}
              >
                <option value="">{f.wholeOrganization}</option>
                {units.map((u) => (
                  <option key={u.id} value={u.id}>
                    {indent[u.type]}
                    {ar ? u.nameAr : u.nameEn}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
      {isSelf && <p className="text-xs text-muted">{f.ownRoles}</p>}
    </fieldset>
  );

  return (
    <>
      <PageHeader
        title={user ? (ar ? user.nameAr : user.nameEn) : f.newTitle}
        description={
          user ? <bdi dir="ltr">{user.email}</bdi> : f.newDescription
        }
        actions={
          user && (
            <Pill tone={statusTone[user.status]}>
              {t.users.status[user.status]}
            </Pill>
          )
        }
      />

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <form
            key={user?.id}
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
                  defaultValue={user?.nameEn}
                  className={inputClass}
                />
              </Field>
              <Field label={f.nameAr}>
                <input
                  name="nameAr"
                  required
                  maxLength={200}
                  dir="rtl"
                  defaultValue={user?.nameAr}
                  className={inputClass}
                />
              </Field>
            </div>
            <Field
              label={f.email}
              help={mode === "edit" ? f.emailFixed : undefined}
            >
              <input
                name="email"
                type="email"
                required
                dir="ltr"
                defaultValue={user?.email}
                disabled={mode === "edit"}
                className={`${inputClass} disabled:bg-surface disabled:text-muted`}
              />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label={f.department}>
                <select
                  name="orgUnitId"
                  defaultValue={user?.orgUnitId ?? ""}
                  className={inputClass}
                >
                  <option value="">{f.noDepartment}</option>
                  {units.map((u) => (
                    <option key={u.id} value={u.id}>
                      {indent[u.type]}
                      {ar ? u.nameAr : u.nameEn}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={f.jobTitle}>
                <input
                  name="jobTitle"
                  dir="auto"
                  maxLength={200}
                  defaultValue={user?.jobTitle ?? ""}
                  className={inputClass}
                />
              </Field>
              <Field label={f.employeeNumber}>
                <input
                  name="employeeNumber"
                  maxLength={50}
                  dir="ltr"
                  defaultValue={user?.employeeNumber ?? ""}
                  className={inputClass}
                />
              </Field>
              <Field label={f.phone}>
                <input
                  name="phone"
                  type="tel"
                  maxLength={50}
                  dir="ltr"
                  defaultValue={user?.phone ?? ""}
                  className={inputClass}
                />
              </Field>
            </div>

            {mode === "new" && roleBoxes}

            {message && message.at !== "roles" && (
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
                onClick={leave}
                className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted hover:bg-surface hover:text-foreground"
              >
                {mode === "new" ? f.cancel : f.back}
              </Link>
            </div>
          </form>

          {mode === "edit" && (
            <div className="flex flex-col gap-4 rounded-lg border border-line p-4 sm:p-6">
              {roleBoxes}
              {message?.at === "roles" && (
                <p
                  role={message.kind === "error" ? "alert" : "status"}
                  className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
                >
                  {message.text}
                </p>
              )}
              {!isSelf && (
                <div>
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={saveRoles}
                  >
                    {f.saveRoles}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {user && mode === "edit" && !isSelf && (
          <div className="flex flex-col gap-6">
            <Panel title={f.signIn}>
              <div className="flex flex-col items-start gap-3 p-4">
                {user.status === "disabled" ? (
                  <p className="text-sm text-muted">{f.disabledHelp}</p>
                ) : (
                  <>
                    <p className="text-sm text-muted">
                      {user.status === "invited" ? f.invitedHelp : f.resetHelp}
                    </p>
                    <Button
                      variant="secondary"
                      disabled={busy}
                      onClick={newLink}
                    >
                      {user.status === "invited"
                        ? f.newInvite
                        : f.resetPassword}
                    </Button>
                    {invite && (
                      <InviteLink
                        lang={lang}
                        invite={invite}
                        t={t.inviteLink}
                      />
                    )}
                  </>
                )}
              </div>
            </Panel>
            <Panel title={f.access}>
              <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-sm text-muted">
                  {user.status === "disabled" ? f.enableHelp : f.disableHelp}
                </p>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    setStatus(
                      user.status === "disabled" ? "active" : "disabled",
                    )
                  }
                >
                  {user.status === "disabled" ? f.enable : f.disable}
                </Button>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}
