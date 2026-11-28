import type {
  AiProvider,
  ProviderCall,
  ProviderRequest,
  ProviderResult,
} from './provider.js';

/**
 * What the fake provider answers. Given the request as it would have been
 * sent (names already removed) and the attempt (1, or 2 for the retry), it
 * returns the answer's text, or a whole result, or throws an
 * `AiProviderError` to fail as a provider would. It may also never answer,
 * to be timed out.
 */
export type FakeHandler = (
  request: ProviderRequest,
  attempt: number,
) => string | ProviderResult | Promise<string | ProviderResult>;

/** Roughly how many tokens a text is: a quarter of its characters. */
export const tokensOf = (text: string) => Math.ceil(text.length / 4);

/**
 * The default answer: deterministic, and saying back the last thing the
 * person wrote, placeholders included, so that their restoring can be
 * seen. Data, when data was asked for.
 */
export function echo(request: ProviderRequest): string {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  const said = last?.content ?? '';
  return request.output ? JSON.stringify({ answer: `Fake answer: ${said}` }) : `Fake answer: ${said}`;
}

/**
 * The fake provider's state, for the process: the handler answering, and
 * every request it was sent, so that a test can see exactly what would
 * have left Trustline.
 */
export const fakeAi = {
  handler: null as FakeHandler | null,
  calls: [] as { request: ProviderRequest; attempt: number }[],
  /** Answers with this from now on. */
  respondWith(handler: FakeHandler) {
    this.handler = handler;
  },
  /** Back to the default answer, with no calls recorded. */
  reset() {
    this.handler = null;
    this.calls = [];
  },
};

/**
 * A provider for tests and development: scripted answers, never the
 * network. The default whenever real providers are not switched on
 * (`AiProviders`), and the only one a test can reach.
 */
export class FakeAiProvider implements AiProvider {
  private attempt = 0;

  async complete(request: ProviderRequest, call: ProviderCall): Promise<ProviderResult> {
    this.attempt++;
    fakeAi.calls.push({ request: structuredClone(request), attempt: this.attempt });
    const handler = fakeAi.handler ?? echo;
    const answer = await Promise.race([
      Promise.resolve(handler(request, this.attempt)),
      new Promise<never>((_, reject) => {
        if (call.signal.aborted) reject(new Error('aborted'));
        call.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    ]);
    if (typeof answer !== 'string') return answer;
    const sent = [request.system ?? '', ...request.messages.map((m) => m.content)].join('\n');
    return { text: answer, usage: { inputTokens: tokensOf(sent), outputTokens: tokensOf(answer) } };
  }
}
