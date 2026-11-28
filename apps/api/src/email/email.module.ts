import { Module } from '@nestjs/common';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { BackgroundContext } from './background-context.js';
import { DigestService } from './digest.service.js';
import { EmailWorker } from './email-worker.service.js';

/**
 * Sending email: the worker that sends the queue, and the daily digest,
 * made from what the incidents and policies modules show each person.
 */
@Module({
  imports: [IncidentsModule, PoliciesModule],
  // BackgroundContext is this module's alone: exported to nothing.
  providers: [BackgroundContext, DigestService, EmailWorker],
})
export class EmailModule {}
