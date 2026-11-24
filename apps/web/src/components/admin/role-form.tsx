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
  const ar = lang === "ar";
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
        code === "code_taken"
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
                    : fallback;
      setMessage({ kind: "error", text });
    }
    setBusy(false);
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const { code, ...fields } = Object.fromEntries(new FormData(form));
    const body = { ...fields, permissions: granted };
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
        title={role ? (ar ? role.nameAr : role.nameEn) : f.newTitle}
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
        <fieldset disabled={locked} className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={f.nameEn}>
              <input
                name="nameEn"
                required
                maxLength={100}
                dir="ltr"
                defaultValue={role?.nameEn}
                className={inputClass}
              />
            </Field>
            <Field label={f.nameAr}>
              <input
                name="nameAr"
                required
                maxLength={100}
                dir="rtl"
                defaultValue={role?.nameAr}
                className={inputClass}
              />
            </Field>
          </div>
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
          <Field label={f.description}>
            <input
              name="description"
              dir="auto"
              maxLength={500}
              defaultValue={role?.description ?? ""}
              className={inputClass}
            />
          </Field>

          <div>
            <p className="mb-2 text-sm font-medium">{f.permissions}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {catalog.map((permission) => (
                <label
                  key={permission}
                  className="flex items-start gap-3 text-sm"
                >
                  <input
                    type="checkbox"
                    className="mt-1 accent-accent"
                    checked={granted.includes(permission)}
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
            <Button type="submit" disabled={busy}>
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
