import { clientKey, MAX_KEY_LENGTH, RateLimiter } from './rate-limiter.js';

describe('clientKey', () => {
  it('counts an IPv4 address as itself, however it is written', () => {
    expect(clientKey('203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientKey('::FFFF:203.0.113.9')).toBe('203.0.113.9');
  });

  it('counts every address of one IPv6 /56 as the same client', () => {
    const key = clientKey('2001:db8:12:3400::1');
    expect(key).toBe('2001:db8:12:3400::/56');
    for (const same of [
      '2001:db8:12:3400:ffff:ffff:ffff:ffff',
      '2001:0db8:0012:3400:0000:0000:0000:0002',
      '2001:DB8:12:3400::abcd',
      '2001:db8:12:3400::1%eth0',
      // The other 255 networks of 64 bits a home connection is handed with
      // its /56: none of them is a caller of its own.
      '2001:db8:12:3401::1',
      '2001:db8:12:347f:1:2:3:4',
      '2001:db8:12:34ff:ffff:ffff:ffff:ffff',
    ]) {
      expect([same, clientKey(same)]).toEqual([same, key]);
    }
    // The next /56, and the one before.
    expect(clientKey('2001:db8:12:3500::1')).toBe('2001:db8:12:3500::/56');
    expect(clientKey('2001:db8:12:33ff::1')).toBe('2001:db8:12:3300::/56');
    expect(clientKey('2001:db8:13:3400::1')).not.toBe(key);
    expect(clientKey('::1')).toBe('0:0:0:0::/56');
    expect(clientKey('2001:db8::')).toBe('2001:db8:0:0::/56');
    expect(clientKey('2001:db8:0:ff::1')).toBe('2001:db8:0:0::/56');
    expect(clientKey('64:ff9b::203.0.113.9')).toBe('64:ff9b:0:0::/56');
  });

  it('puts requests with no address in one bucket rather than letting them through', () => {
    expect(clientKey(undefined)).toBe('unknown');
    expect(clientKey('')).toBe('unknown');
  });

  it('counts anything that is not an IP address as that same one client', () => {
    // What a sender can put in a forwarding header when nothing in front of
    // the web app replaces it.
    for (const invented of [
      'not-an-address',
      'localhost',
      'example.invalid',
      '203.0.113',
      '203.0.113.256',
      '203.0.113.9:8080',
      '[2001:db8::1]',
      '2001:db8:::1',
      '::ffff:999.0.113.9',
      '1.2.3.4, 5.6.7.8',
      ' 203.0.113.9',
      '203.0.113.9\n',
      '<script>',
      "'; drop table incidents; --",
      '\u0000',
    ]) {
      expect([invented, clientKey(invented)]).toEqual([invented, 'unknown']);
    }
  });

  it('never returns a key longer than an address, whatever it is given', () => {
    const long = 'a'.repeat(16_000);
    expect(clientKey(long)).toBe('unknown');
    expect(clientKey(`203.0.113.9${' '.repeat(16_000)}`)).toBe('unknown');
    expect(clientKey(`${'0'.repeat(16_000)}::1`)).toBe('unknown');
    expect(clientKey(`::1%${'z'.repeat(16_000)}`)).toBe('unknown');
    for (const address of [
      '203.0.113.9',
      '::ffff:203.0.113.9',
      '2001:0db8:0012:3400:ffff:ffff:ffff:ffff',
      'ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255',
    ]) {
      expect(clientKey(address).length).toBeLessThanOrEqual(45);
    }
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

  it('keeps a bounded amount for each client: a short key and no more attempts than the limit', () => {
    let now = 0;
    const limiter = new RateLimiter(2, HOUR, 100, () => now);
    const long = 'k'.repeat(10_000);
    for (let i = 0; i < 500; i++) {
      now += 1;
      limiter.hit(long);
    }
    const kept = (limiter as unknown as { attempts: Map<string, number[]> })
      .attempts;
    expect([...kept.keys()]).toEqual(['k'.repeat(MAX_KEY_LENGTH)]);
    expect([...kept.values()][0]).toHaveLength(2);
    // A key that long is still one client, and still limited.
    expect(limiter.hit(long)).toBeGreaterThan(0);
    expect(limiter.size).toBe(1);
  });

  it('starts every count again when cleared', () => {
    const limiter = new RateLimiter(1, HOUR);
    limiter.hit('a');
    expect(limiter.hit('a')).toBeGreaterThan(0);
    limiter.clear();
    expect(limiter.size).toBe(0);
    expect(limiter.hit('a')).toBe(0);
  });
});
