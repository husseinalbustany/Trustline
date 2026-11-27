import { z } from 'zod';
import {
  localizedText,
  optionalLocalizedText,
  SUPPORTED_LOCALES,
  type Localized,
} from '../i18n/locales.js';
import { optionalText } from '../i18n/text.js';
import { MODULES, SUBSCRIPTION_STATUSES } from './modules.js';

/** A limit: a whole number from zero, or null for no limit. */
const limit = z.number().int().min(0).max(1_000_000_000).nullable();

/** Every limit a plan sets, each said: null is "no limit", never "unsaid". */
export const limitsSchema = z.strictObject({
  users: limit,
  sites: limit,
  storageMb: limit,
  aiCreditsPerMonth: limit,
});

/** Only the limits that differ from the plan's. */
export const overridesSchema = limitsSchema.partial();

export const extrasSchema = z.strictObject({
  sso: z.boolean(),
  publicReporting: z.boolean(),
  clinicalAiSuggestions: z.boolean(),
});

/** Module codes, each once, in the order of MODULES. Never core. */
export const moduleList = z
  .array(z.enum(MODULES))
  .max(MODULES.length * 2)
  .transform((list) => MODULES.filter((m) => list.includes(m)));

const priceSchema = z.strictObject({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: z.number().int().min(0).max(1_000_000_000_000),
  term: z.enum(['monthly', 'yearly']),
  basis: z.enum(['flat', 'per_user', 'per_site']),
});

const planFields = {
  name: localizedText(100),
  description: optionalLocalizedText(1000),
  modules: moduleList,
  limits: limitsSchema,
  extras: extrasSchema,
  prices: z.array(priceSchema).max(20),
  active: z.boolean(),
  position: z.number().int().min(0).max(100_000),
};

export const createPlanSchema = z.strictObject({
  // Lowercase letters, digits, `_` and `-`. Fixed once created.
  code: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,39}$/),
  ...planFields,
  description: planFields.description.optional(),
  prices: planFields.prices.default([]),
  active: planFields.active.default(true),
  position: planFields.position.default(0),
});

export const updatePlanSchema = z.strictObject(planFields).partial();

export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export type UpdatePlanInput = z.infer<typeof updatePlanSchema>;

const day = z.iso.date();

export const updateSubscriptionSchema = z
  .strictObject({
    planId: z.uuid(),
    status: z.enum(SUBSCRIPTION_STATUSES),
    startsOn: day,
    renewsOn: day.nullable(),
    trialEndsOn: day.nullable(),
    addOnModules: moduleList,
    limitOverrides: overridesSchema,
    note: optionalText(2000),
  })
  .partial();

export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

/**
 * Whether a plan's text is written in every language the product has: a
 * plan is Trustline's own, and any client, in any language, may be shown it.
 */
export const inEveryLanguage = (text: Localized | null | undefined) =>
  !text || SUPPORTED_LOCALES.every((locale) => !!text[locale]);
