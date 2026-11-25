import '../src/env.js';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { listen, setupApp } from '../src/app.setup.js';

/**
 * Where the API listens once it is started the way `main.ts` starts it. The
 * API believes the forwarding header it is handed, so it must not be open to
 * anyone but the web app next to it unless it is told to be.
 */
describe('where the API listens', () => {
  const apps: INestApplication<App>[] = [];
  /** This machine's addresses that other machines could connect to. */
  const outside = Object.values(networkInterfaces())
    .flat()
    .filter((a) => a && !a.internal && a.family === 'IPv4')
    .map((a) => a!.address);

  /** The application, served as main.ts serves it, on a port of its own. */
  const serve = async (env: NodeJS.ProcessEnv) => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const app: INestApplication<App> = moduleRef.createNestApplication();
    apps.push(app);
    setupApp(app);
    await listen(app, { ...env, API_PORT: '0' });
    return (
      app.getHttpServer() as unknown as { address(): AddressInfo }
    ).address();
  };

  const reaches = async (host: string, port: number) => {
    try {
      const res = await fetch(`http://${host}:${port}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.status === 200;
    } catch {
      return false;
    }
  };

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  it('is this machine only, unless it is told otherwise, and says so once', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { address, family, port } = await serve({});
    expect([address, family]).toEqual(['127.0.0.1', 'IPv4']);
    // Reached the two ways the web app's forwarding can name it.
    expect(await reaches('127.0.0.1', port)).toBe(true);
    expect(await reaches('localhost', port)).toBe(true);
    // And by nobody who is not on this machine.
    for (const host of outside) {
      expect([host, await reaches(host, port)]).toEqual([host, false]);
    }
    const said = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Listening on '));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Listening on 127.0.0.1:');
    expect(said[0]).toContain('TRUST_PROXY_HOPS=1');
    expect(
      warn.mock.calls.filter(([message]) =>
        String(message).includes('API_HOST'),
      ),
    ).toEqual([]);
  });

  it('is every address when told so, for a container, with a warning', async () => {
    const log = vi.spyOn(Logger.prototype, 'log');
    const warn = vi.spyOn(Logger.prototype, 'warn');
    const { address, port } = await serve({
      API_HOST: '0.0.0.0',
      TRUST_PROXY_HOPS: '2',
    });
    expect(address).toBe('0.0.0.0');
    expect(await reaches('127.0.0.1', port)).toBe(true);
    for (const host of outside) {
      expect([host, await reaches(host, port)]).toEqual([host, true]);
    }
    const said = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith('Listening on '));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('Listening on 0.0.0.0:');
    expect(said[0]).toContain('TRUST_PROXY_HOPS=2');
    const warned = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('API_HOST'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('API_HOST=0.0.0.0');
  });

  it('does not start on a trust setting it cannot read', async () => {
    await expect(serve({ TRUST_PROXY_HOPS: 'yes' })).rejects.toThrow(
      /TRUST_PROXY_HOPS must be a whole number/,
    );
  });
});
