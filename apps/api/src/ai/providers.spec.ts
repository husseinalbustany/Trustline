import { AnthropicProvider } from './anthropic-provider.js';
import { bedrockCredentials, BedrockProvider } from './bedrock-provider.js';
import { FakeAiProvider, fakeAi } from './fake-provider.js';
import {
  AiProviderError,
  parseStructured,
  RealProviderUnderTestError,
  underTest,
  type ProviderRequest,
} from './provider.js';
import { aiMode, AiProviders } from './providers.js';

const request: ProviderRequest = {
  model: 'claude-sonnet-5-5',
  system: 'Be brief.',
  messages: [{ role: 'user', content: 'Hello [PERSON_1]' }],
  maxTokens: 50,
};
const call = () => ({ timeoutMs: 5_000, signal: new AbortController().signal });

/** What the Messages API answers. */
const message = (text: string) => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-5-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 3 },
});

/** A fetch of the test's own: it reaches no network, and records what it was asked. */
function stubFetch(status: number, body: unknown) {
  const seen: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    seen.push({ url, headers: new Headers(init?.headers), body: JSON.parse(typeof init?.body === 'string' ? init.body : '{}') });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

describe('which providers answer', () => {
  it('knows it runs under test', () => {
    expect(underTest()).toBe(true);
  });

  it('is the fake provider when nothing is set, and always under test', () => {
    expect(aiMode({}).mode).toBe('fake');
    expect(aiMode({ VITEST: 'true', AI_PROVIDERS: 'real', NODE_ENV: 'production' }).mode).toBe('fake');
  });

  it('is the real providers only when asked for and run as production', () => {
    expect(aiMode({ AI_PROVIDERS: 'real', NODE_ENV: 'production' })).toEqual({ mode: 'real', note: null });
    expect(aiMode({ AI_PROVIDERS: 'real', NODE_ENV: 'development' })).toMatchObject({ mode: 'fake', note: expect.stringMatching(/ignored/) });
    expect(aiMode({ AI_PROVIDERS: 'anthropic', NODE_ENV: 'production' })).toMatchObject({ mode: 'fake', note: expect.any(String) });
  });

  it('builds the fake provider for every connection in this run, with no credential', () => {
    const providers = new AiProviders();
    expect(providers.mode).toBe('fake');
    for (const kind of ['anthropic', 'bedrock'] as const) {
      const provider = providers.for({ kind, region: 'global', inferenceType: 'global', credentialEnv: 'AI_CREDENTIAL_NOT_SET_ANYWHERE' });
      expect(provider).toBeInstanceOf(FakeAiProvider);
    }
  });

  it('says whether a credential is present only for variables named for it', () => {
    const providers = new AiProviders();
    process.env.AI_CREDENTIAL_SPEC_PRESENT = 'x';
    try {
      expect(providers.credentialsPresent('AI_CREDENTIAL_SPEC_PRESENT')).toBe(true);
      expect(providers.credentialsPresent('AI_CREDENTIAL_SPEC_ABSENT')).toBe(false);
      // Set, but not a credential's name: never read.
      expect(providers.credentialsPresent('DATABASE_URL')).toBe(false);
    } finally {
      delete process.env.AI_CREDENTIAL_SPEC_PRESENT;
    }
  });
});

describe('a real adapter under test', () => {
  it('cannot be built without a fetch of the test’s own, so no test reaches a provider', () => {
    expect(() => new AnthropicProvider('key')).toThrow(RealProviderUnderTestError);
    expect(() => new BedrockProvider('me-central-1', { apiKey: 'key' })).toThrow(RealProviderUnderTestError);
  });
});

describe('the Anthropic adapter', () => {
  it('sends the system text, the messages, the ceiling and the schema, and reads the answer and its size', async () => {
    const { fetch, seen } = stubFetch(200, message('OK [PERSON_1]'));
    const provider = new AnthropicProvider('sk-test-key', { fetch, inferenceGeo: 'us' });
    const result = await provider.complete({ ...request, output: { schema: { type: 'object' } } }, call());
    expect(result).toEqual({ text: 'OK [PERSON_1]', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://api.anthropic.com/v1/messages');
    // The key, as this version of the SDK sends it.
    expect(seen[0].headers.get('authorization')).toBe('Bearer sk-test-key');
    expect(seen[0].body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 50,
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hello [PERSON_1]' }],
      inference_geo: 'us',
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
    });
  });

  it('writes nothing of a request to the log, whatever ANTHROPIC_LOG says', async () => {
    process.env.ANTHROPIC_LOG = 'debug';
    const spies = (['debug', 'info', 'log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      for (const provider of [
        new AnthropicProvider('k', { fetch: stubFetch(200, message('OK')).fetch }),
        new BedrockProvider('me-central-1', { apiKey: 'k' }, { fetch: stubFetch(200, message('OK')).fetch }),
      ]) {
        await provider.complete(request, call());
      }
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      delete process.env.ANTHROPIC_LOG;
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('makes no retry of its own, and says what kind of failure it was', async () => {
    for (const [status, failure, retryable] of [
      [429, 'rate_limited', true],
      [529, 'overloaded', true],
      [500, 'server', true],
      [401, 'auth', false],
      [400, 'bad_request', false],
    ] as const) {
      const { fetch, seen } = stubFetch(status, { type: 'error', error: { type: 'x', message: 'quoted request text' } });
      const error = await new AnthropicProvider('k', { fetch }).complete(request, call()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AiProviderError);
      expect([status, (error as AiProviderError).failure, (error as AiProviderError).retryable]).toEqual([status, failure, retryable]);
      // The provider's own words are never carried.
      expect((error as Error).message).not.toMatch(/quoted/);
      expect(seen).toHaveLength(1);
    }
  });
});

describe('the Amazon Bedrock adapter', () => {
  it('reads a credential as an API key, or as access key, secret and session token', () => {
    expect(bedrockCredentials('ABSKabc123')).toEqual({ apiKey: 'ABSKabc123' });
    expect(bedrockCredentials('AKIAEXAMPLE:secret/key+1')).toEqual({ accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret/key+1', sessionToken: null });
    expect(bedrockCredentials('AKIA:secret:token')).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'secret', sessionToken: 'token' });
  });

  it('calls the model the connection names, in its region, with an API key', async () => {
    const { fetch, seen } = stubFetch(200, message('OK'));
    const provider = new BedrockProvider('me-central-1', { apiKey: 'ABSKtest' }, { fetch });
    const result = await provider.complete({ ...request, model: 'global.anthropic.claude-sonnet-5-5' }, call());
    expect(result).toEqual({ text: 'OK', usage: { inputTokens: 12, outputTokens: 3 } });
    expect(seen[0].url).toBe('https://bedrock-runtime.me-central-1.amazonaws.com/model/global.anthropic.claude-sonnet-5-5/invoke');
    expect(seen[0].headers.get('authorization')).toBe('Bearer ABSKtest');
    expect(seen[0].body).toMatchObject({ max_tokens: 50, system: 'Be brief.', messages: request.messages });
  });

  it('signs with the access key when given one, and never a bearer token from elsewhere', async () => {
    process.env.AWS_BEARER_TOKEN_BEDROCK = 'from-the-environment';
    try {
      const { fetch, seen } = stubFetch(200, message('OK'));
      const provider = new BedrockProvider('eu-west-1', { accessKeyId: 'AKIATEST', secretAccessKey: 'secret', sessionToken: null }, { fetch });
      await provider.complete({ ...request, model: 'eu.anthropic.claude-haiku-5-5' }, call());
      expect(seen[0].headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIATEST\//);
    } finally {
      delete process.env.AWS_BEARER_TOKEN_BEDROCK;
    }
  });

  it('says what kind of failure it was', async () => {
    const { fetch } = stubFetch(503, { message: 'unavailable' });
    const error = await new BedrockProvider('me-central-1', { apiKey: 'k' }, { fetch }).complete(request, call()).catch((e: unknown) => e);
    expect(error).toMatchObject({ failure: 'server', retryable: true });
  });
});

describe('the fake provider', () => {
  afterEach(() => fakeAi.reset());

  it('keeps what it was sent only under test: elsewhere it is the default, and would hold record text', async () => {
    const saved = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV };
    process.env.VITEST = 'false';
    process.env.NODE_ENV = 'development';
    try {
      await new FakeAiProvider().complete(request, call());
      expect(() => fakeAi.respondWith(() => 'x')).toThrow(/tests only/);
    } finally {
      Object.assign(process.env, saved);
    }
    expect(fakeAi.calls).toHaveLength(0);
  });

  it('answers the same request the same way, and records what it was sent', async () => {
    const a = await new FakeAiProvider().complete(request, call());
    const b = await new FakeAiProvider().complete(request, call());
    expect(a).toEqual(b);
    expect(a.text).toBe('Fake answer: Hello [PERSON_1]');
    expect(a.usage.inputTokens).toBeGreaterThan(0);
    expect(fakeAi.calls.map((c) => c.request.messages[0].content)).toEqual(['Hello [PERSON_1]', 'Hello [PERSON_1]']);
  });

  it('answers what a test scripts, and fails when told to', async () => {
    fakeAi.respondWith((_, attempt) => {
      if (attempt === 1) throw new AiProviderError('overloaded');
      return 'second time';
    });
    const provider = new FakeAiProvider();
    await expect(provider.complete(request, call())).rejects.toMatchObject({ failure: 'overloaded' });
    await expect(provider.complete(request, call())).resolves.toMatchObject({ text: 'second time' });
  });

  it('gives up when the call is aborted', async () => {
    fakeAi.respondWith(() => new Promise(() => undefined));
    const controller = new AbortController();
    const pending = new FakeAiProvider().complete(request, { timeoutMs: 10, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});

describe('structured answers', () => {
  it('reads JSON, fenced or not, and fails as invalid output otherwise', () => {
    expect(parseStructured('{"a":1}')).toEqual({ a: 1 });
    expect(parseStructured('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => parseStructured('not json')).toThrow(expect.objectContaining({ failure: 'invalid_output' }));
  });
});
