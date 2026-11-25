import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import {
  requireEverywhere,
  SessionGuard,
  type AuthedRequest,
} from '../identity/session.guard.js';
import { TenantSettingsService } from '../identity/tenant-settings.service.js';

const reportingSchema = z.strictObject({ publicReporting: z.boolean() });

/**
 * What a hospital decides about its own incident reporting. Each setting is
 * for the hospital as a whole, so it needs `settings.manage` for the whole
 * organization: holding it for one department is not enough.
 */
@Controller('settings')
@UseGuards(SessionGuard)
export class IncidentSettingsController {
  constructor(private readonly settings: TenantSettingsService) {}

  /**
   * Whether the hospital takes reports without sign-in, and the identifier
   * its public link is made of.
   */
  @Get('reporting')
  reporting(@Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    const { publicReporting, slug } = req.auth.tenant;
    return { publicReporting, slug };
  }

  @Put('reporting')
  setReporting(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    const parsed = reportingSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.settings.setPublicReporting(
      req.auth,
      parsed.data.publicReporting,
    );
  }
}
