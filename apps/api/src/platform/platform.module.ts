import { Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthGuard } from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformImportWindowController } from './platform-import-window.controller.js';
import { PlatformPlansController } from './platform-plans.controller.js';
import { PlatformSubscriptionsController } from './platform-subscriptions.controller.js';
import { PlatformTenantsController } from './platform-tenants.controller.js';

/** The admin portal's API: Trustline staff managing client hospitals. */
@Module({
  // For counting a client's sites against its limit.
  imports: [OrganizationModule],
  controllers: [
    PlatformAuthController,
    PlatformTenantsController,
    PlatformPlansController,
    PlatformSubscriptionsController,
    PlatformImportWindowController,
  ],
  providers: [PlatformAuthService, PlatformAuthGuard],
})
export class PlatformModule {}
