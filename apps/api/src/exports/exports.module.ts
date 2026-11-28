import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ArchiveBuilder } from './archive.js';
import { ContractNotices } from './contract-notices.check.js';
import { ExportWorker } from './export-worker.service.js';
import { ExportsController } from './exports.controller.js';
import { ExportsService } from './exports.service.js';
import { ExportStorage } from './storage.js';

/** Full data export (docs/specs/data-export.md): core. */
@Module({
  imports: [AuditModule],
  controllers: [ExportsController],
  providers: [ArchiveBuilder, ContractNotices, ExportWorker, ExportsService, ExportStorage],
  exports: [ContractNotices, ExportWorker, ExportStorage],
})
export class ExportsModule {}
