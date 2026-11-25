"use client";

import { ExternalLink, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopy } from "@/lib/use-copy";
import type { IncidentsText } from "./types";

/**
 * The follow-up code of an anonymous report, shown the one time it exists
 * outside the reporter's hands: the API keeps only a hash of it.
 *
 * It lives in the state of the page that shows this, and nowhere else: it is
 * not put in the address, in storage or in a log, and that page drops it
 * when it is left.
 */
export function FollowUpCode({
  t,
  code,
  followUpHref,
}: {
  t: IncidentsText["code"];
  code: string;
  /** The page where the reference and this code are typed back. */
  followUpHref: string;
}) {
  const [copied, copy] = useCopy();
  // As the API writes it: groups of four.
  const groups = code.replace(/[^A-Za-z0-9]/g, "").match(/.{1,4}/g) ?? [code];

  return (
    <section className="flex flex-col gap-4 rounded-lg border-2 border-accent bg-background p-4 sm:p-5">
      <div>
        <h2 className="text-base font-semibold">{t.title}</h2>
        <p className="mt-1 text-sm text-muted">{t.help}</p>
      </div>
      <p
        dir="ltr"
        aria-label={t.label}
        className="grid grid-cols-2 justify-items-center gap-x-4 gap-y-2 rounded-md bg-surface px-3 py-4 font-mono text-3xl font-semibold tracking-widest select-all min-[30rem]:grid-cols-4 min-[30rem]:text-2xl"
      >
        {groups.map((group, index) => (
          <span key={index}>{group}</span>
        ))}
      </p>
      <div>
        <Button
          variant="secondary"
          className="h-12 w-full px-5 text-base sm:w-auto"
          onClick={() => copy(groups.join("-"))}
        >
          <span role="status">{copied ? t.copied : t.copy}</span>
        </Button>
      </div>
      <div className="flex gap-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1.5">
          <p className="font-semibold">{t.once}</p>
          <p>{t.keepSafe}</p>
        </div>
      </div>
      <p className="text-sm">
        {t.later}{" "}
        {/* In a new tab: this page, and the code on it, stays open. */}
        <a
          href={followUpHref}
          target="_blank"
          rel="noopener"
          className="inline-flex items-center gap-1 font-medium text-accent underline"
        >
          {t.open}
          <ExternalLink className="size-3.5 rtl:-scale-x-100" aria-hidden />
          <span className="sr-only">{t.newTab}</span>
        </a>
      </p>
    </section>
  );
}
