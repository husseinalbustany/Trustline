import { forwardRef, Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AiDraftController, DesignController } from '../drafting/drafting.controller.js';
import { DraftingModule } from '../drafting/drafting.module.js';
import { OrganizationModule } from '../organization/organization.module.js';
import { DocumentNotifier } from './document-notifier.js';
import { DocumentsService } from './documents.service.js';
import { ImportsService } from './imports.service.js';
import { LibraryService } from './library.service.js';
import { LinkedDocuments } from './linked-documents.js';
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
  imports: [ApprovalsModule, OrganizationModule, forwardRef(() => DraftingModule)],
  controllers: [PoliciesController, PolicySettingsController, DesignController, AiDraftController],
  providers: [
    DocumentNotifier,
    DocumentsService,
    ImportsService,
    LibraryService,
    LinkedDocuments,
    PolicyCheck,
    PolicySettingsService,
    Publisher,
  ],
  // For the email digest: what waits for a person, as their screens show
  // it; for other modules, what they may show of a document they link to.
  exports: [LibraryService, DocumentsService, LinkedDocuments],
})
export class PoliciesModule {}
