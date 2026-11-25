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
import { PublicLimits } from './public-limits.js';
import { parseReport, publicReportSchema, text } from './report-input.js';

// Loose on purpose. A reference or a code that could never be right is not
// refused as invalid: it gets the same 404 as any other wrong one.
const followUpFields = {
  reference: z.string().min(1).max(40),
  code: z.string().min(1).max(80),
};

const followUpSchema = z.strictObject(followUpFields);

const followUpCommentSchema = z.strictObject({
  ...followUpFields,
  body: text(1, 2000),
});

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
   * The hospital, if it takes reports without sign-in; otherwise null,
   * whether it does not exist, is suspended, or has not switched this on.
   * Found the way sign-in finds a hospital.
   */
  private async hospital(slug: string) {
    const tenant = await this.auth.findTenant(slug, false);
    return tenant?.publicReporting ? tenant : null;
  }

  /** What the report form needs to show. */
  @Get('reporting/:slug')
  async form(@Param('slug') slug: string) {
    const tenant = await this.hospital(slug);
    if (!tenant) throw new NotFoundException();
    return {
      name: tenant.name,
      locales: tenant.locales,
      defaultLocale: tenant.defaultLocale,
      ...(await this.incidents.publicForm(tenant.id)),
    };
  }

  @Post('reporting/:slug')
  async report(
    @Param('slug') slug: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.limits.count('report', req, res);
    const tenant = await this.hospital(slug);
    if (!tenant) throw new NotFoundException();
    return this.incidents.reportPublicly(
      tenant.id,
      parseReport(publicReportSchema, body),
    );
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
    const tenant = await this.hospital(slug);
    // With no hospital the service still takes every step, and answers 404.
    return this.incidents.followUp(
      tenant?.id ?? null,
      parsed.data.reference,
      parsed.data.code,
    );
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
    const tenant = await this.hospital(slug);
    return this.incidents.followUpComment(
      tenant?.id ?? null,
      parsed.data.reference,
      parsed.data.code,
      parsed.data.body,
    );
  }
}
