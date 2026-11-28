import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE } from '../identity/session.guard.js';
import { readCookie } from './cookies.js';

/**
 * The largest body of the three routes that import documents, where every
 * other route takes 100 kB (Nest's default). An imported document comes
 * whole, in one request, since it is published and signed as it arrives:
 * its text alone may reach 200,000 characters (VERSION_MAX_CHARS), which in
 * Arabic or with typographic quotes is 400 to 600 kB of UTF-8; and a batch
 * holds up to 20 documents and 600,000 characters (IMPORT_MAX_DOCUMENTS,
 * IMPORT_MAX_CHARS in policies/input.ts). 2 MB holds either, with room for
 * the JSON around them.
 */
export const IMPORT_BODY_LIMIT = 2 * 1024 * 1024;

/** The import routes, with or without the `/api/v1` prefix. */
const IMPORT_PATHS = /\/policies\/(?:imports(?:\/check)?|documents\/import)$/;

const answer = (res: Response, status: number, body: Record<string, unknown>) => {
  res.status(status).json(body);
};

/**
 * Reads the JSON body of the import routes up to IMPORT_BODY_LIMIT, for a
 * caller who presents a session (which the route's guard then checks as
 * for any route). Anything else, and every other route, is left to Nest's
 * own parser and its 100 kB: a caller without a session cannot send more
 * than that anywhere. Registered before Nest's parser, which then finds the
 * body read and leaves it.
 *
 * UTF-8 JSON only, not compressed (415 otherwise); a body over the limit
 * is answered 413 `body_too_large` with the `max`, and one that is not
 * JSON 400.
 */
export function importBodyParser(limit = IMPORT_BODY_LIMIT) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (
      req.method !== 'POST' ||
      !IMPORT_PATHS.test(req.path) ||
      !req.is('application/json')
    ) {
      next();
      return;
    }
    const hasSession =
      /^Bearer .+$/.test(req.headers.authorization ?? '') ||
      !!readCookie(req, SESSION_COOKIE);
    if (!hasSession) {
      next();
      return;
    }
    const encoding = String(req.headers['content-encoding'] ?? 'identity').toLowerCase();
    const charset = /charset=([^;]+)/i.exec(req.headers['content-type'] ?? '')?.[1];
    if (
      encoding !== 'identity' ||
      (charset && !/^"?utf-?8"?$/i.test(charset.trim()))
    ) {
      req.resume();
      answer(res, 415, { statusCode: 415, message: 'Unsupported Media Type' });
      return;
    }
    const tooLarge = () =>
      answer(res, 413, {
        statusCode: 413,
        message: 'Payload Too Large',
        code: 'body_too_large',
        max: limit,
      });
    if (Number(req.headers['content-length'] ?? 0) > limit) {
      // What was sent is read and dropped, so that the connection can be
      // used again.
      req.resume();
      tooLarge();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        answer(res, 400, { statusCode: 400, message: 'Bad Request' });
        return;
      }
      req.body = body;
      next();
    });
    req.on('error', () => {
      if (!over && !res.headersSent) {
        answer(res, 400, { statusCode: 400, message: 'Bad Request' });
      }
      over = true;
    });
  };
}
