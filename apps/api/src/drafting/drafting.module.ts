import { forwardRef, Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { DesignService } from './design.service.js';
import { DraftingController, ProfileController } from './drafting.controller.js';
import { DraftingService } from './drafting.service.js';
import { ProfileService } from './profile.service.js';

/**
 * AI drafting of policies and procedures (docs/specs/ai-policy-drafting.md):
 * the client profile, the document design, and the drafting conversation,
 * on the AI foundation (ai/) and handing over to the policies module.
 */
@Module({
  // Each needs the other: drafting hands over to the policies module's
  // documents, and the policies module serves the design and what an AI
  // draft carries (DesignController, AiDraftController).
  imports: [ApprovalsModule, forwardRef(() => PoliciesModule)],
  controllers: [ProfileController, DraftingController],
  providers: [ProfileService, DesignService, DraftingService],
  exports: [DesignService, DraftingService],
})
export class DraftingModule {}
