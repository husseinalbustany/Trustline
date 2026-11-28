import { Global, Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module.js';
import { AccessService } from './access.service.js';
import { AuthController, SigningPinController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ExternalAccessController } from './external-access.controller.js';
import { ExternalAccessService } from './external-access.service.js';
import { ProvisioningService } from './provisioning.service.js';
import { SecurityNotices } from './security-notices.service.js';
import { SignInCodes } from './sign-in-codes.service.js';
import { RolesController } from './roles.controller.js';
import { SessionGuard } from './session.guard.js';
import { TenantSettingsService } from './tenant-settings.service.js';
import { UsersController } from './users.controller.js';

/** Hospital users: sign-in, sessions, users, roles and permissions. */
@Global()
@Module({
  // For checking the org unit a user or a role grant is placed in.
  imports: [OrganizationModule],
  // The external reviewers' routes before the users' own, whose `:id`
  // would otherwise take `external`.
  controllers: [AuthController, SigningPinController, ExternalAccessController, UsersController, RolesController],
  providers: [
    AccessService,
    AuthService,
    ExternalAccessService,
    ProvisioningService,
    SecurityNotices,
    SessionGuard,
    SignInCodes,
    TenantSettingsService,
  ],
  // Global so any module can protect its routes with SessionGuard.
  exports: [
    AccessService,
    AuthService,
    ExternalAccessService,
    ProvisioningService,
    SessionGuard,
    TenantSettingsService,
  ],
})
export class IdentityModule {}
