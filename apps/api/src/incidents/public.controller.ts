import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { hasControlCharacter, text } from '../i18n/text.js';
import { AuthService } from '../identity/auth.service.js';
import { IncidentsService } from './incidents.service.js';
import { PublicLimits, tooManyRequests } from './public-limits.js';
import { parseReport, publicReportSchema } from './report-input.js';
import {
  declaredModule,
  ForModule,
} from '../subscriptions/module.decorator.js';

// Loose on purpose. A code that could never be right is not refused as
// invalid: it gets the same 404 as any other wrong one. Only what is not
// text at all, or carries control characters, is a malformed request, and is
// refused before anything is looked up.
const followUpFields = {
  code: z
    .string()
    .min(1)
    .max(80)
    .refine((v) => !hasControlCharacter(v)),
};

const followUpSchema = z.strictObject(followUpFields);

const followUpCommentSchema = z.strictObject({
  ...followUpFields,
  body: text(1, 2000),
});

/** What a hospital's identifier can look like. Nothing else is looked up. */
const SLUG = /^[a-z0-9-]{1,40}$/i;
/** Looked up in place of text that is not one. No hospital can have it. */
const NO_SLUG = '-';

/**
 * The step, in milliseconds, in which a "not found" on these routes is
 * answered. Every such refusal takes the same steps whether the hospital
 * exists, is suspended, has its public form off, or the code is simply
 * wrong; but the same steps are not the same time to the last tenth of a
 * millisecond (a hospital that is found is read, one that has reports has an
 * index to walk). So a refusal is held until the next multiple of this step
 * since the request was taken up. The step is well beyond what the work
 * needs, so normally every refusal takes exactly one; and when the server is
 * so busy that the work takes longer, the answer still comes on a step, not
 * at the moment the work happened to end. How long the work took shows only
 * as a whole number of steps.
 */
export const REFUSAL_STEP_MS = 50;

/**
 * How much longer to hold a refusal that has taken `elapsedMs` so far: up to
 * the next multiple of the step, and one whole step at the least.
 */
export const heldFor = (elapsedMs: number, stepMs = REFUSAL_STEP_MS) =>
  Math.max(Math.ceil(elapsedMs / stepMs), 1) * stepMs - elapsedMs;

/**
 * Reporting an incident, and coming back to an anonymous report, without
 * signing in. Open to the internet: there is no guard on this controller,
 * and no route here reads a session even when the caller has one, so a
 * follow-up code is never tied to an account.
 *
 * Nothing about the sender is passed to the service. Their address is used
 * once, in memory, to count their attempts.
 *
 * Whoever is refused because there is nothing to show them (no such
 * hospital, a suspended one, one whose subscription is cancelled or does not
 * include incidents, a form that is off, a wrong code) gets the same 404 on
 * the same step of time: see `refusedAlike()`. A suspended subscription
 * leaves all of these open: reporting is never closed by a billing matter.
 */
@Controller('public')
@ForModule('incidents')
export class PublicReportingController {
  constructor(
    private readonly incidents: IncidentsService,
    private readonly auth: AuthService,
    private readonly limits: PublicLimits,
  ) {}

  /**
   * The hospital with this identifier, if it exists and is active; otherwise
   * null. Found the way sign-in finds a hospital. Text that could not be an
   * identifier never reaches a query, control characters and all: an
   * identifier no hospital has is looked up in its place, so it is answered
   * like any other hospital that does not exist, after the same work.
   */
  private active(slug: string) {
    return this.auth.findTenant(
      SLUG.test(slug) ? slug : NO_SLUG,
      false,
      // The module this controller declares, so that a hospital without it
      // is answered like one that does not exist: the same 404, on the same
      // step of time.
      declaredModule(PublicReportingController)!,
    );
  }

  /**
   * The same, if it also takes reports without sign-in. Not existing, being
   * suspended and not having switched this on all give null. For the two
   * report routes only: following up a report does not depend on the switch.
   */
  private async takingReports(slug: string) {
    const tenant = await this.active(slug);
    return tenant?.publicReporting ? tenant : null;
  }

  /**
   * What the report form needs to show. Counted per address like the other
   * public routes, and refused on the same step of time whether the
   * hospital does not exist, is suspended or has the form off: otherwise
   * this route would say, to anyone going through a list of names, which of
   * them are hospitals here.
   *
   * It also says whether the hospital's hourly ceiling is reached (`paused`,
   * and `retryAfterSeconds` until a place frees, else null), so that a
   * sender is told before writing, not after. Only once the hospital is
   * found and takes reports: every refusal is the same 404 as before.
   */
  @Get('reporting/:slug')
  form(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.limits.count('form', req, res);
    return this.refusedAlike(async () => {
      const tenant = await this.takingReports(slug);
      if (!tenant) throw new NotFoundException();
      return {
        name: tenant.name,
        locales: tenant.locales,
        defaultLocale: tenant.defaultLocale,
        // The hospital's own clock, so the form can ask when it happened in
        // the hospital's time whatever the sender's device is set to.
        timeZone: tenant.timeZone,
        ...(await this.incidents.publicForm(tenant.id)),
      };
    });
  }

  /**
   * Answers with the follow-up code and nothing else: no incident number,
   * which would tell the sender how many incidents the hospital has had.
   */
  @Post('reporting/:slug')
  async report(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.limits.count('report', req, res);
    const tenant = await this.refusedAlike(async () => {
      const found = await this.takingReports(slug);
      if (!found) throw new NotFoundException();
      return found;
    });
    const result = await this.incidents.reportPublicly(
      tenant,
      parseReport(publicReportSchema, body),
    );
    // The hospital has had as many public reports this hour as it takes,
    // wherever they came from; or another one was being stored at that very
    // moment, and this one is to be sent again.
    if ('retryAfter' in result) throw tooManyRequests(res, result.retryAfter);
    return result;
  }

  /**
   * What the follow-up page shows of the hospital, once the code has proved
   * right: its name, languages and clock (so times are shown in the
   * hospital's time, as the report form asks for them). Never part of a
   * refusal, so nothing about a hospital is learnt without a valid code, not
   * even that it exists.
   */
  private named(tenant: {
    name: unknown;
    locales: string[];
    defaultLocale: string;
    timeZone: string;
  }) {
    return {
      hospital: {
        name: tenant.name,
        locales: tenant.locales,
        defaultLocale: tenant.defaultLocale,
        timeZone: tenant.timeZone,
      },
    };
  }

  /**
   * Runs a lookup, and if it ends in "not found", holds that answer until
   * the next step of REFUSAL_STEP_MS since it began. Only that answer: one
   * that succeeds, or is refused for its form before anything was looked
   * up, says nothing by how long it took. Nor is anything held that is
   * refused after a follow-up code has proved right: by then there is
   * nothing left to hide from the caller.
   *
   * No database connection is held while waiting.
   */
  private async refusedAlike<T>(work: () => Promise<T>): Promise<T> {
    const began = performance.now();
    try {
      return await work();
    } catch (error) {
      if (error instanceof NotFoundException) {
        const wait = heldFor(performance.now() - began);
        await new Promise((done) => setTimeout(done, wait));
      }
      throw error;
    }
  }

  /** The reporter's view of their anonymous report. */
  @Post('follow-up/:slug')
  @HttpCode(200)
  async followUp(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.limits.count('followUp', req, res);
    const parsed = followUpSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.refusedAlike(async () => {
      const tenant = await this.active(slug);
      // With no hospital the service still takes every step, and answers
      // 404.
      const view = await this.incidents.followUp(
        tenant?.id ?? null,
        parsed.data.code,
      );
      // A view was found, so there is a hospital it was found in.
      return { ...view, ...this.named(tenant!) };
    });
  }

  /**
   * Adds the reporter's comment and answers with the report as it now
   * reads: the same as the route above, in one call.
   *
   * Besides the refusals of the route above, two that come only with a
   * right code, and so are answered at once and plainly: 409
   * `incident_ended` once the incident is closed or was not taken forward,
   * and 429 `too_many_requests` when it has had its comments by code for
   * 24 hours.
   */
  @Post('follow-up/:slug/comments')
  async comment(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.limits.count('followUp', req, res);
    const parsed = followUpCommentSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.refusedAlike(async () => {
      const tenant = await this.active(slug);
      const result = await this.incidents.followUpComment(
        tenant?.id ?? null,
        parsed.data.code,
        parsed.data.body,
      );
      if ('retryAfter' in result) throw tooManyRequests(res, result.retryAfter);
      return { ...result, ...this.named(tenant!) };
    });
  }
}
