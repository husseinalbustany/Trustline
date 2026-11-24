import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  PlatformAuthService,
  type PlatformAdmin,
} from './platform-auth.service.js';

export const SESSION_COOKIE = 'tl_platform_session';

export type PlatformRequest = Request & {
  platformAdmin: PlatformAdmin;
  platformToken: string;
};

export function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

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
