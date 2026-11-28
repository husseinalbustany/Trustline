import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { DeadlineCheck } from './deadline-check.service.js';
import {
  IncidentCategoriesController,
  IncidentsController,
} from './incidents.controller.js';
import { IncidentsService } from './incidents.service.js';
import { LinkedIncidents } from './linked-incidents.js';
import { NotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';
import { Notifier } from './notifier.js';
import { PublicLimits } from './public-limits.js';
import { PublicReportingController } from './public.controller.js';
import { ResponseRulesService } from './response-rules.service.js';
import { IncidentSettingsController } from './settings.controller.js';

/**
 * Reporting an incident, triaging it, and following it to its close; its
 * deadlines, and the notifications about all of it.
 */
@Module({
  // The approval engine, for whether a notification's document can be
  // opened by its reader.
  imports: [ApprovalsModule, OrganizationModule],
  controllers: [
    IncidentCategoriesController,
    IncidentsController,
    IncidentSettingsController,
    NotificationsController,
    PublicReportingController,
  ],
  providers: [
    DeadlineCheck,
    IncidentsService,
    LinkedIncidents,
    NotificationsService,
    Notifier,
    PublicLimits,
    ResponseRulesService,
  ],
  // For the email digest: what is assigned to a person, as their screens
  // show it.
  // For other modules: what they may show of an incident they link to.
  exports: [IncidentsService, LinkedIncidents],
})
export class IncidentsModule {}
