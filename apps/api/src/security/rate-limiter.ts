import { isIPv6 } from 'node:net';

/**
 * Who a request counts against. An IPv4 address counts as itself. An IPv6
 * address counts as its /64 network, because one subscriber is handed a whole
 * /64 and could otherwise come from a new address for every request. An IPv4
 * address written the IPv6 way (`::ffff:203.0.113.9`) is that IPv4 address.
 *
 * `ip` is what Express worked out from the connection and the proxy setting
 * in app.setup.ts. Never pass a header here.
 */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const address = ip.split('%')[0].toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1];
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
  const network = groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':');
  return `${network}::/64`;
}

/**
 * Allows each key a number of attempts within a moving window of time, and
 * refuses the rest. Kept in this process's memory: with several API
 * processes each counts on its own, so the real limit is this one times the
 * number of processes. Good enough to stop guessing and flooding; a shared
 * store is needed before it is a precise quota.
 */
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
  hit(key: string): number {
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
}
