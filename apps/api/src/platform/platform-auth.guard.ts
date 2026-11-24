import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { readCookie } from '../security/cookies.js';
import {
  PlatformAuthService,
  type PlatformAdmin,
} from './platform-auth.service.js';

export const SESSION_COOKIE = 'tl_platform_session';

export type PlatformRequest = Request & {
  platformAdmin: PlatformAdmin;
  platformToken: string;
};

/** Lets a request through only with a live platform admin session. */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(private readonly auth: PlatformAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<PlatformRequest>();
    const token = readCookie(req, SESSION_COOKIE);
    const admin = token ? await this.auth.findSession(token) : null;
    if (!token || !admin) throw new UnauthorizedException();
    req.platformAdmin = admin;
    req.platformToken = token;
    return true;
  }
}
