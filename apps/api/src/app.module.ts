import { Module } from '@nestjs/common';
import { AiModule } from './ai/ai.module.js';
import { AuditModule } from './audit/audit.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DraftingModule } from './drafting/drafting.module.js';
import { EmailModule } from './email/email.module.js';
import { MailModule } from './email/mail.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { OrganizationModule } from './organization/organization.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { PoliciesModule } from './policies/policies.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ExportsModule } from './exports/exports.module.js';
import { RisksModule } from './risks/risks.module.js';
import { SubscriptionsModule } from './subscriptions/subscriptions.module.js';

@Module({
  imports: [
    DatabaseModule,
    SubscriptionsModule,
    IdentityModule,
    MailModule,
    OrganizationModule,
    IncidentsModule,
    PoliciesModule,
    RisksModule,
    EmailModule,
    PlatformModule,
    AuditModule,
    ReportsModule,
    ExportsModule,
    AiModule,
    DraftingModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
