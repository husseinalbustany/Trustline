import { Injectable, Logger } from '@nestjs/common';
import { AnthropicProvider } from './anthropic-provider.js';
import { BedrockProvider, bedrockCredentials } from './bedrock-provider.js';
import { FakeAiProvider } from './fake-provider.js';
import {
  AiProviderError,
  underTest,
  type AiProvider,
  type AiProviderKind,
  type InferenceType,
} from './provider.js';

/** What a provider is built from: a connection, as stored. */
export type ConnectionConfig = {
  kind: AiProviderKind;
  region: string;
  inferenceType: InferenceType;
  credentialEnv: string;
};

export type AiMode = 'fake' | 'real';

/**
 * Whether real providers are called, from the environment:
 *
 * - `AI_PROVIDERS=real` and `NODE_ENV=production`: real providers, each
 *   connection's credential read from the variable it names;
 * - anything else, including nothing at all: the fake provider for every
 *   connection. So no development run calls a real provider unless it is
 *   run as production, and none needs a credential;
 * - under test, always the fake, whatever is set. A real adapter built
 *   under test throws besides (`RealProviderUnderTestError`), and that
 *   fails the test.
 */
export function aiMode(env: NodeJS.ProcessEnv = process.env): { mode: AiMode; note: string | null } {
  const asked = env.AI_PROVIDERS?.trim() || 'fake';
  if (underTest(env)) return { mode: 'fake', note: null };
  if (asked === 'real' && env.NODE_ENV === 'production') return { mode: 'real', note: null };
  if (asked === 'real') {
    return { mode: 'fake', note: 'AI_PROVIDERS=real is ignored unless NODE_ENV=production: every AI request is answered by the fake provider' };
  }
  if (asked !== 'fake') {
    return { mode: 'fake', note: 'AI_PROVIDERS must be "fake" or "real": every AI request is answered by the fake provider' };
  }
  return { mode: 'fake', note: null };
}

/** Only variables of this form may hold a connection's credential. */
export const CREDENTIAL_ENV = /^AI_CREDENTIAL_[A-Z0-9_]{1,50}$/;

/**
 * Builds the provider for a connection. Credentials come only from the
 * environment, from the variable the connection names, and go no further
 * than the adapter: never logged, stored or returned.
 */
@Injectable()
export class AiProviders {
  private readonly logger = new Logger('AiProviders');
  readonly mode: AiMode;

  constructor() {
    const { mode, note } = aiMode();
    this.mode = mode;
    if (note) this.logger.warn(note);
    else if (!underTest()) this.logger.log(`AI requests are answered by ${mode === 'real' ? 'the configured providers' : 'the fake provider'}`);
  }

  /** Whether the variable a connection names is set. Never its value. */
  credentialsPresent(credentialEnv: string) {
    return CREDENTIAL_ENV.test(credentialEnv) && !!process.env[credentialEnv]?.trim();
  }

  /**
   * A provider for one request: a new one each time, which the request's
   * attempts share. In real mode, `credentials_missing` when the variable
   * is not set.
   */
  for(connection: ConnectionConfig): AiProvider {
    if (this.mode === 'fake') return new FakeAiProvider();
    if (!this.credentialsPresent(connection.credentialEnv)) {
      throw new AiProviderError('credentials_missing');
    }
    const credential = process.env[connection.credentialEnv]!.trim();
    switch (connection.kind) {
      case 'anthropic':
        return new AnthropicProvider(credential, {
          inferenceGeo: connection.inferenceType === 'regional' ? connection.region : null,
        });
      case 'bedrock':
        return new BedrockProvider(connection.region, bedrockCredentials(credential));
    }
  }
}
