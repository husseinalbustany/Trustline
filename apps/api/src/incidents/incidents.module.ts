import { Module } from '@nestjs/common';
import { OrganizationModule } from '../organization/organization.module.js';
import {
  IncidentCategoriesController,
  IncidentsController,
} from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';

/** Reporting an incident, triaging it, and following it to its close. */
@Module({
  imports: [OrganizationModule],
  controllers: [IncidentCategoriesController, IncidentsController],
  providers: [IncidentsService],
})
export class IncidentsModule {}
