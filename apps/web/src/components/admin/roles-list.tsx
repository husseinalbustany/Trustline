"use client";

import { Plus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { api, statusOf } from "@/lib/api";
import type { Role } from "@/lib/identity";
import { pick } from "@/lib/localized";
import type { ApprovalRoute } from "@/lib/policies";
import { useSession } from "@/components/shell/session";
import { hasModule, useReadOnly } from "@/components/shell/subscription";
import { permissionModule } from "@/config/modules";
import { AdminTabs } from "./admin-tabs";
import type { AdminProps } from "./types";

export function RolesList({ lang, t }: AdminProps) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const session = useSession();
  // No role can be added while the organization's account is read-only.
  const readOnly = useReadOnly();
  const c = t.roles.columns;
  // Counted as the form shows them: a permission of a module the client
  // does not have is kept by the role, and neither shown nor counted.
  const inUse = (role: Role) =>
    role.permissions.filter((p) => hasModule(session, permissionModule(p)))
      .length;

  // Roles an approval route names, when this person may see the routes:
  // one nobody holds stops those documents from being sent for review.
  const [routed, setRouted] = useState<Set<string>>(new Set());
  const documents = hasModule(session, "policies");
  useEffect(() => {
    if (!documents) return;
    let current = true;
    api<ApprovalRoute[]>("/policies/approval-routes")
      .then((routes) => {
        if (!current) return;
        setRouted(
          new Set(
            routes
              .filter((r) => r.active)
              .flatMap((r) => r.steps)
              .flatMap((s) => (s.assignee.type === "role" ? [s.assignee.role.id] : [])),
          ),
        );
      })
      .catch(() => {
        // Not shown to those who may not read the routes.
      });
    return () => {
      current = false;
    };
  }, [documents]);

  useEffect(() => {
    api<{ roles: Role[] }>("/roles")
      .then((data) => {
        setRoles(data.roles);
        setProblem(null);
      })
      .catch((err) =>
        setProblem(statusOf(err) === 403 ? t.noAccess : t.loadError),
      );
  }, [t]);

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          !readOnly && (
            <ButtonLink href={`/${lang}/admin/roles/new`}>
              <Plus className="size-4" aria-hidden />
              {t.roles.add}
            </ButtonLink>
          )
        }
      />
      <AdminTabs lang={lang} t={t} current="roles" />
      <div className="mt-6">
        <Panel>
          {problem ? (
            <EmptyState>{problem}</EmptyState>
          ) : !roles ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-muted">
                    {[c.name, c.permissions, c.users].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className="px-4 py-3 text-start font-medium whitespace-nowrap"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roles.map((role) => (
                    <tr
                      key={role.id}
                      className="border-b border-line last:border-0"
                    >
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/${lang}/admin/roles/${role.id}`}
                            className="font-medium hover:text-accent hover:underline"
                          >
                            {pick(
                              role.name,
                              lang,
                              session.tenant.defaultLocale,
                            )}
                          </Link>
                          {role.isSystem && <Badge>{t.roles.builtIn}</Badge>}
                        </div>
                        {role.description && (
                          <p className="mt-1 max-w-xl text-xs text-muted">
                            {pick(
                              role.description,
                              lang,
                              session.tenant.defaultLocale,
                            )}
                          </p>
                        )}
                        {/* An approving role nobody holds: its approval steps
                            cannot be decided, so say what to do. */}
                        {role.assignments === 0 && routed.has(role.id) && (
                            <p className="mt-2 flex max-w-xl items-start gap-2 rounded-md border border-warn bg-warn-soft px-2 py-1.5 text-xs">
                              <TriangleAlert
                                className="mt-0.5 size-3.5 shrink-0 text-warn"
                                aria-hidden
                              />
                              <span>
                                {t.roles.nobodyApproves}{" "}
                                <Link
                                  href={`/${lang}/admin/users`}
                                  className="font-medium text-accent hover:underline"
                                >
                                  {t.roles.giveToSomeone}
                                </Link>
                              </span>
                            </p>
                          )}
                      </td>
                      <td className="px-4 py-3 tabular-nums">{inUse(role)}</td>
                      <td className="px-4 py-3">
                        <span className="tabular-nums">{role.assignments}</span>
                        {role.assignments === 0 && (
                          <span className="mt-1 block text-xs whitespace-nowrap text-muted">
                            {t.roles.nobodyYet}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
