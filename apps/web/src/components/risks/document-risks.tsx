"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import { api } from "@/lib/api";
import { fill, numberFormat } from "@/lib/format";
import { pick, type Localized } from "@/lib/localized";
import { riskPath } from "@/lib/risks";

/**
 * On a document's page: in how many risks it is a control, with those the
 * reader may open. Nothing while the risks module is off, or for none.
 */
export function DocumentRisks({
  lang,
  documentId,
  label,
}: {
  lang: string;
  documentId: string;
  /** "Controls in {count} risks". */
  label: string;
}) {
  const session = useSession();
  const on = hasModule(session, "risks");
  const [data, setData] = useState<{
    total: number;
    items: { id: string; reference: string; title: Localized }[];
  } | null>(null);
  useEffect(() => {
    if (!on) return;
    let current = true;
    api<{ total: number; items: { id: string; reference: string; title: Localized }[] }>(
      `/risks/for-document/${documentId}`,
    )
      .then((next) => current && setData(next))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [on, documentId]);
  if (!on || !data || data.total === 0) return null;
  return (
    <div>
      <dt className="text-xs text-muted">
        {fill(label, { count: numberFormat(lang).format(data.total) })}
      </dt>
      <dd className="mt-1">
        <ul className="flex flex-col gap-0.5">
          {data.items.map((r) => (
            <li key={r.id}>
              <Link href={riskPath(lang, r.id)} className="text-accent hover:underline">
                <bdi dir="ltr">{r.reference}</bdi>{" "}
                <bdi>{pick(r.title, lang, session.tenant.defaultLocale)}</bdi>
              </Link>
            </li>
          ))}
        </ul>
      </dd>
    </div>
  );
}
