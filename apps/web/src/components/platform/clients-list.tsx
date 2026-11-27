"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { pick } from "@/lib/localized";
import { platformApi, type Client } from "@/lib/platform-api";
import { Pill } from "@/components/ui/pill";
import { statusTone } from "./client-subscription";
import { StatusPill } from "./status-pill";
import type { PlatformProps } from "./types";

export function ClientsList({ lang, t }: PlatformProps) {
  const [clients, setClients] = useState<Client[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    platformApi<Client[]>("/tenants")
      .then((list) => {
        setClients(list);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  }, []);

  const c = t.clients.columns;

  return (
    <>
      <PageHeader
        title={t.clients.title}
        description={t.clients.description}
        actions={
          <ButtonLink href={`/${lang}/platform/clients/new`}>
            <Plus className="size-4" aria-hidden />
            {t.clients.add}
          </ButtonLink>
        }
      />
      <div className="mt-6">
        <Panel>
          {failed ? (
            <EmptyState>{t.clients.loadError}</EmptyState>
          ) : !clients ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : clients.length === 0 ? (
            <EmptyState>{t.clients.empty}</EmptyState>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-line text-muted">
                    {[c.name, c.standard, c.plan, c.signIn, c.status].map(
                      (heading) => (
                        <th
                          key={heading}
                          scope="col"
                          className="px-4 py-3 text-start font-medium whitespace-nowrap"
                        >
                          {heading}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {clients.map((client) => (
                    <tr
                      key={client.id}
                      className="border-b border-line last:border-0"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/${lang}/platform/clients/${client.id}`}
                          className="font-medium hover:text-accent hover:underline"
                        >
                          {pick(client.name, lang, client.defaultLocale)}
                        </Link>
                        <div className="text-xs text-muted">
                          <span dir="ltr">{client.slug}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {client.accreditationStandard}
                      </td>
                      <td className="px-4 py-3">
                        {client.subscription ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <bdi className="whitespace-nowrap">
                              {pick(client.subscription.plan.name, lang)}
                            </bdi>
                            {/* Active is the usual case: only the others
                                are marked. */}
                            {client.subscription.status !== "active" && (
                              <Pill
                                tone={statusTone[client.subscription.status]}
                              >
                                {
                                  t.subscription.statuses[
                                    client.subscription.status
                                  ]
                                }
                              </Pill>
                            )}
                          </div>
                        ) : (
                          <span className="text-muted">{t.clients.noPlan}</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        {t.options.signInMethod[client.signInMethod]}
                      </td>
                      <td className="px-4 py-3">
                        <StatusPill
                          status={client.status}
                          label={t.status[client.status]}
                        />
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
