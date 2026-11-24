import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { IncidentsModule } from './incidents/incidents.module.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [DatabaseModule, IdentityModule, IncidentsModule, PlatformModule],
  controllers: [HealthController],
})
export class AppModule {}
