import './env.js';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { API_PREFIX, listen, setupApp } from './app.setup.js';
import { AuditKeys, SIGNING_KEY_VARIABLE } from './audit/audit-keys.js';
import { AuditChainCheck } from './audit/chain-check.service.js';
import { EmailWorker } from './email/email-worker.service.js';
import { DeadlineCheck } from './incidents/deadline-check.service.js';
import { PolicyCheck } from './policies/policy-check.service.js';
import { MeasureSnapshotCheck } from './reports/measure-snapshot.check.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // In production, the audit trail's checkpoints are signed or the API
  // does not start (security review 12, L5): the variable's name, never a
  // value.
  if (process.env.NODE_ENV === 'production' && !app.get(AuditKeys, { strict: false }).signer) {
    throw new Error(`${SIGNING_KEY_VARIABLE} must hold a valid Ed25519 private key in production`);
  }
  // The prefix, so that what is matched by path is matched whole.
  setupApp(app, { prefix: `/${API_PREFIX}` });
  // Versioned so web and mobile clients on an older release keep working.
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  // On this machine only, unless API_HOST says otherwise; and said in the
  // log, with how far the forwarding header is trusted: see app.setup.ts.
  await listen(app);
  // The check behind the "due soon" and "overdue" notifications, every five
  // minutes. Started here and nowhere else, so nothing that merely builds
  // the application (a test, a script) runs it. Safe in every API process
  // at once; it stops with the application.
  app.get(DeadlineCheck, { strict: false }).start();
  // The daily check of the policies module (scheduled publishing, review
  // and acknowledgement reminders), every fifteen minutes, with the same
  // safety for several processes.
  app.get(PolicyCheck, { strict: false }).start();
  // Email (docs/specs/email.md): sends the queue every 30 seconds, and
  // queues each organization's daily digest. Says once how mail is sent, or
  // that it is not configured and kept in the outbox. Safe in every process.
  app.get(EmailWorker, { strict: false }).start();
  // The daily check of each client's audit chain, from 02:00 on its clock
  // (docs/specs/audit-trail.md), every fifteen minutes, safe in every
  // process. Says once if checkpoints cannot be signed, naming the
  // variable, never its value.
  app.get(AuditChainCheck, { strict: false }).start();
  // The month-end snapshots of the measures, from midnight on the first of
  // each month on the client's clock (docs/specs/reports-and-measures.md),
  // every fifteen minutes, safe in every process.
  app.get(MeasureSnapshotCheck, { strict: false }).start();
}
await bootstrap();
