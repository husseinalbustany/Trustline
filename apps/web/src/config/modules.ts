/**
 * The parts of the product a client can have, as the API names them
 * (`tenant.modules` in `/auth/me`). Core (sign-in, users, roles, the
 * organization's structure, notifications, reports, settings) is not on the
 * list: every client has it.
 *
 * Where each module shows itself is said once:
 * - menu items and the pages under them: `module` on the item in
 *   `navigation.ts`;
 * - dashboard tiles and panels: `dashboardTiles` and `dashboardPanels` in
 *   `navigation.ts`;
 * - anything else that belongs to a module (a settings panel, a button in
 *   the top bar): `features` below.
 * A module that is off shows none of them, and its pages show that it is
 * not part of the subscription.
 */
export const moduleCodes = [
  "incidents",
  "investigations",
  "actions",
  "policies",
  "risks",
  "training",
  "ai_assistant",
] as const;

export type ModuleCode = (typeof moduleCodes)[number];

/** What something belongs to: a module, or core, which every client has. */
export type ModuleKey = ModuleCode | "core";

export const isModuleCode = (value: string): value is ModuleCode =>
  (moduleCodes as readonly string[]).includes(value);

export type ModuleRule = {
  /** Whether this app has its screens. The others show what they will cover. */
  built: boolean;
  /**
   * At least one of these must be on for this module to be on, as the API
   * enforces it. Empty: it stands on core alone.
   */
  requiresAnyOf: readonly ModuleCode[];
};

export const moduleRules: Record<ModuleCode, ModuleRule> = {
  incidents: { built: true, requiresAnyOf: [] },
  investigations: { built: false, requiresAnyOf: ["incidents"] },
  actions: { built: false, requiresAnyOf: [] },
  policies: { built: false, requiresAnyOf: [] },
  risks: { built: false, requiresAnyOf: [] },
  training: { built: false, requiresAnyOf: [] },
  ai_assistant: {
    built: false,
    requiresAnyOf: moduleCodes.filter((m) => m !== "ai_assistant"),
  },
};

/** The parts of screens that belong to a module, apart from menus and tiles. */
export const features = {
  /** "Report an incident" in the top bar. */
  reportButton: "incidents",
  /** Settings: reporting without sign-in, and the deadlines. */
  reportingSettings: "incidents",
  deadlineSettings: "incidents",
  /** A unit's own reporting link and QR code, on its page. */
  unitReporting: "incidents",
  /** The note on the notifications page about what "Serious" marks. */
  seriousNotifications: "incidents",
} as const satisfies Record<string, ModuleKey>;

/**
 * The module a permission belongs to: the word before its dot when that is
 * a module (`incidents.report`), core otherwise (`users.manage`,
 * `reports.view`). The same as the API's `PERMISSION_MODULE`.
 */
export function permissionModule(permission: string): ModuleKey {
  const [head] = permission.split(".");
  return isModuleCode(head) ? head : "core";
}

/** Whether a client with these modules has this one; core always. */
export const moduleOn = (
  modules: readonly string[] | undefined,
  module: ModuleKey,
) => module === "core" || !!modules?.includes(module);
