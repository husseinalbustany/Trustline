import { Global, Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ProvisioningService } from './provisioning.service.js';
import { RolesController } from './roles.controller.js';
import { SessionGuard } from './session.guard.js';
import { TenantSettingsService } from './tenant-settings.service.js';
import { UsersController } from './users.controller.js';

/** Hospital users: sign-in, sessions, users, roles and permissions. */
@Global()
@Module({
  // For checking the org unit a user or a role grant is placed in.
  imports: [OrganizationModule],
  controllers: [AuthController, UsersController, RolesController],
  providers: [
    AuthService,
    ProvisioningService,
    SessionGuard,
    TenantSettingsService,
  ],
  // Global so any module can protect its routes with SessionGuard.
  exports: [
    AuthService,
    ProvisioningService,
    SessionGuard,
    TenantSettingsService,
  ],
})
export class IdentityModule {}
