import { Module } from '@nestjs/common';
import { ApprovalEngine } from './approval-engine.service.js';
import { SignatureService } from './signatures.js';

/**
 * The approval engine and electronic signatures, for any subject that is
 * reviewed and approved: document versions today, investigations later. No
 * routes of its own: each subject's module serves them, under its own
 * module and permissions, and calls the engine.
 */
@Module({
  providers: [ApprovalEngine, SignatureService],
  exports: [ApprovalEngine, SignatureService],
})
export class ApprovalsModule {}
