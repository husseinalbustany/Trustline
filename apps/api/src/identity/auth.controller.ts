import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { identifier } from '../i18n/text.js';
import { sessionCookieOptions } from '../security/cookies.js';
import {
  AuthService,
  MIN_PASSWORD_LENGTH,
  SESSION_HOURS,
} from './auth.service.js';
import {
  ForModule,
  OpenWhileSuspended,
} from '../subscriptions/module.decorator.js';
import { permissionInUse } from './permissions.js';
import {
  SESSION_COOKIE,
  SessionGuard,
  type AuthedRequest,
} from './session.guard.js';

// Who is asking, before anyone is signed in. A value with a control
// character in it is refused as malformed here, before any lookup: sent to
// the database it would be answered with an error, and for the email only
// when the organization exists, which would tell a stranger that it does.
// The password and the token are never looked up as written (one is checked
// against a hash, the other hashed first), so they may hold anything.
const org = identifier(100);

const loginSchema = z.object({
  org,
  email: identifier(320),
  password: z.string().min(1).max(1024),
  client: z.enum(['web', 'mobile']).default('web'),
});

const inviteSchema = z.object({ org, token: z.string().min(1).max(200) });

const acceptSchema = inviteSchema.extend({
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});

@Controller('auth')
@ForModule('core')
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
  /**
   * Who is signed in, for the screens: the client with the modules it has
   * and the state of its subscription, and the user's permissions. Only the
   * permissions of modules the client has, so that the menu holds nothing
   * of a module that is off; the roles keep the others.
   */
  async me(@Req() req: AuthedRequest) {
    const { tenant, user, permissions, scope } = req.auth;
    const inUse = (p: string) => permissionInUse(p, tenant.modules);
    return {
      tenant,
      user,
      // How they sign (business decision 9): `password`, `pin` (no
      // password: single sign-on only), or `none` until they set a PIN.
      signingMethod: await this.auth.signingMethodOf(req.auth),
      permissions: permissions.filter(inUse),
      scope: Object.fromEntries(
        Object.entries(scope).filter(([p]) => inUse(p)),
      ),
    };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  @OpenWhileSuspended()
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

const signingPinSchema = z.strictObject({ pin: z.string().max(40) });

/**
 * The person's own signing PIN (business decision 9), for a person who has
 * no password: set or changed only by them, within ten minutes of signing
 * in. Never shown, to anyone. Open while the subscription is suspended: it
 * is about the person, as their preferences are.
 */
@Controller('me')
@UseGuards(SessionGuard)
@ForModule('core')
export class SigningPinController {
  constructor(private readonly auth: AuthService) {}

  @Put('signing-pin')
  @HttpCode(204)
  @OpenWhileSuspended()
  async set(@Body() body: unknown, @Req() req: AuthedRequest) {
    const parsed = signingPinSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    await this.auth.setSigningPin(req.auth, parsed.data.pin, req.ip ?? null);
  }
}

