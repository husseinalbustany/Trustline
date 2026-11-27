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
      { key: "incidents", href: "/incidents", icon: TriangleAlert },
      {
        key: "investigations",
        href: "/investigations",
        icon: SearchCheck,
        phase: 2,
      },
      { key: "actions", href: "/actions", icon: ListChecks },
    ],
  },
  {
    key: "governance",
    items: [
      { key: "policies", href: "/policies", icon: FileText },
      { key: "risks", href: "/risks", icon: ShieldAlert, phase: 2 },
      { key: "training", href: "/training", icon: GraduationCap, phase: 2 },
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
