import { Module } from '@nestjs/common';
import { AuditController, AuditKeysController } from './audit.controller.js';
import { AuditKeys } from './audit-keys.js';
import { AuditChainCheck } from './chain-check.service.js';

/**
 * The audit trail (docs/specs/audit-trail.md): its seal's state, the daily
 * check of each client's chain, and Trustline's keys for its checkpoints.
 * The chain itself is written by the database (migration 0058).
 */
@Module({
  controllers: [AuditController, AuditKeysController],
  providers: [AuditKeys, AuditChainCheck],
  exports: [AuditChainCheck],
})
export class AuditModule {}
