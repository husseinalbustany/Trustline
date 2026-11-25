"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { can, useSession } from "@/components/shell/session";
import { ButtonLink } from "@/components/ui/button-link";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState, Panel } from "@/components/ui/panel";
import { Pill } from "@/components/ui/pill";
import { api, statusOf } from "@/lib/api";
import type { OrgUnit } from "@/lib/identity";
import { pick } from "@/lib/localized";
import { childType, inTreeOrder } from "@/lib/org-units";
import type { AdminProps } from "./types";

const unitsPath = (includeInactive: boolean) =>
  includeInactive ? "/org-units?includeInactive=true" : "/org-units";

// How far a row starts from the edge: one step per level of the tree.
const indent = { facility: "ps-4", department: "ps-10", unit: "ps-16" };

type Loaded = {
  units: OrgUnit[];
  /** Nothing is active, but there are units that were switched off. */
  allInactive: boolean;
};

/** The hospital's structure: facilities, their departments, their units. */
export function OrgTree({ lang, t }: AdminProps) {
  const session = useSession();
  const allowed = can(session, "organization.manage");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const o = t.organization;
  const base = `/${lang}/admin/organization`;

  useEffect(() => {
    if (!allowed) return;
    let current = true;
    api<OrgUnit[]>(unitsPath(showInactive))
      .then(async (units) => {
        // Nothing to show: is the structure empty, or all switched off?
        const hidden =
          !showInactive && units.length === 0
            ? await api<OrgUnit[]>(unitsPath(true))
            : [];
        if (!current) return;
        setLoaded({ units, allInactive: hidden.length > 0 });
        setProblem(null);
      })
      .catch(
        (err) =>
          current &&
          setProblem(statusOf(err) === 403 ? t.noAccess : t.loadError),
      );
    return () => {
      current = false;
    };
  }, [allowed, showInactive, t]);

  const header = (
    <PageHeader
      title={o.title}
      description={o.description}
      actions={
        allowed && (
          <ButtonLink href={`${base}/new`}>
            <Plus className="size-4" aria-hidden />
            {o.add.facility}
          </ButtonLink>
        )
      }
    />
  );
  if (!allowed) {
    return (
      <>
        {header}
        <EmptyState>{t.noAccess}</EmptyState>
      </>
    );
  }

  const units = loaded ? inTreeOrder(loaded.units) : [];
  // The switch is only useful once something exists to be switched off.
  const hasUnits = units.length > 0 || showInactive || loaded?.allInactive;

  return (
    <>
      {header}
      {hasUnits && (
        <label className="mt-4 flex w-fit items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4 accent-accent"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          {o.showInactive}
        </label>
      )}
      <div className="mt-4">
        <Panel>
          {problem ? (
            <EmptyState>{problem}</EmptyState>
          ) : !loaded ? (
            <EmptyState>{t.loading}</EmptyState>
          ) : units.length === 0 ? (
            <div className="flex flex-col items-center pb-10">
              <EmptyState>
                {loaded.allInactive ? o.allInactive : o.empty}
              </EmptyState>
              <ButtonLink href={`${base}/new`}>
                <Plus className="size-4" aria-hidden />
                {o.addFirst}
              </ButtonLink>
            </div>
          ) : (
            <ul aria-label={o.listLabel}>
              {units.map((unit) => {
                const child = childType[unit.type];
                return (
                  <li
                    key={unit.id}
                    className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-3 pe-4 last:border-0 ${indent[unit.type]}`}
                  >
                    <div className="min-w-0 flex-1 basis-48">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <Link
                          href={`${base}/${unit.id}`}
                          className={`font-medium break-words hover:text-accent hover:underline ${unit.active ? "" : "text-muted"}`}
                        >
                          {/* A name a client wrote keeps its own direction. */}
                          <bdi>
                            {pick(
                              unit.name,
                              lang,
                              session.tenant.defaultLocale,
                            )}
                          </bdi>
                        </Link>
                        {!unit.active && (
                          <Pill tone="neutral">{o.inactive[unit.type]}</Pill>
                        )}
                      </div>
                      <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs text-muted">
                        <span>{o.type[unit.type]}</span>
                        <bdi dir="ltr" className="font-mono">
                          {unit.code}
                        </bdi>
                      </p>
                    </div>
                    {/* Nothing new goes under a unit that is switched off. */}
                    {child && unit.active && (
                      <ButtonLink
                        href={`${base}/${unit.id}/new`}
                        variant="secondary"
                      >
                        <Plus className="size-4" aria-hidden />
                        {o.add[child]}
                      </ButtonLink>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
