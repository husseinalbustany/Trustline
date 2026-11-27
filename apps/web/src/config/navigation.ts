import {
  Building2,
  ChartColumn,
  FileText,
  GraduationCap,
  LayoutDashboard,
  ListChecks,
  SearchCheck,
  Settings,
  ShieldAlert,
  TriangleAlert,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { Dictionary } from "@/i18n/dictionaries";
import type { ModuleKey } from "./modules";

export type ModuleKey =
  | "incidents"
  | "investigations"
  | "actions"
  | "policies"
  | "risks"
  | "training"
  | "reports"
  | "organization"
  | "users"
  | "settings";

export type NavItemKey = "dashboard" | ModuleKey;

/** The areas not built yet, which show what they will cover. */
export type PlaceholderKey = Exclude<
  ModuleKey,
  "incidents" | "organization" | "users" | "settings"
>;

export type NavGroupKey =
  | "overview"
  | "safety"
  | "governance"
  | "insights"
  | "administration";

export type NavItem = {
  key: NavItemKey;
  /** Path after the locale segment, e.g. /en + /incidents. */
  href: string;
  icon: LucideIcon;
  /** Delivery phase, shown as a badge when the module comes after the MVP. */
  phase?: 2;
  /** Shown only to users holding at least one of these permissions. */
  permissions?: string[];
  /**
   * The module it belongs to; core when left out. While the module is off
   * the item is not in the menu, and this page and every page under it
   * say that it is not part of the subscription.
   */
  module?: ModuleKey;
};

/** The single source for the sidebar: order, grouping, routes and icons. */
export const navigation: { key: NavGroupKey; items: NavItem[] }[] = [
  {
    key: "overview",
    items: [{ key: "dashboard", href: "/dashboard", icon: LayoutDashboard }],
  },
  {
    key: "safety",
    items: [
      {
        key: "incidents",
        href: "/incidents",
        icon: TriangleAlert,
        module: "incidents",
      },
      {
        key: "investigations",
        href: "/investigations",
        icon: SearchCheck,
        phase: 2,
        module: "investigations",
      },
      {
        key: "actions",
        href: "/actions",
        icon: ListChecks,
        module: "actions",
      },
    ],
  },
  {
    key: "governance",
    items: [
      {
        key: "policies",
        href: "/policies",
        icon: FileText,
        module: "policies",
      },
      {
        key: "risks",
        href: "/risks",
        icon: ShieldAlert,
        phase: 2,
        module: "risks",
      },
      {
        key: "training",
        href: "/training",
        icon: GraduationCap,
        phase: 2,
        module: "training",
      },
    ],
  },
  {
    key: "insights",
    items: [{ key: "reports", href: "/reports", icon: ChartColumn }],
  },
  {
    key: "administration",
    items: [
      {
        key: "organization",
        href: "/admin/organization",
        icon: Building2,
        permissions: ["organization.manage"],
      },
      {
        key: "users",
        href: "/admin/users",
        icon: Users,
        // Also marks /admin/roles as part of this item.
        permissions: ["users.manage", "roles.manage"],
      },
      {
        key: "settings",
        href: "/admin/settings",
        icon: Settings,
        // Someone who may triage reads the deadlines there, and no more.
        permissions: ["settings.manage", "incidents.triage"],
      },
    ],
  },
];

export const navItems = navigation.flatMap((group) => group.items);

/**
 * The module a page belongs to, from the menu item it sits under: `path` is
 * the address after the language, such as `/incidents/new`. Core for every
 * page that no module's item covers.
 */
export function moduleOfPath(path: string): ModuleKey {
  const item = navItems.find(
    (i) => i.module && (path === i.href || path.startsWith(`${i.href}/`)),
  );
  return item?.module ?? "core";
}

export type DashboardTileKey = keyof Dictionary["dashboard"]["tiles"];

/** The dashboard's figures, in order, each with the module it counts in. */
export const dashboardTiles: { key: DashboardTileKey; module: ModuleKey }[] = [
  { key: "openIncidents", module: "incidents" },
  { key: "awaitingTriage", module: "incidents" },
  { key: "seriousOpen", module: "incidents" },
  { key: "overdueIncidents", module: "incidents" },
  { key: "triagedOnTime", module: "incidents" },
  { key: "timeToReport", module: "incidents" },
  { key: "overdueActions", module: "actions" },
  { key: "policiesDue", module: "policies" },
];

/** The dashboard's panels under the figures. */
export const dashboardPanels = {
  recentIncidents: "incidents",
  // Only incidents are assigned so far; actions and reviews will join it.
  myTasks: "incidents",
} as const satisfies Record<string, ModuleKey>;
