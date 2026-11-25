"use client";

import { Button } from "@/components/ui/button";
import { useCopy } from "@/lib/use-copy";

/** A link to pass on: shown whole, with a button that copies it. */
export function CopyLink({
  label,
  help,
  url,
  t,
  roomy = false,
}: {
  label: string;
  help?: string;
  url: string;
  t: { copy: string; copied: string };
  /** A larger address and button, for the pages built for a phone first. */
  roomy?: boolean;
}) {
  const [copied, copy] = useCopy();

  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <p className="font-medium">{label}</p>
      <div className="flex flex-wrap items-center gap-2">
        <code
          dir="ltr"
          className={`min-w-0 flex-1 basis-64 rounded-md border border-line bg-surface px-3 break-all select-all ${
            roomy ? "py-3 text-sm" : "py-2 text-xs"
          }`}
        >
          {url}
        </code>
        <Button
          variant="secondary"
          className={roomy ? "h-12 px-5 text-base max-sm:w-full" : ""}
          onClick={() => copy(url)}
        >
          {copied ? t.copied : t.copy}
        </Button>
        {/* Said aloud once, for someone who does not see the button change. */}
        <span role="status" className="sr-only">
          {copied ? t.copied : ""}
        </span>
      </div>
      {help && <p className="text-xs text-muted">{help}</p>}
    </div>
  );
}
