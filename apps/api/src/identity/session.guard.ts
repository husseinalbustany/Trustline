import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { readCookie } from '../security/cookies.js';
import { allows } from '../subscriptions/entitlements.service.js';
import {
  MODULE_KEY,
  noSuchRoute,
  OPEN_WHILE_SUSPENDED_KEY,
} from '../subscriptions/module.decorator.js';
import type { ModuleKey } from '../subscriptions/modules.js';
import { AuthService, type AuthContext } from './auth.service.js';
import type { Permission } from './permissions.js';
import { covers } from './scope.js';

export const SESSION_COOKIE = 'tl_session';

export type AuthedRequest = Request & { auth: AuthContext };

/** Methods that only read. Every other one is a write. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Lets a request through only with a live hospital user session. The web app
 * sends it as a cookie, a mobile app as a bearer token.
 *
 * It is also where what the client's subscription allows is enforced, for
 * every signed-in route at once, before the route's own code runs:
 *
 * - A route of a module the client does not have (`@ForModule()` on its
 *   controller) answers exactly as a route that does not exist: 404, with
 *   Nest's own words for that. A route whose controller declares no module
 *   is refused, so a new one cannot be served by forgetting.
 * - While the subscription is suspended, a route that writes is refused
 *   with 403 `subscription_suspended`, unless it is of the incidents module
 *   (a billing matter never blocks safety work: reporting, handling and
 *   closing incidents, and the settings of reporting, all stay open) or is
 *   marked `@OpenWhileSuspended()`. A route marked so that takes more than
 *   a reduction of access refuses the rest itself: see `whileSuspended()`.
 *
 * Both come after the session, so without one the answer is 401 as before.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const module = this.reflector.getAllAndOverride<ModuleKey | undefined>(
      MODULE_KEY,
      targets,
    );
    if (!module) {
      throw new Error(
        `${context.getClass().name} declares no module: add @ForModule()`,
      );
    }

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const token = bearer ?? readCookie(req, SESSION_COOKIE);
    const auth = token ? await this.auth.resolve(token) : null;
    if (!auth) throw new UnauthorizedException();
    req.auth = auth;

    const { modules, subscription } = auth.tenant;
    if (!allows({ modules, status: subscription.status }, module)) {
      throw noSuchRoute(req);
    }
    if (
      subscription.status === 'suspended' &&
      !READS.has(req.method) &&
      !OPEN_MODULES_WHILE_SUSPENDED.has(module) &&
      !this.reflector.getAllAndOverride<boolean>(
        OPEN_WHILE_SUSPENDED_KEY,
        targets,
      )
    ) {
      throw suspendedRefusal();
    }
    return true;
  }
}

/**
 * The modules whose every route stays open while the subscription is
 * suspended. Incidents: a billing matter never blocks safety work.
 */
const OPEN_MODULES_WHILE_SUSPENDED = new Set<ModuleKey>(['incidents']);

const suspendedRefusal = () =>
  new ForbiddenException({ code: 'subscription_suspended' });

/**
 * For a route marked `@OpenWhileSuspended()` because part of what it takes
 * must go on working while the subscription is suspended (taking access
 * away): refuses with 403 `subscription_suspended`, while suspended, unless
 * `allowed()` says this request is such a part. Call it after the
 * permission check and the validation, and before writing anything.
 */
export async function whileSuspended(
  req: AuthedRequest,
  allowed: () => boolean | Promise<boolean>,
) {
  if (req.auth.tenant.subscription.status !== 'suspended') return;
  if (!(await allowed())) throw suspendedRefusal();
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
