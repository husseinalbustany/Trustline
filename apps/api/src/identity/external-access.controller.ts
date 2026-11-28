import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { localeSchema, localizedText } from '../i18n/locales.js';
import { line } from '../i18n/text.js';
import { ForModule, OpenWhileSuspended } from '../subscriptions/module.decorator.js';
import { ExternalAccessService } from './external-access.service.js';
import { requireEverywhere, SessionGuard, type AuthedRequest } from './session.guard.js';

const day = z.iso.date();
const revision = z.number().int().min(0);

const grantSchema = z.strictObject({
  name: localizedText(100),
  email: z.email().max(320),
  // Where they come from (an accreditation body), and why.
  organization: line(1, 200),
  purpose: line(1, 500),
  from: day,
  until: day,
  roleId: z.uuid(),
  preferredLocale: localeSchema.nullable().optional(),
});

const changeSchema = z.union([
  z.strictObject({ until: day, reason: line(1, 500), revision }),
  z.strictObject({ end: z.literal(true), revision }),
]);

/**
 * External reviewer access (docs/specs/audit-trail.md): who holds it, and
 * granting, extending and ending it. Listed by whoever manages users for
 * the whole organization; changed only by whoever also reads the audit
 * trail for it. Open while the subscription is suspended: a survey can fall
 * during a billing dispute.
 */
@Controller('users/external')
@UseGuards(SessionGuard)
@ForModule('core')
export class ExternalAccessController {
  constructor(private readonly external: ExternalAccessService) {}

  @Get()
  list(@Req() req: AuthedRequest) {
    requireEverywhere(req, 'users.manage');
    return this.external.list(req.auth);
  }

  @Post()
  @OpenWhileSuspended()
  grant(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'users.manage');
    requireEverywhere(req, 'audit.view');
    const parsed = grantSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.external.grant(req.auth, parsed.data);
  }

  @Patch(':id')
  @OpenWhileSuspended()
  change(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'users.manage');
    requireEverywhere(req, 'audit.view');
    if (!z.uuid().safeParse(id).success) throw new NotFoundException();
    const parsed = changeSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.external.change(req.auth, id, parsed.data);
  }
}
