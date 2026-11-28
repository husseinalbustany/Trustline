import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { localeSchema } from '../i18n/locales.js';
import {
  requireEverywhere,
  SessionGuard,
  whileSuspended,
  type AuthedRequest,
} from '../identity/session.guard.js';
import {
  ForModule,
  OpenWhileSuspended,
} from '../subscriptions/module.decorator.js';
import type { MailConfig } from './config.js';
import { EmailPreferencesService } from './email-preferences.service.js';
import {
  confirmPage,
  donePage,
  invalidPage,
  PAGE_HEADERS,
  pageLocale,
} from './pages.js';
import { MAIL_CONFIG } from './sender.js';
import { verifyUnsubscribe } from './unsubscribe-token.js';

const preferencesSchema = z
  .strictObject({
    immediate: z.boolean().optional(),
    digest: z.boolean().optional(),
    language: localeSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0);

const organizationSchema = z.strictObject({ enabled: z.boolean() });

// What a mail client posts for one click (RFC 8058), and what the page's
// button posts: that, or nothing.
const unsubscribeSchema = z.strictObject({
  'List-Unsubscribe': z.literal('One-Click').optional(),
});

/**
 * The email preferences of the person signed in: whether they get the
 * immediate emails and the digests, and in which language. No permission
 * opens or closes these: everyone has their own, and nobody has anyone
 * else's. Changing one's own stays open while the subscription is suspended,
 * like marking one's notifications read: it changes nothing of the client's
 * records.
 */
@Controller('me')
@UseGuards(SessionGuard)
@ForModule('core')
export class NotificationPreferencesController {
  constructor(private readonly preferences: EmailPreferencesService) {}

  @Get('notification-preferences')
  get(@Req() req: AuthedRequest) {
    return this.preferences.get(req.auth);
  }

  @Patch('notification-preferences')
  @OpenWhileSuspended()
  update(@Body() body: unknown, @Req() req: AuthedRequest) {
    const parsed = preferencesSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    return this.preferences.update(req.auth, parsed.data);
  }
}

/**
 * Email for the whole organization: on, or off for everyone. For whoever
 * manages the settings of the whole organization. While the subscription is
 * suspended it can be switched off, not on.
 */
@Controller('settings')
@UseGuards(SessionGuard)
@ForModule('core')
export class EmailSettingsController {
  constructor(private readonly preferences: EmailPreferencesService) {}

  @Get('email')
  get(@Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    return this.preferences.organization(req.auth);
  }

  /** Who has switched off which kind of email (quality review 3, S3). */
  @Get('email/opt-outs')
  optOuts(@Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    return this.preferences.optOuts(req.auth);
  }

  @Put('email')
  @OpenWhileSuspended()
  async set(@Body() body: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'settings.manage');
    const parsed = organizationSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    await whileSuspended(req, () => !parsed.data.enabled);
    return this.preferences.setOrganization(req.auth, parsed.data.enabled);
  }
}

/**
 * The unsubscribe link of an email: no session, the signed token in the
 * address is all it acts on (unsubscribe-token.ts). A visit shows a page
 * with one button; a post, from that button or from a mail client's own
 * unsubscribe button, switches that kind of email off. Each page says only
 * that, never anything of the person or their organization; a token that
 * is not valid, altered, expired or names nobody gets a page that says so
 * and nothing else.
 */
@Controller('email/unsubscribe')
@ForModule('core')
export class UnsubscribeController {
  constructor(
    private readonly preferences: EmailPreferencesService,
    @Inject(MAIL_CONFIG) private readonly config: MailConfig,
  ) {}

  private answer(res: Response, status: number, html: string) {
    res.status(status).set(PAGE_HEADERS).send(html);
  }

  @Get(':token')
  async confirm(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const claim = verifyUnsubscribe(this.config.linkSecret, token);
    if (!claim || !(await this.preferences.exists(claim))) {
      return this.answer(res, 404, invalidPage(pageLocale(req.headers['accept-language'])));
    }
    return this.answer(res, 200, confirmPage(claim.locale, claim.switch));
  }

  @Post(':token')
  @HttpCode(200)
  async unsubscribe(
    @Param('token') token: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const parsed = unsubscribeSchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException();
    const claim = verifyUnsubscribe(this.config.linkSecret, token);
    if (!claim || !(await this.preferences.unsubscribe(claim, req.ip ?? null))) {
      return this.answer(res, 404, invalidPage(pageLocale(req.headers['accept-language'])));
    }
    return this.answer(res, 200, donePage(claim.locale, claim.switch));
  }
}
