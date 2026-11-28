import { Logger, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { DatabaseErrorFilter } from './database/database-error.filter.js';
import { AuthService } from './identity/auth.service.js';
import { importBodyParser } from './security/import-body.js';

/**
 * How many proxies in front of the web app write the X-Forwarded-For header:
 * TRUST_PROXY_HOPS, 1 unless set. Anything but a small whole number stops
 * the API from starting: a mistyped value would otherwise be read as "trust
 * nothing", silently, and every caller would count as the web app.
 */
export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
  const set = env.TRUST_PROXY_HOPS?.trim();
  if (!set) return 1;
  if (!/^\d$/.test(set)) {
    throw new Error(
      'TRUST_PROXY_HOPS must be a whole number from 0 to 9: the number of proxies in front of the web app that write X-Forwarded-For',
    );
  }
  return Number(set);
}

/** The address of this machine itself: nothing else can connect to it. */
export const LOOPBACK = '127.0.0.1';

/**
 * Where the API listens: API_PORT (3001 unless set) on API_HOST.
 *
 * Unless API_HOST is set, on the loopback address only, so that nothing but
 * this machine can connect: the web app next to it, which is how every
 * request is meant to arrive. The API believes the X-Forwarded-For header
 * it is handed (see `setupApp`), so whoever can connect to it directly
 * chooses their own address and has every limit per address to themselves.
 * Where the web app runs on another machine or in another container, set
 * API_HOST to the address it reaches the API on (`0.0.0.0` for all of them)
 * and let the network allow only the web app to connect.
 */
export function listenAddress(env: NodeJS.ProcessEnv = process.env) {
  return {
    host: env.API_HOST?.trim() || LOOPBACK,
    port: Number(env.API_PORT?.trim() || 3001),
  };
}

/** Whether only this machine can connect to an address the API listens on. */
export const isLoopback = (host: string) =>
  host === 'localhost' || host === '::1' || host.startsWith('127.');

/**
 * What the API says once when it starts: where it listens and how far it
 * trusts the forwarding header, so that both settings can be checked against
 * the deployment from the log alone.
 */
export function describeListening(
  { host, port }: { host: string; port: number },
  hops: number,
): { level: 'log' | 'warn'; message: string }[] {
  const trust =
    hops === 0
      ? 'TRUST_PROXY_HOPS=0: X-Forwarded-For is ignored, and every caller is counted by the address that connected'
      : `TRUST_PROXY_HOPS=${hops}: a caller's address is ${hops === 1 ? 'the last entry' : `entry ${hops} from the end`} of X-Forwarded-For, which a proxy in front of the web app must write`;
  return [
    { level: 'log', message: `Listening on ${host}:${port}. ${trust}.` },
    ...(isLoopback(host)
      ? []
      : [
          {
            level: 'warn' as const,
            message: `API_HOST=${host}: the API can be reached from other machines. Only the web app may be able to connect to it, or callers can choose the address they are counted by.`,
          },
        ]),
  ];
}

/**
 * Starts serving, where `listenAddress()` says, and says so once in the log
 * together with the trust in the forwarding header.
 */
export async function listen(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
) {
  const address = listenAddress(env);
  // Read first: a setting that cannot be read stops the start, before
  // anything is served.
  const hops = trustProxyHops(env);
  await app.listen(address.port, address.host);
  const logger = new Logger('Bootstrap');
  for (const { level, message } of describeListening(address, hops)) {
    logger[level](message);
  }
  return address;
}

/** The prefix every route is served under (main.ts); tests serve none. */
export const API_PREFIX = 'api/v1';

/** The unsubscribe link of an email, with or without the `/api/v1` prefix. */
const UNSUBSCRIBE_PATH = /\/email\/unsubscribe\/[^/]+$/;

/**
 * Settings every instance of the API needs, applied the same way when it is
 * served and when it is tested.
 */
export function setupApp(
  app: INestApplication,
  options: { prefix?: string } = {},
) {
  // Where a caller's address comes from. The API sits behind the web app,
  // which passes on the X-Forwarded-For header it was given: it neither
  // replaces it nor adds to it. So the address is true only if a proxy in
  // front of the web app writes that header itself, replacing whatever the
  // sender put there (or adding the real address after it), and if nobody
  // can reach the web app or the API except through that proxy.
  //
  // TRUST_PROXY_HOPS is the number of proxies in front of the web app that
  // do so: 1 for "proxy, web app, API" (the default), 2 for "CDN, load
  // balancer, web app, API" where each adds an entry. Express then reads the
  // entry that many places from the end, which is the one the outermost
  // trusted proxy wrote. Set it to 0 only where the API is reached directly,
  // with no web app and no proxy: the address is then the connection's own.
  //
  // With no such proxy there is no right value: at 1 a sender chooses their
  // own address by sending the header, and with no header, or at 0, every
  // caller counts as the web app. The README spells this out. The limits on
  // the public routes and the address in the sign-in audit depend on it.
  (
    app.getHttpAdapter().getInstance() as {
      set: (k: string, v: number) => void;
    }
  ).set('trust proxy', trustProxyHops());

  // A query the database refuses must not put its parameters in the log.
  app.useGlobalFilters(
    new DatabaseErrorFilter(app.get(HttpAdapterHost).httpAdapter),
  );

  // Bodies are JSON only. A form posted from another site cannot be JSON
  // without the browser first asking permission, which the API never grants.
  // One exception: an email's unsubscribe link, which a mail client posts
  // as a form (RFC 8058), and whose page posts one. It needs no session:
  // the signed token in its address is all it acts on, so a form posted
  // from elsewhere can do nothing its sender could not do with the token.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0;
    const unsubscribing =
      req.method === 'POST' &&
      UNSUBSCRIBE_PATH.test(req.path) &&
      req.is('application/x-www-form-urlencoded') !== false;
    if (hasBody && !req.is('application/json') && !unsubscribing) {
      res
        .status(415)
        .json({ statusCode: 415, message: 'Unsupported Media Type' });
      return;
    }
    next();
  });

  // Bodies are at most 100 kB (Nest's parser), except on the three routes
  // that import documents, which come whole: up to IMPORT_BODY_LIMIT, for
  // a caller whose session is live and who may import, looked up before
  // the body is read (security/import-body.ts). Registered here, so before
  // Nest's own parser, which then leaves a body already read.
  const auth = app.get(AuthService, { strict: false });
  app.use(
    importBodyParser({
      prefix: options.prefix ?? '',
      resolve: (token) => auth.resolve(token),
    }),
  );
}
