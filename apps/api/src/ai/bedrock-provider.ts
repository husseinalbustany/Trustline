import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { failureOf } from './anthropic-provider.js';
import {
  AiProviderError,
  assertNoNetworkUnderTest,
  type AiProvider,
  type ProviderCall,
  type ProviderRequest,
  type ProviderResult,
} from './provider.js';

/**
 * How a Bedrock connection's credential variable is read. Either an Amazon
 * Bedrock API key, or `ACCESS_KEY_ID:SECRET_ACCESS_KEY`, optionally followed
 * by `:SESSION_TOKEN` (none of the three holds a colon).
 */
export type BedrockCredentials =
  | { apiKey: string }
  | { accessKeyId: string; secretAccessKey: string; sessionToken: string | null };

export function bedrockCredentials(value: string): BedrockCredentials {
  const parts = value.trim().split(':');
  if (parts.length === 2 || parts.length === 3) {
    const [accessKeyId, secretAccessKey, sessionToken] = parts;
    if (accessKeyId && secretAccessKey) {
      return { accessKeyId, secretAccessKey, sessionToken: sessionToken || null };
    }
  }
  return { apiKey: value.trim() };
}

type Options = {
  /** For the adapter's own tests: a fetch that reaches no network. */
  fetch?: typeof fetch;
};

/**
 * Claude (or another model) through Amazon Bedrock, with Anthropic's
 * Bedrock SDK. The region is the connection's; whether a request may be
 * processed elsewhere is the model id's (an inference profile such as
 * `global.` or `eu.`), which the connection holds and the portal checks
 * against the connection's inference type.
 */
export class BedrockProvider implements AiProvider {
  constructor(
    private readonly region: string,
    private readonly credentials: BedrockCredentials,
    private readonly options: Options = {},
  ) {
    assertNoNetworkUnderTest('bedrock', options.fetch);
  }

  async complete(request: ProviderRequest, call: ProviderCall): Promise<ProviderResult> {
    const common = {
      awsRegion: this.region,
      // Fixed, so that no environment variable can send requests elsewhere.
      baseURL: `https://bedrock-runtime.${this.region}.amazonaws.com`,
      maxRetries: 0,
      timeout: call.timeoutMs,
      // Whatever ANTHROPIC_LOG says: at debug, the SDK would write request
      // bodies, record text included, to the log (security review 13, L5).
      logLevel: 'off' as const,
      ...(this.options.fetch && { fetch: this.options.fetch }),
    };
    const client =
      'apiKey' in this.credentials
        ? new AnthropicBedrock({ ...common, apiKey: this.credentials.apiKey })
        : new AnthropicBedrock({
            ...common,
            // Null, not left out: left out, the SDK would read a bearer
            // token from the environment instead of signing.
            apiKey: null,
            awsAccessKey: this.credentials.accessKeyId,
            awsSecretKey: this.credentials.secretAccessKey,
            awsSessionToken: this.credentials.sessionToken,
          });
    try {
      const message = await client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxTokens,
          ...(request.system && { system: request.system }),
          messages: request.messages,
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
