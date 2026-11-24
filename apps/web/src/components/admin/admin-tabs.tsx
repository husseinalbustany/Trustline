import Link from "next/link";
import { can, useSession } from "@/components/shell/session";
import type { AdminProps } from "./types";

/** Switches between the Users and Roles pages. */
export function AdminTabs({
  lang,
  t,
  current,
}: AdminProps & { current: "users" | "roles" }) {
  const session = useSession();
  const tabs = [
    {
      key: "users" as const,
      label: t.users.title,
      show: can(session, "users.manage"),
    },
    {
      key: "roles" as const,
      label: t.roles.title,
      show: can(session, "roles.manage"),
    },
  ].filter((tab) => tab.show);

  return (
    <nav
      className="mt-4 flex gap-1 border-b border-line"
      aria-label={t.tabsLabel}
    >
      {tabs.map((tab) => (
        <Link
          key={tab.key}
          href={`/${lang}/admin/${tab.key}`}
          aria-current={tab.key === current ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${
            tab.key === current
              ? "border-accent font-medium text-accent"
              : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
