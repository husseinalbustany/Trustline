import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { clientKey, RateLimiter } from '../security/rate-limiter.js';

const HOUR = 3_600_000;

export const PUBLIC_REPORTS_PER_HOUR = 10;
export const FOLLOW_UP_ATTEMPTS_PER_HOUR = 30;

/**
 * How often one address may use the routes that need no sign-in.
 *
 * Counted per address and per kind of use, never per path: the count is
 * taken inside the route's own handler, so however an address is written to
 * reach that handler (another letter case, a trailing slash, another
 * hospital's identifier), it is the same count. Every attempt counts,
 * whether or not it succeeds.
 *
 * In memory, so per API process: see RateLimiter.
 */
@Injectable()
export class PublicLimits {
  private readonly limiters = {
    report: new RateLimiter(PUBLIC_REPORTS_PER_HOUR, HOUR),
    // Opening a report with a code and commenting with one share a count:
    // both are attempts at a code.
    followUp: new RateLimiter(FOLLOW_UP_ATTEMPTS_PER_HOUR, HOUR),
  };

  /**
   * Counts this request, or refuses it with 429 `too_many_requests`. The
   * address is the one Express worked out under the proxy setting of
   * app.setup.ts; no header is read here.
   */
  count(use: keyof typeof this.limiters, req: Request, res: Response) {
    const wait = this.limiters[use].hit(clientKey(req.ip));
    if (wait === 0) return;
    res.setHeader('Retry-After', String(wait));
    throw new HttpException(
      { statusCode: 429, code: 'too_many_requests' },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
