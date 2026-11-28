"use client";

import Link from "next/link";
import { useSession } from "@/components/shell/session";
import { hasModule } from "@/components/shell/subscription";
import type { Dictionary } from "@/i18n/dictionaries";

type Tab = "general" | "profile" | "ai";

/**
 * The organization's settings, in parts: the general ones, its profile
 * (for whole-organization administrators) and AI (when it has the module).
 */
export function SettingsTabs({
  lang,
  t,
  current,
}: {
  lang: string;
  t: Dictionary["admin"]["settings"]["tabs"];
  current: Tab;
}) {
  const session = useSession();
  const whole = session.scope?.["settings.manage"] === "all";
  const tabs: { key: Tab; href: string; show: boolean }[] = [
    { key: "general", href: `/${lang}/admin/settings`, show: true },
    { key: "profile", href: `/${lang}/admin/settings/profile`, show: whole },
    { key: "ai", href: `/${lang}/admin/settings/ai`, show: hasModule(session, "ai_assistant") },
  ];
  const shown = tabs.filter((x) => x.show);
  if (shown.length < 2) return null;
  return (
    <nav aria-label={t.label} className="mt-4 flex gap-1 overflow-x-auto border-b border-line">
      {shown.map((x) => (
        <Link
          key={x.key}
          href={x.href}
          aria-current={x.key === current ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
            x.key === current
              ? "border-accent font-medium text-accent"
              : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          {t[x.key]}
        </Link>
      ))}
    </nav>
  );
}
