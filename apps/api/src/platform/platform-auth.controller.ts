import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { sessionCookieOptions } from '../security/cookies.js';
import { z } from 'zod';
import { identifier } from '../i18n/text.js';
import {
  PlatformAuthGuard,
  SESSION_COOKIE,
  type PlatformRequest,
} from './platform-auth.guard.js';
import { PlatformAuthService, SESSION_HOURS } from './platform-auth.service.js';
import { ForModule } from '../subscriptions/module.decorator.js';

const loginSchema = z.object({
  // Refused as malformed when it carries a control character, before it is
  // looked up: the database would answer such a value with an error.
  email: identifier(320),
  password: z.string().min(1).max(1024),
});

@Controller('platform/auth')
@ForModule('core')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();

    const result = await this.auth.login(
      parsed.data.email,
      parsed.data.password,
    );
    if (!result) throw new UnauthorizedException();

    res.cookie(SESSION_COOKIE, result.token, {
      ...sessionCookieOptions,
      maxAge: SESSION_HOURS * 3_600_000,
    });
    return result.admin;
  }

  @Get('me')
  @UseGuards(PlatformAuthGuard)
  me(@Req() req: PlatformRequest) {
    return req.platformAdmin;
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(PlatformAuthGuard)
  async logout(
    @Req() req: PlatformRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req.platformToken, req.platformAdmin.id);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  }
}
