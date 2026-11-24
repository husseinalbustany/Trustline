import { Module } from '@nestjs/common';
import {
  IncidentCategoriesController,
  IncidentsController,
} from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';

/** Reporting an incident, triaging it, and following it to its close. */
@Module({
  controllers: [IncidentCategoriesController, IncidentsController],
  providers: [IncidentsService],
})
export class IncidentsModule {}
