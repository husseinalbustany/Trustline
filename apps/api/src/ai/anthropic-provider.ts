import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from '@anthropic-ai/sdk';
import {
  AiProviderError,
  assertNoNetworkUnderTest,
  type AiProvider,
  type ProviderCall,
  type ProviderFailure,
  type ProviderRequest,
  type ProviderResult,
} from './provider.js';

/** Fixed, so that no environment variable can send requests elsewhere. */
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

type Options = {
  /**
   * Where Anthropic is asked to process requests (`inference_geo`), for a
   * connection that is `regional`. Unset: the workspace's default.
   */
  inferenceGeo?: string | null;
  /** For the adapter's own tests: a fetch that reaches no network. */
  fetch?: typeof fetch;
};

/** Claude through the Anthropic API, with the official SDK. */
export class AnthropicProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly options: Options = {},
  ) {
    assertNoNetworkUnderTest('anthropic', options.fetch);
  }

  async complete(request: ProviderRequest, call: ProviderCall): Promise<ProviderResult> {
    const client = new Anthropic({
      apiKey: this.apiKey,
      authToken: null,
      baseURL: ANTHROPIC_BASE_URL,
      // One retry is AiService's to make, after its own checks.
      maxRetries: 0,
      timeout: call.timeoutMs,
      // Whatever ANTHROPIC_LOG says: at debug, the SDK would write request
      // bodies, record text included, to the log (security review 13, L5).
      logLevel: 'off',
      ...(this.options.fetch && { fetch: this.options.fetch }),
    });
    try {
      const message = await client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          ...(request.system && { system: request.system }),
          messages: request.messages,
          ...(this.options.inferenceGeo && { inference_geo: this.options.inferenceGeo }),
          ...(request.output && {
            output_config: { format: { type: 'json_schema' as const, schema: request.output.schema } },
          }),
        },
        { signal: call.signal },
      );
      return {
        text: message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join(''),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
    } catch (e) {
      throw new AiProviderError(failureOf(e));
    }
  }
}

/**
 * What kind of failure an SDK error is. The same for the Bedrock client,
 * which raises the same errors.
 */
export function failureOf(e: unknown): ProviderFailure {
  if (e instanceof AiProviderError) return e.failure;
  if (e instanceof APIConnectionTimeoutError || e instanceof APIUserAbortError) return 'timeout';
  if (e instanceof APIConnectionError) return 'connection';
  if (e instanceof APIError) {
    const status = e.status ?? 0;
    if (status === 401 || status === 403) return 'auth';
    if (status === 408) return 'timeout';
    if (status === 429) return 'rate_limited';
    if (status === 529) return 'overloaded';
    if (status >= 500) return 'server';
    if (status >= 400) return 'bad_request';
  }
  if (e instanceof Error && e.name === 'AbortError') return 'timeout';
  return 'other';
}
