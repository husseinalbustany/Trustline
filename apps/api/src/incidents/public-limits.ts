import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { clientKey, RateLimiter } from '../security/rate-limiter.js';

const HOUR = 3_600_000;

export const PUBLIC_REPORTS_PER_HOUR = 10;
export const FOLLOW_UP_ATTEMPTS_PER_HOUR = 30;
/**
 * How often one address may open a hospital's public report form. Far more
 * than anyone filling it in needs, and too few to go through a list of
 * identifiers looking for hospitals that take reports.
 */
export const PUBLIC_FORM_READS_PER_HOUR = 60;
/**
 * Reports through the public link that one hospital takes in an hour,
 * whatever addresses they come from. The limit per address rests on the
 * address being true, which the API cannot check for itself; this one rests
 * on nothing a sender controls. Counted in the database by IncidentsService,
 * so it is the same for every API process and survives a restart.
 */
export const PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR = 60;
/**
 * Comments one incident takes in 24 hours from whoever holds its follow-up
 * code. The code cannot be taken back and a comment cannot be removed, each
 * one is stored for good and tells the people handling the incident: so
 * what a code can write is bounded per incident, whatever addresses it is
 * used from. Counted in the database by IncidentsService, like the ceiling
 * above.
 */
export const FOLLOW_UP_COMMENTS_PER_INCIDENT_PER_DAY = 10;
/**
 * What a public report is told to wait, in seconds, when another report to
 * the same hospital was being stored at that very moment.
 */
export const BUSY_RETRY_SECONDS = 1;

/**
 * A wait as the public routes tell it: whole seconds, rounded up, one at the
 * least. `Retry-After` takes nothing finer, and nothing finer is said
 * anywhere else either: how long is left to the millisecond would date the
 * report that holds the hour to the millisecond.
 */
export const wholeSeconds = (seconds: number) =>
  Math.max(Math.ceil(seconds), 1);

/** What every limit on the public routes answers when it is reached. */
export function tooManyRequests(res: Response, retryAfterSeconds: number) {
  res.setHeader('Retry-After', String(wholeSeconds(retryAfterSeconds)));
  return new HttpException(
    { statusCode: 429, code: 'too_many_requests' },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * How often one address may use the routes that need no sign-in.
 *
 * The address is only as true as the proxy in front of the web app makes it:
 * see app.setup.ts and the README. Anything that is not an IP address counts
 * as one client. A hospital's public form has a ceiling of its own besides
 * (PUBLIC_REPORTS_PER_HOSPITAL_PER_HOUR), which does not rest on the address.
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
    form: new RateLimiter(PUBLIC_FORM_READS_PER_HOUR, HOUR),
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
    throw tooManyRequests(res, wait);
  }

  /**
   * Forgets every count, as a restart of the process would. For tests, which
   * all call from one address.
   */
  forget() {
    for (const limiter of Object.values(this.limiters)) limiter.clear();
  }
}
