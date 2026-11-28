import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { AiModel } from '../database/schema.js';
import { line } from '../i18n/text.js';
import { AI_FEATURES } from './features.js';
import { AI_PROVIDER_KINDS, INFERENCE_TYPES, type AiProviderKind, type InferenceType } from './provider.js';
import { CREDENTIAL_ENV } from './providers.js';

/** A provider's id for a model: letters, digits and `.`, `-`, `_`, `:`, `/`. */
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);

/** Dollars per million tokens. */
const price = z.number().min(0).max(1000);

const modelSchema = z.strictObject({
  id: modelId,
  label: line(1, 100),
  inputUsdPerMTok: price,
  outputUsdPerMTok: price,
});

const models = z
  .array(modelSchema)
  .min(1)
  .max(30)
  .refine((list) => new Set(list.map((m) => m.id)).size === list.length);

const connectionFields = {
  name: line(1, 100),
  region: z.string().regex(/^[a-z0-9-]{2,30}$/),
  inferenceType: z.enum(INFERENCE_TYPES),
  models,
  credentialEnv: z.string().regex(CREDENTIAL_ENV),
  active: z.boolean(),
};

export const createConnectionSchema = z.strictObject({
  ...connectionFields,
  kind: z.enum(AI_PROVIDER_KINDS),
  active: connectionFields.active.default(true),
});

/** The kind is fixed once created: it decides what the rest means. */
export const updateConnectionSchema = z.strictObject(connectionFields).partial();

export type CreateConnectionInput = z.infer<typeof createConnectionSchema>;
export type UpdateConnectionInput = z.infer<typeof updateConnectionSchema>;

const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/;
/** For the Anthropic API: the geography asked for (`us`, `eu`), or `global`. */
const GEOGRAPHY = /^[a-z]{2,10}$/;

/**
 * What a connection must be to say truly where it processes requests,
 * or 400 with a code:
 *
 * - `invalid_region`: an Amazon region code for Bedrock (`me-central-1`);
 *   for the Anthropic API, `global` with global inference, or the
 *   geography asked for (`us`) with regional;
 * - `inference_type_not_offered`: in-region with the Anthropic API, which
 *   does not offer it;
 * - `model_inference_mismatch` (with `model`): a Bedrock model id that
 *   does not process where the connection says. Global: a `global.`
 *   profile. Regional: a geography's profile (`eu.`, `us.`, `apac.`).
 *   In-region: the model itself, with no profile, or an ARN.
 */
export function assertConnection(c: {
  kind: AiProviderKind;
  region: string;
  inferenceType: InferenceType;
  models: AiModel[];
}) {
  const refuse = (code: string, extra: Record<string, unknown> = {}) => {
    throw new BadRequestException({ code, ...extra });
  };
  if (c.kind === 'anthropic') {
    if (c.inferenceType === 'in_region') refuse('inference_type_not_offered');
    if (c.inferenceType === 'global' && c.region !== 'global') refuse('invalid_region');
    if (c.inferenceType === 'regional' && (!GEOGRAPHY.test(c.region) || c.region === 'global')) refuse('invalid_region');
    return;
  }
  if (!AWS_REGION.test(c.region)) refuse('invalid_region');
  for (const model of c.models) {
    if (model.id.startsWith('arn:')) {
      if (c.inferenceType !== 'in_region') refuse('model_inference_mismatch', { model: model.id });
      continue;
    }
    const parts = model.id.split('.');
    const ok =
      c.inferenceType === 'global'
        ? parts[0] === 'global' && parts.length >= 3
        : c.inferenceType === 'regional'
          ? parts.length >= 3 && parts[0] !== 'global'
          : parts.length === 2;
    if (!ok) refuse('model_inference_mismatch', { model: model.id });
  }
}

/** An allowance: a whole number from zero, or null for no limit. */
const allowance = z.number().int().min(0).max(10_000_000).nullable();

/** Every feature said: what a plan holds. */
export const aiAllowancesSchema = z.strictObject({
  drafting: allowance,
  insights: allowance,
  assistant: allowance,
});

/** Dollars a month, to the cent. */
const dollars = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine((v) => Math.abs(Math.round(v * 100) - v * 100) < 1e-6);

const featureChoice = z
  .strictObject({
    connectionId: z.uuid(),
    model: modelId,
    quickModel: modelId.nullable().default(null),
  })
  .nullable();

/** What Trustline's staff set for a client. Every part optional. */
export const clientAiSchema = z
  .strictObject({
    offered: z.boolean(),
    features: z
      .strictObject(Object.fromEntries(AI_FEATURES.map((f) => [f, featureChoice])) as Record<(typeof AI_FEATURES)[number], typeof featureChoice>)
      .partial(),
    // Replaces the overrides as a whole: a feature left out follows the plan.
    allowanceOverrides: aiAllowancesSchema.partial(),
    medicalOptionAllowed: z.boolean(),
    monthlySpendingLimitUsd: dollars.nullable(),
  })
  .partial();

export type ClientAiInput = z.infer<typeof clientAiSchema>;

export const platformAiSchema = z.strictObject({
  monthlySpendingLimitUsd: dollars.nullable(),
});

/** The client's own switch. */
export const clientSwitchSchema = z.strictObject({ enabled: z.boolean() });

export const testConnectionSchema = z
  .strictObject({ model: modelId })
  .partial()
  .optional()
  .transform((v) => v ?? {});
