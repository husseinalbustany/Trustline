"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/panel";
import { api, codeOf, statusOf } from "@/lib/api";
import type { Role } from "@/lib/identity";
import { pick, readForm } from "@/lib/localized";
import { LocalizedField } from "@/components/ui/localized-field";
import { useSession } from "@/components/shell/session";
import {
  hasModule,
  useReadOnly,
  useSubscriptionRefusal,
} from "@/components/shell/subscription";
import { permissionModule } from "@/config/modules";
import type { AdminProps } from "./types";

type Message = { kind: "ok" | "error"; text: string };

/** Adds a role, or shows and edits the one named in the route. */
export function RoleForm({
  lang,
  t,
  mode,
}: AdminProps & { mode: "new" | "edit" }) {
  const router = useRouter();
  const { id } = useParams<{ id?: string }>();
  const [role, setRole] = useState<Role | null>(null);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [granted, setGranted] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [confirming, setConfirming] = useState(false);
  const session = useSession();
  const languages = session.tenant;
  // While the organization's account is read-only, a role can be made to
  // grant less, or deleted; nothing can be added or renamed.
  const readOnly = useReadOnly();
  const refusal = useSubscriptionRefusal();
  const f = t.roles.form;
  const listPath = `/${lang}/admin/roles`;
  const locked = role?.isSystem ?? false;
  const labels = t.permissions as Record<string, string>;

  useEffect(() => {
    api<{ roles: Role[]; permissions: string[] }>("/roles")
      .then((data) => {
        setCatalog(data.permissions);
        if (mode === "edit") {
          const found = data.roles.find((r) => r.id === id);
          if (!found) return setProblem(t.roles.notFound);
          setRole(found);
          setGranted(found.permissions);
        }
        setProblem(null);
        setReady(true);
      })
      .catch((err) =>
        setProblem(statusOf(err) === 403 ? t.noAccess : t.loadError),
      );
  }, [mode, id, t]);

  async function run(work: () => Promise<void>, fallback = f.error) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
    } catch (err) {
      const code = codeOf(err);
      const text =
        refusal(err) ??
        (code === "language_mismatch"
          ? f.languageMismatch
          : code === "code_taken"
            ? f.codeTaken
            : code === "role_in_use"
              ? f.inUse
              : code === "cannot_change_own_role"
                ? f.ownRole
                : code === "cannot_grant_higher_access"
                  ? f.higherAccess
                  : statusOf(err) === 403
                    ? t.noAccess
                    : statusOf(err) === 400
                      ? f.invalid
                      : fallback);
      setMessage({ kind: "error", text });
    }
    setBusy(false);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { code, ...fields } = readForm(form);
    // Read-only: only taking permissions away is accepted, and only on its
    // own, so the name and description are not sent.
    const body = readOnly
      ? { permissions: granted }
      : { ...fields, permissions: granted };
    void run(async () => {
      if (mode === "new") {
        await api("/roles", { method: "POST", body: { code, ...body } });
        form.reset();
        setGranted([]);
        router.push(listPath);
        return;
      }
      const updated = await api<Role>(`/roles/${id}`, {
        method: "PATCH",
        body,
      });
      setRole({ ...updated, assignments: role?.assignments ?? 0 });
      setMessage({ kind: "ok", text: f.saved });
    });
  }

  // Deleting takes two presses: the first asks, the second deletes.
  const remove = () => {
    if (!confirming) return setConfirming(true);
    setConfirming(false);
    return run(async () => {
      await api(`/roles/${id}`, { method: "DELETE" });
      router.push(listPath);
    }, f.deleteError);
  };

  if (problem) return <EmptyState>{problem}</EmptyState>;
  if (!ready) return <EmptyState>{t.loading}</EmptyState>;

  return (
    <>
      <PageHeader
        title={
          role ? pick(role.name, lang, languages.defaultLocale) : f.newTitle
        }
        description={
          locked ? f.builtInHelp : role ? undefined : f.newDescription
        }
        actions={locked && <Badge>{t.roles.builtIn}</Badge>}
      />
      <form
        key={role?.id}
        onSubmit={submit}
        className="mt-6 flex max-w-3xl flex-col gap-5 rounded-lg border border-line p-4 sm:p-6"
      >
        <fieldset
          disabled={locked || (readOnly && mode === "new")}
          className="flex flex-col gap-5"
        >
          <LocalizedField
            label={f.name}
            name="name"
            locales={languages.locales}
            required={languages.defaultLocale}
            value={role?.name}
            maxLength={100}
            readOnly={readOnly}
          />
          {mode === "new" && (
            <Field label={f.code} help={f.codeHelp}>
              <input
                name="code"
                required
                pattern="[a-z][a-z0-9_]{1,48}[a-z0-9]"
                dir="ltr"
                className={inputClass}
              />
            </Field>
          )}
          <LocalizedField
            label={f.description}
            name="description"
            locales={languages.locales}
            value={role?.description}
            maxLength={500}
            readOnly={readOnly}
          />

          <div>
            <p className="mb-2 text-sm font-medium">{f.permissions}</p>
            {readOnly && !locked && mode === "edit" && (
              <p className="mb-2 text-xs text-muted">{f.permissionsReadOnly}</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2">
              {/* A permission of a module the client does not have is not
                  shown, and the role keeps it: it is sent back as it was. */}
              {catalog
                .filter((p) => hasModule(session, permissionModule(p)))
                .map((permission) => (
                  <label
                    key={permission}
                    className="flex items-start gap-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 accent-accent"
                      checked={granted.includes(permission)}
                      // Read-only: a permission can be taken away, not given.
                      disabled={
                        readOnly &&
                        !granted.includes(permission) &&
                        !role?.permissions.includes(permission)
                      }
                      onChange={(e) =>
                        setGranted(
                          e.target.checked
                            ? [...granted, permission]
                            : granted.filter((p) => p !== permission),
                        )
                      }
                    />
                    {labels[permission] ?? permission}
                  </label>
                ))}
            </div>
          </div>
        </fieldset>

        {confirming && (
          <p role="alert" className="text-sm text-danger">
            {f.deleteConfirm}
          </p>
        )}
        {message && (
          <p
            role={message.kind === "error" ? "alert" : "status"}
            className={`text-sm ${message.kind === "error" ? "text-danger" : "text-accent"}`}
          >
            {message.text}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {!locked && (
            <Button
              type="submit"
              disabled={busy || (readOnly && mode === "new")}
            >
              {mode === "new" ? f.create : f.save}
            </Button>
          )}
          {mode === "edit" && !locked && (
            <Button variant="secondary" disabled={busy} onClick={remove}>
              {f.delete}
            </Button>
          )}
          <Link
            href={listPath}
            className="inline-flex h-9 items-center rounded-md px-3 text-sm text-muted hover:bg-surface hover:text-foreground"
          >
            {mode === "new" ? f.cancel : f.back}
          </Link>
        </div>
      </form>
    </>
  );
}
