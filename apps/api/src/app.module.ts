import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { PoliciesModule } from './policies/policies.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';

@Module({
  imports: [
    DatabaseModule,
    SubscriptionsModule,
    IdentityModule,
    OrganizationModule,
    IncidentsModule,
    PoliciesModule,
    PlatformModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
