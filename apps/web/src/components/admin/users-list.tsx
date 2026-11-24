"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, statusOf } from "@/lib/api";
import type { OrgUnit, User } from "@/lib/identity";
import { pick, type Localized } from "@/lib/localized";
import { useSession } from "@/components/shell/session";
import { AdminTabs } from "./admin-tabs";
import type { AdminProps } from "./types";

export const statusTone = {
  active: "ok",
  invited: "neutral",
  disabled: "danger",
} as const;

export function UsersList({ lang, t }: AdminProps) {
  const [users, setUsers] = useState<User[] | null>(null);
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const session = useSession();
  const inLang = (text: Localized | null) =>
    pick(text, lang, session.tenant.defaultLocale);
  const roleList = new Intl.ListFormat(lang, { style: "short", type: "unit" });

  useEffect(() => {
    Promise.all([api<User[]>("/users"), api<OrgUnit[]>("/org-units")])
      .then(([u, o]) => {
        setUsers(u);
        setUnits(o);
        setProblem(null);
      })
      .catch((err) =>
        setProblem(statusOf(err) === 403 ? t.noAccess : t.loadError),
      );
  }, [t]);

  const unitName = (id: string | null) => {
    const unit = units.find((u) => u.id === id);
    return unit ? inLang(unit.name) : "";
  };
  const c = t.users.columns;

  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <ButtonLink href={`/${lang}/admin/users/new`}>
            <Plus className="size-4" aria-hidden />
            {t.users.add}
          </ButtonLink>
        }
      />
      <AdminTabs lang={lang} t={t} current="users" />
      <div className="mt-6">
        <Panel>
          {problem ? (
            <EmptyState>{problem}</EmptyState>
          ) : !users ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-muted">
                    {[c.name, c.department, c.roles, c.status].map((h) => (
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
                  {users.map((user) => (
                    <tr
                      key={user.id}
                      className="border-b border-line last:border-0"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/${lang}/admin/users/${user.id}`}
                          className="font-medium hover:text-accent hover:underline"
                        >
                          {inLang(user.name)}
                        </Link>
                        <div className="text-xs text-muted">
                          <span dir="ltr">{user.email}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">{unitName(user.orgUnitId)}</td>
                      <td className="px-4 py-3">
                        {roleList.format([
                          ...new Set(user.roles.map((r) => inLang(r.name))),
                        ])}
                      </td>
                      <td className="px-4 py-3">
                        <Pill tone={statusTone[user.status]}>
                          {t.users.status[user.status]}
                        </Pill>
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
