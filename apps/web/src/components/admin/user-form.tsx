"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { canIn, useSession } from "@/components/shell/session";
import {
  hasModule,
  ReadOnlyFieldset,
  useReadOnly,
  useSubscriptionRefusal,
} from "@/components/shell/subscription";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { InviteLink } from "@/components/ui/invite-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, codeOf, statusOf } from "@/lib/api";
import { fill } from "@/lib/format";
import type { Invite, OrgUnit, Role, UnitRef, User } from "@/lib/identity";
import { pick, readForm, type Localized } from "@/lib/localized";
import { unitOptions } from "@/lib/org-units";
import { personPath } from "@/lib/policies";
import { LocalizedField } from "@/components/ui/localized-field";
import type { AdminProps } from "./types";
import { statusTone } from "./users-list";

type Message = {
  kind: "ok" | "error";
  text: string;
  at?: "roles" | "access";
};
// roleId -> org unit id, or "" for the whole organization
type Grants = Record<string, string>;

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
  const languages = session.tenant;
  const inLang = (text: Localized | null | undefined) =>
    pick(text, lang, languages.defaultLocale);
  const f = t.users.form;
  const listPath = `/${lang}/admin/users`;
  const isSelf = user?.id === session.user.id;
  // While the organization's account is read-only, access can still be
  // taken away (a role removed, an account disabled) and links issued;
  // nothing can be added or changed.
  const readOnly = useReadOnly();
  const refusal = useSubscriptionRefusal();

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
    const refused = refusal(err);
    if (refused) return refused;
    const code = codeOf(err);
    if (code === "email_taken") return f.emailTaken;
    if (code === "language_mismatch") return f.languageMismatch;
    if (code === "unknown_org_unit") return f.unknownUnit;
    if (code === "outside_scope") return f.outsideScope;
    if (code === "cannot_change_self") return f.ownAccount;
    if (code?.endsWith("higher_access")) return f.higherAccess;
    if (statusOf(err) === 403) return t.noAccess;
    return statusOf(err) === 400 ? f.invalid : f.error;
  };

  // `at` says where a failure is shown: beside the part that was acted on.
  async function run(work: () => Promise<void>, at?: Message["at"]) {
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
    const { email, orgUnitId, ...rest } = readForm(form);
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
    }, "access");

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
        <PageHeader title={inLang(user.name)} description={f.created} />
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

  // The units that can be chosen. One already stored here that has since
  // been switched off comes first and stays selected, so saving does not
  // move anyone out of it. It is named from the user's own record, which
  // carries it for everyone who may edit the user. It is not disabled,
  // because a form leaves a disabled option out of what it sends.
  const choices = (stored: UnitRef | null | undefined) =>
    unitOptions(
      units,
      (u) => inLang(u.name),
      stored && {
        id: stored.id,
        label: fill(f.inactiveDepartment, { name: inLang(stored.name) }),
      },
    );
  const unitChoices = (stored: UnitRef | null | undefined) =>
    choices(stored).map((option) => (
      <option
        key={option.id}
        value={option.id}
        className={option.inactive ? "text-muted" : undefined}
      >
        {option.label}
      </option>
    ));
  const departmentInactive = choices(user?.orgUnit).some((o) => o.inactive);

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
                // Read-only: a role can be taken away, not given. One
                // taken away by mistake can be ticked again before saving.
                disabled={
                  readOnly &&
                  !checked &&
                  !user?.roles.some((r) => r.roleId === role.id)
                }
                onChange={(e) => {
                  const next = { ...grants };
                  if (e.target.checked) next[role.id] = "";
                  else delete next[role.id];
                  setGrants(next);
                }}
              />
              <span>
                <span className="font-medium">{inLang(role.name)}</span>
                {inLang(role.description) && (
                  <span dir="auto" className="block text-xs text-muted">
                    {inLang(role.description)}
                  </span>
                )}
              </span>
            </label>
            {checked && (
              <select
                aria-label={f.scope}
                disabled={readOnly}
                value={grants[role.id]}
                onChange={(e) =>
                  setGrants({ ...grants, [role.id]: e.target.value })
                }
                className={`${inputClass} h-9 max-w-64`}
              >
                <option value="">{f.wholeOrganization}</option>
                {unitChoices(
                  user?.roles.find((r) => r.roleId === role.id)?.orgUnit,
                )}
              </select>
            )}
          </div>
        );
      })}
      {isSelf && <p className="text-xs text-muted">{f.ownRoles}</p>}
      {readOnly && !isSelf && (
        <p className="text-xs text-muted">{f.rolesReadOnly}</p>
      )}
    </fieldset>
  );

  return (
    <>
      <PageHeader
        title={user ? inLang(user.name) : f.newTitle}
        description={
          user ? <bdi dir="ltr">{user.email}</bdi> : f.newDescription
        }
        actions={
          user && (
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={statusTone[user.status]}>
                {t.users.status[user.status]}
              </Pill>
              {/* Their acknowledgements, for whoever manages documents
                  where they work. */}
              {hasModule(session, "policies") &&
                (user.orgUnitId
                  ? canIn(session, "policies.manage", user.orgUnitId)
                  : session.scope?.["policies.manage"] === "all") && (
                  <Link
                    href={personPath(lang, user.id)}
                    className="text-sm text-accent hover:underline"
                  >
                    {f.acknowledgementRecord}
                  </Link>
                )}
            </div>
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
            <ReadOnlyFieldset>
              <LocalizedField
                label={f.name}
                name="name"
                locales={languages.locales}
                required={languages.defaultLocale}
                value={user?.name}
              />
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
                <Field
                  label={f.department}
                  help={departmentInactive ? f.departmentInactive : undefined}
                >
                  <select
                    name="orgUnitId"
                    defaultValue={user?.orgUnitId ?? ""}
                    className={inputClass}
                  >
                    <option value="">{f.noDepartment}</option>
                    {unitChoices(user?.orgUnit)}
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
            </ReadOnlyFieldset>

            {message && !message.at && (
              <p
                role={message.kind === "error" ? "alert" : "status"}
                className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
              >
                {message.text}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy || readOnly}>
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
            <SigningPinReset t={t} userId={user.id} />
            <Panel title={f.access}>
              <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-sm text-muted">
                  {user.status !== "disabled"
                    ? f.disableHelp
                    : readOnly
                      ? f.enableReadOnly
                      : f.enableHelp}
                </p>
                {message?.at === "access" && (
                  <p
                    role={message.kind === "error" ? "alert" : "status"}
                    className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
                  >
                    {message.text}
                  </p>
                )}
                <Button
                  variant="secondary"
                  disabled={busy || (readOnly && user.status === "disabled")}
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

/**
 * Resetting the signing PIN of someone who signs with one (single
 * sign-on): they then set a new one after signing in again. Asked twice,
 * since they cannot sign until they do.
 */
function SigningPinReset({ t, userId }: { t: AdminProps["t"]; userId: string }) {
  const refusal = useSubscriptionRefusal();
  const f = t.users.form;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  // Visited pages stay mounted: a half-made confirmation does not wait there.
  useLayoutEffect(
    () => () => {
      setConfirming(false);
      setMessage(null);
    },
    [],
  );

  async function reset() {
    if (!confirming) return setConfirming(true);
    setBusy(true);
    setMessage(null);
    try {
      await api(`/users/${userId}/signing-pin`, { method: "DELETE" });
      setMessage({ ok: true, text: f.pinResetDone });
    } catch (err) {
      setMessage({
        ok: false,
        text:
          codeOf(err) === "no_signing_pin"
            ? f.pinNone
            : (refusal(err) ?? f.pinResetFailed),
      });
    }
    setConfirming(false);
    setBusy(false);
  }

  return (
    <Panel title={f.pinTitle}>
      <div className="flex flex-col items-start gap-3 p-4">
        <p className="text-sm text-muted">{f.pinHelp}</p>
        {confirming && (
          <p role="alert" className="text-sm font-medium text-danger">
            {f.pinResetConfirm}
          </p>
        )}
        {message && (
          <p
            role={message.ok ? "status" : "alert"}
            className={`text-sm ${message.ok ? "text-accent" : "text-danger"}`}
          >
            {message.text}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            disabled={busy}
            className={confirming ? "border-danger text-danger" : ""}
            onClick={reset}
          >
            {confirming ? f.pinResetYes : f.pinReset}
          </Button>
          {confirming && (
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {f.pinResetCancel}
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
