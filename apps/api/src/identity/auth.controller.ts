import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { sessionCookieOptions } from '../security/cookies.js';
import {
  AuthService,
  MIN_PASSWORD_LENGTH,
  SESSION_HOURS,
} from './auth.service.js';
import {
  SESSION_COOKIE,
  SessionGuard,
  type AuthedRequest,
} from './session.guard.js';

const org = z.string().min(1).max(100);

const loginSchema = z.object({
  org,
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  client: z.enum(['web', 'mobile']).default('web'),
});

const inviteSchema = z.object({ org, token: z.string().min(1).max(200) });

const acceptSchema = inviteSchema.extend({
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();

    const token = await this.auth.login({ ...parsed.data, ip: req.ip ?? null });
    if (!token) throw new UnauthorizedException();

    // A mobile app keeps the token itself. A browser never sees it.
    if (parsed.data.client === 'mobile') return { token };
    res.cookie(SESSION_COOKIE, token, {
      ...sessionCookieOptions,
      maxAge: SESSION_HOURS * 3_600_000,
    });
    return { ok: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@Req() req: AuthedRequest) {
    const { tenant, user, permissions, scope } = req.auth;
    return { tenant, user, permissions, scope };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(
    @Req() req: AuthedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(req.auth);
    res.clearCookie(SESSION_COOKIE, sessionCookieOptions);
  }

  /** Tells the set-password page who the link is for. */
  @Post('invite/check')
  @HttpCode(200)
  async checkInvite(@Body() body: unknown) {
    const parsed = inviteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const info = await this.auth.checkInvite(
      parsed.data.org,
      parsed.data.token,
    );
    if (!info) throw new NotFoundException();
    return info;
  }

  @Post('invite/accept')
  @HttpCode(204)
  async acceptInvite(@Body() body: unknown) {
    const parsed = acceptSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const { org, token, password } = parsed.data;
    if (!(await this.auth.acceptInvite(org, token, password))) {
      throw new NotFoundException();
    }
  }
}
