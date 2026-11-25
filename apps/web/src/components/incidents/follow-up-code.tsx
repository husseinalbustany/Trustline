"use client";

import { ExternalLink, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyLink } from "@/components/ui/copy-link";
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
  followUpAddress,
}: {
  t: IncidentsText["code"];
  code: string;
  /** The page where this code is typed back, in the reader's language. */
  followUpHref: string;
  /** The same page as an address to keep with the code. */
  followUpAddress: string;
}) {
  const [copied, copy] = useCopy();
  // As the API writes it, as it is copied and as the follow-up page shows
  // it: groups of four with hyphens between them.
  const written = (
    code.replace(/[^A-Za-z0-9]/g, "").match(/.{1,4}/g) ?? [code]
  ).join("-");

  return (
    <section className="flex flex-col gap-4 rounded-lg border-2 border-accent bg-background p-4 sm:p-5">
      <div>
        <h2 className="text-base font-semibold">{t.title}</h2>
        <p className="mt-1 text-sm text-muted">{t.help}</p>
      </div>
      {/* One string, left to right, on one line: in separate groups a
          reader of a right-to-left page starts from the other end, and a
          code written down in the wrong order is lost for good. */}
      <p
        dir="ltr"
        aria-label={t.label}
        className="rounded-md bg-surface px-3 py-4 text-center font-mono text-lg font-semibold tracking-wide whitespace-nowrap select-all min-[22.5rem]:text-xl min-[30rem]:text-2xl"
      >
        {written}
      </p>
      <div>
        <Button
          variant="secondary"
          className="h-12 w-full px-5 text-base sm:w-auto"
          onClick={() => copy(written)}
        >
          {copied ? t.copied : t.copy}
        </Button>
        {/* Said aloud once, for someone who does not see the button change. */}
        <span role="status" className="sr-only">
          {copied ? t.copied : ""}
        </span>
      </div>
      <div className="flex gap-3 rounded-md bg-danger-soft p-3 text-sm text-danger">
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1.5">
          <p className="font-semibold">{t.once}</p>
          <p>{t.keepSafe}</p>
        </div>
      </div>
      {/* The address to keep with the code: this card is shown once, and it
          may be the reader's only way back to the follow-up page. */}
      <CopyLink
        label={t.later}
        url={followUpAddress}
        t={{ copy: t.copyAddress, copied: t.copied }}
        roomy
      />
      <p className="text-sm">
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
