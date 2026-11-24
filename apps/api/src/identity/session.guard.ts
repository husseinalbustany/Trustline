import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { readCookie } from '../security/cookies.js';
import { AuthService, type AuthContext } from './auth.service.js';
import type { Permission } from './permissions.js';
import { covers } from './scope.js';

export const SESSION_COOKIE = 'tl_session';

export type AuthedRequest = Request & { auth: AuthContext };

/**
 * Lets a request through only with a live hospital user session. The web app
 * sends it as a cookie, a mobile app as a bearer token.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const token = bearer ?? readCookie(req, SESSION_COOKIE);
    const auth = token ? await this.auth.resolve(token) : null;
    if (!auth) throw new UnauthorizedException();
    req.auth = auth;
    return true;
  }
}

/**
 * Refuses the request unless the signed-in user's roles allow this somewhere:
 * for the whole organization or for any one unit. Where the place matters,
 * ask `covers()`, or use `requireEverywhere()`.
 */
export function requirePermission(req: AuthedRequest, permission: Permission) {
  if (!req.auth.permissions.includes(permission)) {
    throw new ForbiddenException({ code: 'missing_permission', permission });
  }
}

/**
 * Refuses the request unless the user holds this for the whole organization.
 * For what belongs to the hospital as a whole (its structure, its roles): a
 * role granted for one department must not reach it.
 */
export function requireEverywhere(req: AuthedRequest, permission: Permission) {
  if (!covers(req.auth, permission, null)) {
    throw new ForbiddenException({ code: 'missing_permission', permission });
  }
}
