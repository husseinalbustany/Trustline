"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { inviteUrl, type Invite } from "@/lib/identity";

export type InviteLinkText = {
  title: string;
  help: string;
  copy: string;
  copied: string;
};

/** Shows a one-time set-password link for the person to pass on. */
export function InviteLink({
  lang,
  invite,
  t,
}: {
  lang: string;
  invite: Invite;
  t: InviteLinkText;
}) {
  const [copied, setCopied] = useState(false);
  const url = inviteUrl(lang, invite);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // Clipboard blocked: the link is selectable below.
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-accent bg-accent-soft p-4"
    >
      <p className="text-sm font-medium">{t.title}</p>
      <p className="text-sm text-muted">{t.help}</p>
      <code
        dir="ltr"
        className="block rounded-md bg-background p-2 text-xs break-all select-all"
      >
        {url}
      </code>
      <div>
        <Button variant="secondary" onClick={copy} className="bg-background">
          {copied ? t.copied : t.copy}
        </Button>
      </div>
    </div>
  );
}
