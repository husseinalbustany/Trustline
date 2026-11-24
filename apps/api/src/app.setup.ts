import type { INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import { DatabaseErrorFilter } from './database/database-error.filter.js';

/**
 * Settings every instance of the API needs, applied the same way when it is
 * served and when it is tested.
 */
export function setupApp(app: INestApplication) {
  // The API sits behind the web app, which forwards the caller's address.
  // Trust exactly that many proxies, so the address cannot be forged from
  // further out. Set TRUST_PROXY_HOPS=0 if the API is reached directly.
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
