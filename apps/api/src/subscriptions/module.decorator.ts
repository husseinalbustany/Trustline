import { NotFoundException, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { ModuleKey } from './modules.js';

export const MODULE_KEY = 'trustline:module';
export const OPEN_WHILE_SUSPENDED_KEY = 'trustline:open-while-suspended';
export const OPEN_IN_EXIT_WINDOW_KEY = 'trustline:open-in-exit-window';

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
 * suspended, which otherwise leaves only reading (the routes of the
 * incidents module apart: SessionGuard leaves them all open). For what is
 * not a change to the client's records (signing out, marking one's own
 * notifications read), for issuing a sign-in link (so that staff can always
 * get in to report), and for taking access away: a route that also takes
 * more than that refuses the rest itself, with `whileSuspended()`.
 */
export const OpenWhileSuspended = () =>
  SetMetadata(OPEN_WHILE_SUSPENDED_KEY, true);

/**
 * Lets a route answer during a cancelled client's exit window
 * (docs/specs/data-export.md, "An exit window after cancellation"), when
 * only holders of `data.export` for the whole organization may sign in:
 * signing out, `/auth/me`, and the export routes. Every other route
 * answers 403 `subscription_cancelled` (SessionGuard).
 */
export const OpenInExitWindow = () => SetMetadata(OPEN_IN_EXIT_WINDOW_KEY, true);

/** The module a controller declares, if it declares one. */
export const declaredModule = (controller: object): ModuleKey | undefined =>
  Reflect.getMetadata(MODULE_KEY, controller) as ModuleKey | undefined;

/**
 * The answer Nest gives a request that matches no route, word for word:
 * what a route of a module the client does not have answers instead.
 */
export const noSuchRoute = (req: Request) =>
  new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
