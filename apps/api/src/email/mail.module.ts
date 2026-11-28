import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { TenantDb } from '../database/tenant-db.service.js';
import { mailConfig, type MailConfig } from './config.js';
import {
  EmailSettingsController,
  NotificationPreferencesController,
  UnsubscribeController,
} from './email.controller.js';
import { EmailPreferencesService } from './email-preferences.service.js';
import { MailQueue } from './mail-queue.service.js';
import {
  MAIL_CONFIG,
  MAIL_SENDER,
  OutboxSender,
  SmtpSender,
  type MailSender,
} from './sender.js';

/**
 * Email (docs/specs/email.md): its configuration, the sender it chooses,
 * the queue every notifier writes to, and who wants what. Global, because
 * the notifiers of every module queue their emails here; it depends on no
 * module of the product, so none depends on it in a circle. Sending, and
 * the digest, are EmailModule's.
 */
@Global()
@Module({
  controllers: [
    NotificationPreferencesController,
    EmailSettingsController,
    UnsubscribeController,
  ],
  providers: [
    // Read once, when the application is built: a change takes a restart.
    { provide: MAIL_CONFIG, useFactory: () => mailConfig() },
    {
      provide: MAIL_SENDER,
      useFactory: (config: MailConfig, tenantDb: TenantDb): MailSender =>
        config.mode === 'smtp'
          ? new SmtpSender(config)
          : new OutboxSender(tenantDb),
      inject: [MAIL_CONFIG, TenantDb],
    },
    MailQueue,
    EmailPreferencesService,
  ],
  exports: [MAIL_CONFIG, MAIL_SENDER, MailQueue, EmailPreferencesService],
})
export class MailModule implements OnModuleDestroy {
  constructor(@Inject(MAIL_SENDER) private readonly sender: MailSender) {}

  async onModuleDestroy() {
    await this.sender.close();
  }
}
