import { Module } from '@nestjs/common';
import { PlatformAuthController } from './platform-auth.controller.js';
import { PlatformAuthGuard } from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { PlatformTenantsController } from './platform-tenants.controller.js';

/** The admin portal's API: Trustline staff managing client hospitals. */
@Module({
  controllers: [PlatformAuthController, PlatformTenantsController],
  providers: [PlatformAuthService, PlatformAuthGuard],
})
export class PlatformModule {}
