import { NotFoundException, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { ModuleKey } from './modules.js';

export const MODULE_KEY = 'trustline:module';
export const OPEN_WHILE_SUSPENDED_KEY = 'trustline:open-while-suspended';

/**
 * Says which module a controller's routes belong to. Every controller has
 * one (modules.e2e-spec.ts fails otherwise), `'core'` for what every client
 * has. SessionGuard reads it on every signed-in request: a route of a
 * module the client does not have answers exactly as a route that does not
 * exist, and a route that declares nothing is refused. Routes that need no
 * sign-in name their module where they find the client: see
 * AuthService.findTenant().
 */
export const ForModule = (module: ModuleKey) => SetMetadata(MODULE_KEY, module);

/**
 * Lets a route that writes go on working while the client's subscription is
 * suspended, which otherwise leaves only reading. For reporting an
 * incident, and for what is not a change to the client's records (signing
 * out, marking one's own notifications read).
 */
export const OpenWhileSuspended = () =>
  SetMetadata(OPEN_WHILE_SUSPENDED_KEY, true);

/** The module a controller declares, if it declares one. */
export const declaredModule = (controller: object): ModuleKey | undefined =>
  Reflect.getMetadata(MODULE_KEY, controller) as ModuleKey | undefined;

/**
 * The answer Nest gives a request that matches no route, word for word:
 * what a route of a module the client does not have answers instead.
 */
export const noSuchRoute = (req: Request) =>
  new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
