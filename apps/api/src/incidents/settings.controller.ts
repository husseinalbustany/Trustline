import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ForbiddenException } from '@nestjs/common';
import { z } from 'zod';
import { incidentHarmLevel } from '../database/schema.js';
import {
  requireEverywhere,
  SessionGuard,
  type AuthedRequest,
} from '../identity/session.guard.js';
import { TenantSettingsService } from '../identity/tenant-settings.service.js';
import {
  HARM_LEVELS,
  RULE_LIMITS,
  type ResponseRules,
} from './response-rules.js';
import { ResponseRulesService } from './response-rules.service.js';
import { ForModule } from '../subscriptions/module.decorator.js';

const reportingSchema = z.strictObject({ publicReporting: z.boolean() });

const within = ({ min, max }: { min: number; max: number }) =>
  z.number().int().min(min).max(max);

// All five harm levels, each once: the rules are saved as a whole.
const responseRulesSchema = z.strictObject({
  rules: z
    .array(
      z.strictObject({
        harmLevel: z.enum(incidentHarmLevel.enumValues),
        triageWithinHours: within(RULE_LIMITS.triageWithinHours),
        closeWithinDays: within(RULE_LIMITS.closeWithinDays),
      }),
    )
    .length(HARM_LEVELS.length)
    .refine(
      (rules) => new Set(rules.map((r) => r.harmLevel)).size === rules.length,
    ),
});

/**
 * What a hospital decides about its own incident reporting. Each setting is
 * for the hospital as a whole, so it needs `settings.manage` for the whole
 * organization: holding it for one department is not enough.
 */
@Controller('settings')
@UseGuards(SessionGuard)
@ForModule('incidents')
export class IncidentSettingsController {
  constructor(
    private readonly settings: TenantSettingsService,
    private readonly responseRules: ResponseRulesService,
  ) {}

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

  /**
   * How soon the hospital means to triage and to close an incident, by harm
   * level. Read by whoever manages the settings and by anyone who may
   * triage, anywhere: they are the ones held to these times.
   */
  @Get('response-rules')
  getResponseRules(@Req() req: AuthedRequest) {
    const { permissions } = req.auth;
    if (
      !permissions.includes('incidents.triage') &&
      !permissions.includes('settings.manage')
    ) {
      throw new ForbiddenException({
        code: 'missing_permission',
        permission: 'incidents.triage',
      });
    }
    return this.responseRules.get(req.auth);
  }

  /** Changing them is for the hospital as a whole. */
  @Put('response-rules')
  setResponseRules(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    const parsed = responseRulesSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const rules = Object.fromEntries(
      parsed.data.rules.map(({ harmLevel, ...rule }) => [harmLevel, rule]),
    ) as ResponseRules;
    return this.responseRules.set(req.auth, rules);
  }
}
