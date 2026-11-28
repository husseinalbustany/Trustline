import type { ModuleCode } from '../subscriptions/modules.js';

/**
 * The AI features (docs/specs/ai-providers-and-allowances.md), each served
 * by the connection and model Trustline's staff choose for the client, or
 * not offered.
 */
export const AI_FEATURES = ['drafting', 'insights', 'assistant'] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const isAiFeature = (value: string): value is AiFeature =>
  (AI_FEATURES as readonly string[]).includes(value);

/**
 * The modules a feature assists: at least one must be on, as well as the
 * AI module itself. Drafting writes policies and procedures; insights are
 * on incidents, investigations, actions and risks; the assistant serves
 * whichever modules are on (the AI module already needs one).
 */
export const FEATURE_MODULES: Record<AiFeature, readonly ModuleCode[]> = {
  drafting: ['policies'],
  insights: ['incidents', 'investigations', 'actions', 'risks'],
  assistant: [],
};

/** A monthly allowance per feature. Null: no limit. Zero: not included. */
export type AiAllowances = Record<AiFeature, number | null>;

/** No AI included: what a plan has until Trustline's staff set it. */
export const NO_AI_ALLOWANCES: AiAllowances = { drafting: 0, insights: 0, assistant: 0 };

/**
 * The starting figures of the spec's table, per month: drafts,
 * suggestions on incidents, assistant messages.
 */
export const SPEC_ALLOWANCES = {
  essentials: { drafting: 10, insights: 50, assistant: 0 },
  professional: { drafting: 50, insights: 500, assistant: 1_000 },
  enterprise: { drafting: 200, insights: 2_000, assistant: 5_000 },
} as const satisfies Record<string, AiAllowances>;

/** The plan's allowances, with the client's overrides over them. */
export function effectiveAllowances(
  plan: Partial<AiAllowances> | null | undefined,
  overrides: Partial<AiAllowances> | null | undefined,
): AiAllowances {
  const out = {} as AiAllowances;
  for (const feature of AI_FEATURES) {
    out[feature] =
      overrides && Object.hasOwn(overrides, feature)
        ? (overrides[feature] ?? null)
        : plan && Object.hasOwn(plan, feature)
          ? (plan[feature] ?? null)
          : 0;
  }
  return out;
}

/**
 * How many requests one draft takes in, in a month: its questions, the
 * draft and its revisions together (spec, decision 7, "the questions, the
 * draft and up to 5 revisions", read on the server, which cannot tell a
 * revision from a question: security review 13, M4). The next request
 * opens another draft, and so does the first in a new month.
 */
export const REQUESTS_PER_DRAFT = 20;

/** The share of an allowance at which the administrators are warned. */
export const WARNING_SHARE = 0.8;

/**
 * A request still under way after this long is taken to have died with its
 * process: it no longer counts against an allowance or a spending limit.
 * Far longer than a request can take (two attempts at the longest timeout).
 */
export const PENDING_STALE_MINUTES = 15;
