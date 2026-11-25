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
import { AuthService } from '../identity/auth.service.js';
import { IncidentsService } from './incidents.service.js';
import { PublicLimits, tooManyRequests } from './public-limits.js';
import {
  hasControlCharacter,
  parseReport,
  publicReportSchema,
  text,
} from './report-input.js';

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
 * Reporting an incident, and coming back to an anonymous report, without
 * signing in. Open to the internet: there is no guard on this controller,
 * and no route here reads a session even when the caller has one, so a
 * follow-up code is never tied to an account.
 *
 * Nothing about the sender is passed to the service. Their address is used
 * once, in memory, to count their attempts.
 */
@Controller('public')
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
    return this.auth.findTenant(SLUG.test(slug) ? slug : NO_SLUG, false);
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

  /** What the report form needs to show. */
  @Get('reporting/:slug')
  async form(@Param('slug') slug: string) {
    const tenant = await this.takingReports(slug);
    if (!tenant) throw new NotFoundException();
    return {
      name: tenant.name,
      locales: tenant.locales,
      defaultLocale: tenant.defaultLocale,
      ...(await this.incidents.publicForm(tenant.id)),
    };
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
    const tenant = await this.takingReports(slug);
    if (!tenant) throw new NotFoundException();
    const result = await this.incidents.reportPublicly(
      tenant,
      parseReport(publicReportSchema, body),
    );
    // The hospital has had as many public reports this hour as it takes,
    // wherever they came from.
    if ('retryAfter' in result) throw tooManyRequests(res, result.retryAfter);
    return result;
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
    const tenant = await this.active(slug);
    // With no hospital the service still takes every step, and answers 404.
    return this.incidents.followUp(tenant?.id ?? null, parsed.data.code);
  }

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
    const tenant = await this.active(slug);
    return this.incidents.followUpComment(
      tenant?.id ?? null,
      parsed.data.code,
      parsed.data.body,
    );
  }
}
