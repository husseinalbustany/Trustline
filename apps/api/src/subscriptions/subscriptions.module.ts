import { Global, Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module.js';
import { EntitlementsService } from './entitlements.service.js';
import { PlansService } from './plans.service.js';
import { SubscriptionSettingsController } from './subscription-settings.controller.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * Modules, plans and subscriptions: what each client may use, and the one
 * service every other area asks (EntitlementsService). Global, like the
 * identity module, so that any area can ask it.
 */
@Global()
@Module({
  // For counting a client's sites.
  imports: [OrganizationModule],
  controllers: [SubscriptionSettingsController],
  providers: [EntitlementsService, PlansService, SubscriptionsService],
  exports: [EntitlementsService, PlansService, SubscriptionsService],
})
export class SubscriptionsModule {}
