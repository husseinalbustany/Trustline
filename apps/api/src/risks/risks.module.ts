import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { RiskApprovalsService } from './approvals.service.js';
import { RiskEscalation } from './escalation.js';
import { RiskLinksService } from './links.service.js';
import { RiskCheck } from './risk-check.service.js';
import { RiskNotifier } from './risk-notifier.js';
import { RiskRegisterService } from './register.service.js';
import {
  RiskSettingsController,
  RisksController,
  RiskWorkController,
} from './risks.controller.js';
import { RiskSettingsService } from './settings.service.js';
import { RiskWorkService } from './work.service.js';

/**
 * Risk management (docs/specs/risk-management.md), steps 1 to 7: the
 * settings, the register, reviews and the risk check, actions on risks
 * through the shared engine (docs/specs/actions.md), escalation and
 * committees, acceptance and closure through the approval engine, and
 * links. All of it is the `risks` module. It shows documents and incidents
 * it links to through those modules' `LinkedDocuments` and
 * `LinkedIncidents`, only while the client has them.
 */
@Module({
  imports: [PoliciesModule, IncidentsModule, ApprovalsModule, ActionsModule],
  // The settings and the work first: their paths must not be read as a
  // risk's id.
  controllers: [RiskSettingsController, RiskWorkController, RisksController],
  providers: [
    RiskApprovalsService,
    RiskEscalation,
    RiskLinksService,
    RiskNotifier,
    RiskRegisterService,
    RiskSettingsService,
    RiskWorkService,
    RiskCheck,
  ],
  // For the email digest: what waits for a person, as their screens show it.
  exports: [RiskWorkService, RiskCheck],
})
export class RisksModule {}
