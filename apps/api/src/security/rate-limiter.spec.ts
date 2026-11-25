import { clientKey, RateLimiter } from './rate-limiter.js';

describe('clientKey', () => {
  it('counts an IPv4 address as itself, however it is written', () => {
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::FFFF:203.0.113.9')).toBe('203.0.113.9');
  });

  it('counts every address of one IPv6 /64 as the same client', () => {
    const key = clientKey('2001:db8:12:3400::1');
    expect(key).toBe('2001:db8:12:3400::/64');
    for (const same of [
      '2001:db8:12:3400:ffff:ffff:ffff:ffff',
      '2001:0db8:0012:3400:0000:0000:0000:0002',
      '2001:DB8:12:3400::abcd',
      '2001:db8:12:3400::1%eth0',
    ]) {
      expect(clientKey(same)).toBe(key);
    }
    expect(clientKey('2001:db8:12:3401::1')).not.toBe(key);
    expect(clientKey('::1')).toBe('0:0:0:0::/64');
    expect(clientKey('2001:db8::')).toBe('2001:db8:0:0::/64');
  });

  it('puts requests with no address in one bucket rather than letting them through', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
  });
});

describe('RateLimiter', () => {
  const HOUR = 3_600_000;

  it('allows the limit, refuses the next, and says how long to wait', () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(3, HOUR, 100, () => now);
    expect([1, 2, 3].map(() => limiter.hit('a'))).toEqual([0, 0, 0]);
    expect(limiter.hit('a')).toBe(3600);
    now += 600_000;
    expect(limiter.hit('a')).toBe(3000);
    // Another client is not affected.
    expect(limiter.hit('b')).toBe(0);
  });

  it('lets attempts through again as the earlier ones age out', () => {
    let now = 0;
    const limiter = new RateLimiter(2, HOUR, 100, () => now);
    limiter.hit('a');
    now += 30 * 60_000;
    limiter.hit('a');
    expect(limiter.hit('a')).toBeGreaterThan(0);
    // The first attempt is now more than an hour old; the second is not.
    now += 31 * 60_000;
    expect(limiter.hit('a')).toBe(0);
    expect(limiter.hit('a')).toBeGreaterThan(0);
  });

  it('does not extend the wait of someone who keeps trying', () => {
    let now = 0;
    const limiter = new RateLimiter(1, HOUR, 100, () => now);
    limiter.hit('a');
    for (let i = 0; i < 50; i++) {
      now += 60_000;
      limiter.hit('a');
    }
    now = HOUR + 1;
    expect(limiter.hit('a')).toBe(0);
  });

  it('remembers a bounded number of clients, dropping the least recently seen', () => {
    let now = 0;
    const limiter = new RateLimiter(1, HOUR, 3, () => now);
    for (const key of ['a', 'b', 'c']) {
      now += 1;
      limiter.hit(key);
    }
    // A fourth client pushes out "a", the one seen longest ago, and only it.
    now += 1;
    expect(limiter.hit('d')).toBe(0);
    for (const key of ['b', 'c', 'd']) {
      expect(limiter.hit(key)).toBeGreaterThan(0);
    }
    // "a" was forgotten, so it starts again, in the place of "b".
    expect(limiter.hit('a')).toBe(0);
    expect(limiter.hit('b')).toBe(0);
  });
});
