import { Module } from '@nestjs/common';
import { ActionCheck } from './action-check.service.js';
import { ActionNotifier } from './action-notifier.js';
import { ActionsService } from './actions.service.js';

/**
 * The shared actions engine (docs/specs/actions.md): no routes of its own.
 * A module that calls for actions imports this, registers its source's
 * rules with `ActionsService.register`, and serves the routes under its own
 * module. The reminders are `ActionCheck`, started by `main.ts`.
 */
@Module({
  providers: [ActionsService, ActionNotifier, ActionCheck],
  exports: [ActionsService, ActionCheck],
})
export class ActionsModule {}
