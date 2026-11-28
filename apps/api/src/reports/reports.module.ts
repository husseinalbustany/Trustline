import { Module } from '@nestjs/common';
import { MeasureSnapshotCheck } from './measure-snapshot.check.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { MeasureSnapshots } from './snapshots.service.js';

/** Reports and measures over time (docs/specs/reports-and-measures.md). */
@Module({
  controllers: [ReportsController],
  providers: [MeasureSnapshots, MeasureSnapshotCheck, ReportsService],
  exports: [MeasureSnapshotCheck],
})
export class ReportsModule {}
