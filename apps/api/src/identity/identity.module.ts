import { Global, Module } from '@nestjs/common';
import { OrgUnitsController } from '../organization/org-units.controller.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { ProvisioningService } from './provisioning.service.js';
import { RolesController } from './roles.controller.js';
import { SessionGuard } from './session.guard.js';
import { UsersController } from './users.controller.js';

/** Hospital users: sign-in, sessions, users, roles and permissions. */
@Global()
@Module({
  controllers: [
    AuthController,
    UsersController,
    RolesController,
    OrgUnitsController,
  ],
  providers: [AuthService, ProvisioningService, SessionGuard],
  // Global so any module can protect its routes with SessionGuard.
  exports: [AuthService, ProvisioningService, SessionGuard],
})
export class IdentityModule {}
