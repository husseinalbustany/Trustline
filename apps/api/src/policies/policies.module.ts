import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { DocumentNotifier } from './document-notifier.js';
import { DocumentsService } from './documents.service.js';
import { LibraryService } from './library.service.js';
import {
  PoliciesController,
  PolicySettingsController,
} from './policies.controller.js';
import { PolicyCheck } from './policy-check.service.js';
import { Publisher } from './publisher.js';
import { PolicySettingsService } from './settings.service.js';

/**
 * Policies and procedures (docs/specs/policies-and-procedures.md): the
 * library of controlled documents, their versions, approval through the
 * approval engine with signatures, publishing, acknowledgement, periodic
 * review and the daily check. All of it is the `policies` module.
 */
@Module({
  imports: [ApprovalsModule, OrganizationModule],
  controllers: [PoliciesController, PolicySettingsController],
  providers: [
    DocumentNotifier,
    DocumentsService,
    LibraryService,
    PolicyCheck,
    PolicySettingsService,
    Publisher,
  ],
})
export class PoliciesModule {}
