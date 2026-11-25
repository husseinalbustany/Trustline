import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { DatabaseErrorFilter } from './database/database-error.filter.js';

/**
 * Settings every instance of the API needs, applied the same way when it is
 * served and when it is tested.
 */
export function setupApp(app: INestApplication) {
  // Where a caller's address comes from. The API sits behind the web app,
  // which passes on the X-Forwarded-For header it was given: it neither
  // replaces it nor adds to it. So the address is true only if a proxy in
  // front of the web app writes that header itself, replacing whatever the
  // sender put there (or adding the real address after it).
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
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  (
    app.getHttpAdapter().getInstance() as {
      set: (k: string, v: number) => void;
    }
  ).set('trust proxy', hops);

  // A query the database refuses must not put its parameters in the log.
  app.useGlobalFilters(
    new DatabaseErrorFilter(app.get(HttpAdapterHost).httpAdapter),
  );

  // Bodies are JSON only. A form posted from another site cannot be JSON
  // without the browser first asking permission, which the API never grants.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const hasBody = Number(req.headers['content-length'] ?? 0) > 0;
    if (hasBody && !req.is('application/json')) {
      res
        .status(415)
        .json({ statusCode: 415, message: 'Unsupported Media Type' });
      return;
    }
    next();
  });
}
