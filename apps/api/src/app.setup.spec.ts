import {
  describeListening,
  isLoopback,
  listenAddress,
  LOOPBACK,
  trustProxyHops,
} from './app.setup.js';

describe('how the API is reached', () => {
  describe('where it listens', () => {
    it('is this machine only, unless it is told otherwise', () => {
      expect(listenAddress({})).toEqual({ host: '127.0.0.1', port: 3001 });
      expect(LOOPBACK).toBe('127.0.0.1');
      expect(listenAddress({ API_PORT: '4100' })).toEqual({
        host: '127.0.0.1',
        port: 4100,
      });
      // Set and left empty, as a line in .env can be: still this machine.
      expect(listenAddress({ API_HOST: '', API_PORT: '' })).toEqual({
        host: '127.0.0.1',
        port: 3001,
      });
      expect(listenAddress({ API_HOST: '  ' }).host).toBe('127.0.0.1');
    });

    it('is the address it is given, for a container or a host of its own', () => {
      expect(listenAddress({ API_HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
      expect(listenAddress({ API_HOST: ' 10.0.0.5 ' }).host).toBe('10.0.0.5');
      expect(listenAddress({ API_HOST: '::' }).host).toBe('::');
    });

    it('knows which addresses only this machine can connect to', () => {
      for (const host of ['127.0.0.1', '127.0.0.53', 'localhost', '::1']) {
        expect([host, isLoopback(host)]).toEqual([host, true]);
      }
      for (const host of ['0.0.0.0', '::', '10.0.0.5', '192.0.2.2', 'api']) {
        expect([host, isLoopback(host)]).toEqual([host, false]);
      }
    });
  });

  describe('how many proxies it trusts for the address of a caller', () => {
    it('is one unless it is told otherwise', () => {
      expect(trustProxyHops({})).toBe(1);
      expect(trustProxyHops({ TRUST_PROXY_HOPS: '' })).toBe(1);
      expect(trustProxyHops({ TRUST_PROXY_HOPS: '0' })).toBe(0);
      expect(trustProxyHops({ TRUST_PROXY_HOPS: '2' })).toBe(2);
      expect(trustProxyHops({ TRUST_PROXY_HOPS: ' 3 ' })).toBe(3);
    });

    it('stops the API from starting on a value that is not a small whole number', () => {
      // Read as a number, each of these would have meant "trust nothing"
      // or "trust everything" without a word.
      for (const set of [
        'one',
        'true',
        '-1',
        '1.5',
        '1e3',
        '10',
        '0x1',
        'loopback',
        '1, 2',
        'Infinity',
      ]) {
        expect(() => trustProxyHops({ TRUST_PROXY_HOPS: set })).toThrow(
          /TRUST_PROXY_HOPS must be a whole number/,
        );
      }
    });
  });

  describe('what it says when it starts', () => {
    it('is one line with the address and the trust, when only this machine can connect', () => {
      const lines = describeListening({ host: '127.0.0.1', port: 3001 }, 1);
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe('log');
      expect(lines[0].message).toContain('Listening on 127.0.0.1:3001');
      expect(lines[0].message).toContain('TRUST_PROXY_HOPS=1');
      expect(lines[0].message).toContain('last in X-Forwarded-For');
      expect(
        describeListening({ host: '127.0.0.1', port: 3001 }, 2)[0].message,
      ).toContain('TRUST_PROXY_HOPS=2');
      expect(
        describeListening({ host: '127.0.0.1', port: 3001 }, 0)[0].message,
      ).toContain('X-Forwarded-For is ignored');
    });

    it('adds a warning when other machines can connect', () => {
      const lines = describeListening({ host: '0.0.0.0', port: 3001 }, 1);
      expect(lines.map((l) => l.level)).toEqual(['log', 'warn']);
      expect(lines[0].message).toContain('Listening on 0.0.0.0:3001');
      expect(lines[1].message).toContain('API_HOST=0.0.0.0');
      expect(lines[1].message).toContain('Only the web app');
    });
  });
});
