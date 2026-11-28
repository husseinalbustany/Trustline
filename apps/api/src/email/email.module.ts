import { Module } from '@nestjs/common';
import { IncidentsModule } from '../incidents/incidents.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { DigestService } from './digest.service.js';
import { EmailWorker } from './email-worker.service.js';

/**
 * Sending email: the worker that sends the queue, and the daily digest,
 * made from what the incidents and policies modules show each person.
 */
@Module({
  imports: [IncidentsModule, PoliciesModule],
  providers: [DigestService, EmailWorker],
})
export class EmailModule {}
