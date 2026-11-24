"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { api, statusOf } from "@/lib/api";
import type { Role } from "@/lib/identity";
import { AdminTabs } from "./admin-tabs";
import type { AdminProps } from "./types";

export function RolesList({ lang, t }: AdminProps) {
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ar = lang === "ar";
  const c = t.roles.columns;

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
          <ButtonLink href={`/${lang}/admin/roles/new`}>
            <Plus className="size-4" aria-hidden />
            {t.roles.add}
          </ButtonLink>
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
                            {ar ? role.nameAr : role.nameEn}
                          </Link>
                          {role.isSystem && <Badge>{t.roles.builtIn}</Badge>}
                        </div>
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {role.permissions.length}
                      </td>
                      <td className="px-4 py-3 tabular-nums">
                        {role.assignments}
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
