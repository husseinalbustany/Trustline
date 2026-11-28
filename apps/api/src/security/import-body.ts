import type { NextFunction, Request, Response } from 'express';
import type { AuthContext } from '../identity/auth.service.js';
import { covers } from '../identity/scope.js';
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

/**
 * How deeply arrays and objects may nest in such a body. An import is
 * nested five deep at most (batch, documents, document, content, language);
 * JSON.parse of a body nested deeper is work done for nobody.
 */
export const IMPORT_BODY_MAX_DEPTH = 64;

/** The import routes, under the prefix the API is served at ('' or '/api/v1'). */
const importPaths = (prefix: string) => {
  if (!/^(?:\/[a-z0-9]+)*$/.test(prefix)) {
    throw new Error(`Invalid API prefix: ${prefix}`);
  }
  return new RegExp(
    `^${prefix}/policies/(?:imports(?:/check)?|documents/import)$`,
  );
};

/**
 * Whether JSON nests arrays and objects deeper than `max`, read byte by
 * byte without parsing it: brackets inside strings are text. Every byte of
 * a character beyond ASCII is 0x80 or more in UTF-8, so none is taken for a
 * bracket or a quote.
 */
export function nestsDeeperThan(body: Buffer, max: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const byte of body) {
    if (inString) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) inString = false;
      continue;
    }
    if (byte === 0x22) inString = true;
    else if (byte === 0x5b || byte === 0x7b) {
      depth += 1;
      if (depth > max) return true;
    } else if (byte === 0x5d || byte === 0x7d) depth -= 1;
  }
  return false;
}

export type ImportBodyOptions = {
  /** The global prefix the API is served under: '/api/v1', or '' in tests. */
  prefix?: string;
  limit?: number;
  maxDepth?: number;
  /** Who a session token belongs to: AuthService.resolve. */
  resolve: (token: string) => Promise<AuthContext | null>;
};

const answer = (res: Response, status: number, body: Record<string, unknown>) => {
  res.status(status).json(body);
};

/**
 * Reads the JSON body of the import routes up to IMPORT_BODY_LIMIT, only
 * for a caller whose session is live and who may import (`policies.manage`
 * for the whole organization), looked up as the route's guard does before
 * a byte of the body is read (security review 7, finding 1). Anything
 * else, and every other route, is left to Nest's own parser and its
 * 100 kB; the route's guard then answers 401 or 403 as for any route. The
 * path is matched whole, under the API's own prefix. Registered before
 * Nest's parser, which then finds the body read and leaves it.
 *
 * UTF-8 JSON only, not compressed (415 otherwise); a body over the limit
 * is answered 413 `body_too_large` with the `max`; one nested deeper than
 * IMPORT_BODY_MAX_DEPTH 400 `body_too_deep` with the `max`, before it is
 * parsed; and one that is not JSON 400.
 */
export function importBodyParser({
  prefix = '',
  limit = IMPORT_BODY_LIMIT,
  maxDepth = IMPORT_BODY_MAX_DEPTH,
  resolve,
}: ImportBodyOptions) {
  const paths = importPaths(prefix);
  return (req: Request, res: Response, next: NextFunction) => {
    if (
      req.method !== 'POST' ||
      !paths.test(req.path) ||
      !req.is('application/json')
    ) {
      next();
      return;
    }
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const token = bearer ?? readCookie(req, SESSION_COOKIE);
    if (!token) {
      next();
      return;
    }
    // Nothing of the body is read while this is looked up.
    resolve(token).then(
      (auth) => {
        if (!auth || !covers(auth, 'policies.manage', null)) next();
        else read(req, res, next);
      },
      // Whatever went wrong, the guard meets it again; the body is not read.
      () => next(),
    );
  };

  function read(req: Request, res: Response, next: NextFunction) {
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
      const raw = Buffer.concat(chunks);
      if (nestsDeeperThan(raw, maxDepth)) {
        answer(res, 400, {
          statusCode: 400,
          message: 'Bad Request',
          code: 'body_too_deep',
          max: maxDepth,
        });
        return;
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString('utf8'));
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
  }
}
