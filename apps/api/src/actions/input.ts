import { z } from 'zod';
import {
  actionEffectiveness,
  actionHierarchy,
  actionStrength,
} from '../database/schema.js';
import { localizedText, optionalLocalizedText } from '../i18n/locales.js';
import { text } from '../i18n/text.js';

/**
 * What the shared actions engine takes, whichever module's route it comes
 * through (docs/specs/actions.md). Strict objects: an unknown field is 400.
 */

const revision = z.number().int().min(1);
const day = z.iso.date();

export const createActionSchema = z.strictObject({
  // The source's revision (for a risk, the risk's).
  revision,
  title: localizedText(300),
  description: optionalLocalizedText(4000),
  ownerId: z.uuid(),
  // None: the source's unit. Null: the whole organization.
  orgUnitId: z.uuid().nullable().optional(),
  dueOn: day,
  strength: z.enum(actionStrength.enumValues),
  hierarchy: z.enum(actionHierarchy.enumValues).nullable().default(null),
});
export type CreateActionInput = z.infer<typeof createActionSchema>;

export const updateActionSchema = z.strictObject({
  // The action's.
  revision,
  title: localizedText(300).optional(),
  description: optionalLocalizedText(4000).optional(),
  ownerId: z.uuid().optional(),
  orgUnitId: z.uuid().nullable().optional(),
  dueOn: day.optional(),
  strength: z.enum(actionStrength.enumValues).optional(),
  hierarchy: z.enum(actionHierarchy.enumValues).nullable().optional(),
  // Progress: open or in progress. Completing, verifying, cancelling and
  // reopening have routes of their own.
  status: z.enum(['open', 'in_progress']).optional(),
  // Required with a new due day.
  reason: text(1, 1000).optional(),
});
export type UpdateActionInput = z.infer<typeof updateActionSchema>;

export const completeActionSchema = z.strictObject({
  revision,
  // What was done: the evidence.
  note: text(1, 4000),
});

export const verifyActionSchema = z.strictObject({
  revision,
  outcome: z.enum(actionEffectiveness.enumValues),
  note: text(1, 4000).optional(),
});

export const reasonSchema = z.strictObject({ revision, reason: text(1, 1000) });
