/**
 * The parts of the product a client can have, as the code knows them. A
 * module is code, so this list is a constant: adding one means building it.
 * Which client has which module is data (plans and subscriptions), and so is
 * everything a plan holds.
 *
 * Core (sign-in, users, roles, the organization's structure, languages,
 * notifications, the audit trail, settings) is not on this list: every
 * client has it, always.
 */
export const MODULES = [
  'incidents',
  'investigations',
  'actions',
  'policies',
  'risks',
  'training',
  'ai_assistant',
] as const;

export type ModuleCode = (typeof MODULES)[number];

/** What a route, a permission or a notification belongs to. */
export type ModuleKey = ModuleCode | 'core';

export type ModuleRule = {
  /** Whether any of it is built yet. Only built modules have routes. */
  built: boolean;
  /**
   * The modules of which at least one must be on for this one to be on.
   * Empty: it stands on core alone.
   */
  requiresAnyOf: readonly ModuleCode[];
};

/** What each module needs, from docs/specs/modules-and-subscriptions.md. */
export const MODULE_RULES: Record<ModuleCode, ModuleRule> = {
  incidents: { built: true, requiresAnyOf: [] },
  // Root cause analysis of incidents: nothing to analyse without them.
  investigations: { built: false, requiresAnyOf: ['incidents'] },
  // Fed by any other module that is on, but a tracker on its own works.
  actions: { built: false, requiresAnyOf: [] },
  policies: { built: false, requiresAnyOf: [] },
  risks: { built: false, requiresAnyOf: [] },
  training: { built: false, requiresAnyOf: [] },
  // Assists another module: on its own it has nothing to assist.
  ai_assistant: {
    built: false,
    requiresAnyOf: MODULES.filter((m) => m !== 'ai_assistant'),
  },
};

export const isModuleCode = (value: string): value is ModuleCode =>
  (MODULES as readonly string[]).includes(value);

/**
 * The first module in this set whose needs the set does not meet, with what
 * it needs; null when every one is met.
 */
export function missingDependency(
  modules: Iterable<ModuleCode>,
): { module: ModuleCode; requiresAnyOf: ModuleCode[] } | null {
  const on = new Set(modules);
  for (const module of MODULES) {
    if (!on.has(module)) continue;
    const { requiresAnyOf } = MODULE_RULES[module];
    if (requiresAnyOf.length > 0 && !requiresAnyOf.some((m) => on.has(m))) {
      return { module, requiresAnyOf: [...requiresAnyOf] };
    }
  }
  return null;
}

/**
 * The modules of a set that can be on together: those whose needs are met,
 * repeated until nothing more falls away, in the order of MODULES. What the
 * API enforces when a subscription is saved; applied again when one is
 * read, so that a plan changed under a subscription can never switch on a
 * module whose needs are gone.
 */
export function usableModules(modules: Iterable<string>): ModuleCode[] {
  let on = new Set([...modules].filter(isModuleCode));
  for (;;) {
    const broken = missingDependency(on);
    if (!broken) break;
    on = new Set([...on].filter((m) => m !== broken.module));
  }
  return MODULES.filter((m) => on.has(m));
}

/** What a plan can limit. Null, for any of them, means no limit. */
export const LIMITS = [
  'users',
  'sites',
  'storageMb',
  'aiCreditsPerMonth',
] as const;

export type LimitKey = (typeof LIMITS)[number];

export type Limits = Record<LimitKey, number | null>;

/** The limits counted and enforced today. The others are stored only. */
export const ENFORCED_LIMITS = [
  'users',
  'sites',
] as const satisfies readonly LimitKey[];

export type EnforcedLimit = (typeof ENFORCED_LIMITS)[number];

/** What a plan can include besides modules and limits. */
export const EXTRAS = [
  'sso',
  'publicReporting',
  'clinicalAiSuggestions',
] as const;

export type ExtraKey = (typeof EXTRAS)[number];

export type Extras = Record<ExtraKey, boolean>;

export const SUBSCRIPTION_STATUSES = [
  'trial',
  'active',
  'past_due',
  'suspended',
  'cancelled',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
