import { Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module.js';
import {
  IncidentCategoriesController,
  IncidentsController,
} from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';
import { PublicLimits } from './public-limits.js';
import { PublicReportingController } from './public.controller.js';
import { IncidentSettingsController } from './settings.controller.js';

/** Reporting an incident, triaging it, and following it to its close. */
@Module({
  imports: [OrganizationModule],
  controllers: [
    IncidentCategoriesController,
    IncidentsController,
    IncidentSettingsController,
    PublicReportingController,
  ],
  providers: [IncidentsService, PublicLimits],
})
export class IncidentsModule {}
