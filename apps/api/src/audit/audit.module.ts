import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ReviewerReads } from './reviewer-reads.interceptor.js';
import { AuditController, AuditKeysController } from './audit.controller.js';
import { AuditKeys } from './audit-keys.js';
import { ExportKeys } from '../exports/export-keys.js';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AuditChainCheck } from './chain-check.service.js';
import { TrailService } from './trail.service.js';

/**
 * The audit trail (docs/specs/audit-trail.md): its seal's state, the daily
 * check of each client's chain, and Trustline's keys for its checkpoints.
 * The chain itself is written by the database (migration 0058).
 */
@Module({
  imports: [ApprovalsModule],
  controllers: [AuditController, AuditKeysController],
  providers: [
    AuditKeys,
    // The export manifests' keys, published beside the audit keys.
    ExportKeys,
    AuditChainCheck,
    TrailService,
    // Every read of an external reviewer is recorded, whichever module serves it.
    { provide: APP_INTERCEPTOR, useClass: ReviewerReads },
  ],
  exports: [AuditChainCheck, AuditKeys, ExportKeys, TrailService],
})
export class AuditModule {}
