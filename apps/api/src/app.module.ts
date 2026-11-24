import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { IdentityModule } from './identity/identity.module.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [DatabaseModule, IdentityModule, PlatformModule],
  controllers: [HealthController],
})
export class AppModule {}
