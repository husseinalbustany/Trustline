/**
 * The one interface every AI provider is reached through
 * (docs/specs/ai-providers-and-allowances.md, "Providers"). Text in, text
 * out: a system text, the conversation, a ceiling on the answer's length,
 * optionally a JSON schema the answer must follow, a timeout, and what the
 * call used. Features never call a provider: they call `AiService.run()`,
 * which calls one of these.
 */

/** The kinds of provider connection Trustline can hold. */
export const AI_PROVIDER_KINDS = ['anthropic', 'bedrock'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

/**
 * Where a connection processes requests, as the client is told:
 * - `in_region`: in the connection's region only;
 * - `regional`: in any region of the region's geography (Bedrock's
 *   cross-region inference: us, eu, apac and so on);
 * - `global`: in any region the provider has.
 */
export const INFERENCE_TYPES = ['in_region', 'regional', 'global'] as const;
export type InferenceType = (typeof INFERENCE_TYPES)[number];

export type ProviderMessage = { role: 'user' | 'assistant'; content: string };

export type ProviderRequest = {
  /** The provider's own id for the model (Bedrock's differ from Anthropic's). */
  model: string;
  system?: string;
  messages: ProviderMessage[];
  maxTokens: number;
  /** A JSON schema the answer must follow, where the feature needs data. */
  output?: { schema: Record<string, unknown> };
};

export type ProviderUsage = { inputTokens: number; outputTokens: number };

export type ProviderResult = { text: string; usage: ProviderUsage };

export type ProviderCall = {
  /** How long the call may take, in milliseconds. */
  timeoutMs: number;
  signal: AbortSignal;
};

export interface AiProvider {
  complete(request: ProviderRequest, call: ProviderCall): Promise<ProviderResult>;
}

/** Why a call failed, as it is recorded. Never the provider's message. */
export const PROVIDER_FAILURES = [
  'timeout',
  'rate_limited',
  'overloaded',
  'server',
  'connection',
  'auth',
  'bad_request',
  'credentials_missing',
  'invalid_output',
  'other',
] as const;
export type ProviderFailure = (typeof PROVIDER_FAILURES)[number];

const RETRYABLE: ReadonlySet<ProviderFailure> = new Set([
  'timeout',
  'rate_limited',
  'overloaded',
  'server',
  'connection',
]);

/**
 * A provider's failure, by kind only: the provider's own message can quote
 * the request, so it is neither kept, logged nor shown.
 */
export class AiProviderError extends Error {
  readonly retryable: boolean;
  constructor(readonly failure: ProviderFailure) {
    super(`AI provider call failed: ${failure}`);
    this.name = 'AiProviderError';
    this.retryable = RETRYABLE.has(failure);
  }
}

/**
 * A real provider was about to be called by a test. Never caught and turned
 * into "unavailable": it is a fault of the code, and fails the test.
 */
export class RealProviderUnderTestError extends Error {
  constructor(kind: string) {
    super(`A real AI provider (${kind}) was called under test: tests use the fake provider only`);
    this.name = 'RealProviderUnderTestError';
  }
}

/** Whether this process is a test run (Vitest sets both). */
export const underTest = (env: NodeJS.ProcessEnv = process.env) =>
  env.VITEST === 'true' || env.NODE_ENV === 'test';

/**
 * Refuses to build a real adapter under test, unless it is given a `fetch`
 * of the test's own, which reaches no network: so no test can call a real
 * provider, and the adapters' own tests still run.
 */
export function assertNoNetworkUnderTest(kind: string, fetchOverride: unknown) {
  if (underTest() && !fetchOverride) throw new RealProviderUnderTestError(kind);
}

/** The text of an answer as JSON, for a request that asked for data. */
export function parseStructured(text: string): unknown {
  const trimmed = text.trim();
  // A model may wrap it in a code fence despite the schema.
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  try {
    return JSON.parse(fenced ? fenced[1] : trimmed);
  } catch {
    throw new AiProviderError('invalid_output');
  }
}
