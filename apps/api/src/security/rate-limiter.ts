import { isIP, isIPv6 } from 'node:net';

/** What everything that is not an address counts against, together. */
export const UNKNOWN_CLIENT = 'unknown';

/**
 * Who a request counts against. An IPv4 address counts as itself. An IPv6
 * address counts as its /56 network: a provider hands one subscriber at
 * least a /64 and commonly a /56, so counting by single address would give
 * them a fresh allowance for every request, and counting by /64 would still
 * give a home connection 256 of them. (Some hand out a /48: such a
 * subscriber has 256 allowances here. The ceiling per hospital, which rests
 * on no address, is what holds then.) An IPv4 address written the IPv6 way
 * (`::ffff:203.0.113.9`) is that IPv4 address.
 *
 * Anything that is not an IP address counts as one and the same client,
 * `unknown`. What Express hands over can be text a sender chose (see
 * app.setup.ts): it must never become a key of its own, or each invented
 * value would get a fresh count and a long one would be kept in memory.
 *
 * `ip` is what Express worked out from the connection and the proxy setting
 * in app.setup.ts. Never pass a header here.
 */
export function clientKey(ip: string | undefined): string {
  // The longest address there is has 45 characters; nothing longer is read.
  if (!ip || ip.length > 64) return UNKNOWN_CLIENT;
  const address = ip.split('%')[0].toLowerCase();
  if (isIP(address) === 0) return UNKNOWN_CLIENT;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return isIP(mapped[1]) === 4 ? mapped[1] : UNKNOWN_CLIENT;
  if (!isIPv6(address)) return address;
  const [head, tail] = address.split('::') as [string, string | undefined];
  const before = head ? head.split(':') : [];
  const after = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? before
      : [
          ...before,
          ...Array<string>(Math.max(8 - before.length - after.length, 0)).fill(
            '0',
          ),
          ...after,
        ];
  // The first 56 bits: three groups and the upper half of the fourth.
  const [a, b, c, d] = groups.map((group) => parseInt(group, 16));
  const network = [a, b, c, d & 0xff00]
    .map((group) => group.toString(16))
    .join(':');
  return `${network}::/56`;
}

/**
 * Allows each key a number of attempts within a moving window of time, and
 * refuses the rest. Kept in this process's memory: with several API
 * processes each counts on its own, so the real limit is this one times the
 * number of processes. Good enough to stop guessing and flooding; a shared
 * store is needed before it is a precise quota.
 */
/** No key is kept longer than this: a longer one is counted by its start. */
export const MAX_KEY_LENGTH = 64;

export class RateLimiter {
  private readonly attempts = new Map<string, number[]>();
  private sweptAt = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    /** Keys remembered at most, so a flood of addresses cannot fill memory. */
    private readonly maxKeys = 50_000,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Counts one attempt. Returns 0 if it is allowed, otherwise the number of
   * seconds until the next one would be. A refused attempt is not counted,
   * so someone who keeps trying is let back in when the window has passed.
   */
  hit(name: string): number {
    // What is stored for a key is bounded both ways: the key itself here,
    // and its attempts below, which never number more than the limit.
    const key = name.slice(0, MAX_KEY_LENGTH);
    const now = this.now();
    this.sweep(now, key);
    const since = now - this.windowMs;
    const recent = (this.attempts.get(key) ?? []).filter((at) => at > since);
    if (recent.length >= this.limit) {
      this.attempts.set(key, recent);
      return Math.max(Math.ceil((recent[0] + this.windowMs - now) / 1000), 1);
    }
    recent.push(now);
    // Re-inserted, so the map stays in order of last use.
    this.attempts.delete(key);
    this.attempts.set(key, recent);
    return 0;
  }

  /**
   * Once a minute, forgets every key whose attempts have aged out. At the
   * cap, makes room for a key not seen before by forgetting the one used
   * longest ago.
   */
  private sweep(now: number, incoming: string) {
    if (now - this.sweptAt >= 60_000) {
      this.sweptAt = now;
      const since = now - this.windowMs;
      for (const [key, times] of this.attempts) {
        if (times.every((at) => at <= since)) this.attempts.delete(key);
      }
    }
    if (this.attempts.has(incoming)) return;
    for (const key of this.attempts.keys()) {
      if (this.attempts.size < this.maxKeys) break;
      this.attempts.delete(key);
    }
  }

  /** Forgets every count, as a restart of the process would. */
  clear() {
    this.attempts.clear();
  }

  /** How many keys are remembered now. */
  get size() {
    return this.attempts.size;
  }
}
