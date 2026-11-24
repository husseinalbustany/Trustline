import { X } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  navigation,
  type NavGroupKey,
  type NavItemKey,
} from "@/config/navigation";
import type { Locale } from "@/i18n/config";

export type SidebarLabels = {
  appName: string;
  navigation: string;
  closeMenu: string;
  phase2: string;
  groups: Record<NavGroupKey, string>;
  items: Record<NavItemKey, string>;
};

// Paths that belong to a menu item without being under its own path.
const alsoActive: Partial<Record<NavItemKey, string>> = {
  users: "/admin/roles",
};

export function Sidebar({
  lang,
  pathname,
  labels,
  open,
  onClose,
  organization,
  permissions,
}: {
  lang: Locale;
  pathname: string;
  labels: SidebarLabels;
  /** The signed-in user's hospital, shown under the product name. */
  organization: string;
  permissions: string[];
  /** Whether the drawer is open on small screens. Always shown on large ones. */
  open: boolean;
  onClose: () => void;
}) {
  const under = (href: string) => {
    const full = `/${lang}${href}`;
    return pathname === full || pathname.startsWith(`${full}/`);
  };
  const isActive = (key: NavItemKey, href: string) =>
    under(href) || (alsoActive[key] ? under(alsoActive[key]) : false);

  const groups = navigation
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          !item.permissions ||
          item.permissions.some((p) => permissions.includes(p)),
      ),
    }))
    .filter((group) => group.items.length > 0);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/40 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={`${
          open ? "flex" : "hidden"
        } fixed inset-y-0 start-0 z-40 w-72 flex-col border-e border-line bg-surface lg:sticky lg:top-0 lg:z-auto lg:flex lg:h-dvh lg:w-64 lg:shrink-0`}
      >
        <div className="flex h-14 shrink-0 items-center justify-between px-4">
          <Link
            href={`/${lang}/dashboard`}
            onClick={onClose}
            className="flex items-center gap-2 font-semibold tracking-tight"
          >
            <span
              className="flex size-7 items-center justify-center rounded-md bg-accent text-sm text-accent-fg"
              aria-hidden
            >
              T
            </span>
            {labels.appName}
          </Link>
          <button
            type="button"
            onClick={onClose}
            aria-label={labels.closeMenu}
            className="rounded-md p-2 text-muted hover:bg-line hover:text-foreground lg:hidden"
          >
            <X className="size-5" aria-hidden />
          </button>
        </div>

        <nav
          aria-label={labels.navigation}
          className="flex-1 overflow-y-auto px-3 pb-6"
        >
          <p className="truncate px-2 pt-1 text-sm text-muted">
            {organization}
          </p>
          {groups.map((group) => (
            <div key={group.key} className="mt-5 first:mt-2">
              <h2 className="px-2 text-xs font-medium text-muted">
                {labels.groups[group.key]}
              </h2>
              <ul className="mt-1 space-y-0.5">
                {group.items.map(
                  ({ key, href: itemHref, icon: Icon, phase }) => {
                    // Someone who manages roles but not users starts on Roles.
                    const href =
                      key === "users" && !permissions.includes("users.manage")
                        ? "/admin/roles"
                        : itemHref;
                    const active = isActive(key, itemHref);
                    return (
                      <li key={key}>
                        <Link
                          href={`/${lang}${href}`}
                          onClick={onClose}
                          aria-current={active ? "page" : undefined}
                          className={`flex items-center gap-3 rounded-md px-2 py-2 text-sm ${
                            active
                              ? "bg-accent-soft font-medium text-accent"
                              : "text-foreground hover:bg-line"
                          }`}
                        >
                          <Icon
                            className={`size-4 shrink-0 ${active ? "" : "text-muted"}`}
                            aria-hidden
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {labels.items[key]}
                          </span>
                          {phase === 2 && <Badge>{labels.phase2}</Badge>}
                        </Link>
                      </li>
                    );
                  },
                )}
              </ul>
            </div>
          ))}
        </nav>
      </aside>
    </>
  );
}
