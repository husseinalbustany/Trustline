import { createTransport } from 'nodemailer';
import { TenantDb } from '../database/tenant-db.service.js';
import { emailOutbox } from '../database/schema.js';
import type { MailConfig, MailMode } from './config.js';

/** One email, ready to go: rendered, addressed, with its headers. */
export type OutgoingMail = {
  tenantId: string;
  /** The queue row it is sent for. */
  queueId: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The same on every attempt of this message. */
  messageId: string;
  headers: Record<string, string>;
};

/**
 * Where email goes. One interface, chosen by configuration
 * (docs/specs/email.md, section 5): SMTP, or the outbox when no mail service
 * is configured. Another mail service (an HTTP API) is another
 * implementation of this.
 *
 * `send` resolves once the message is handed over (or kept), and throws a
 * `MailFailure` saying whether to try again otherwise.
 */
export interface MailSender {
  readonly mode: MailMode;
  send(mail: OutgoingMail): Promise<void>;
  close(): Promise<void>;
}

export const MAIL_SENDER = Symbol('MAIL_SENDER');
export const MAIL_CONFIG = Symbol('MAIL_CONFIG');

/**
 * A message not handed over. `retry`: nothing says it was refused for good
 * (no answer, a temporary refusal); `permanent`: the server refused it and
 * would again. `code` is the error's code or the server's reply code, never
 * its text, which can hold an address.
 */
export class MailFailure extends Error {
  constructor(
    readonly outcome: 'retry' | 'permanent',
    readonly code: string,
  ) {
    super(`Mail not sent (${code})`);
    this.name = 'MailFailure';
  }
}

const CODE = /^[A-Za-z0-9_]{1,40}$/;

/** How an error from the SMTP client is taken: see MailFailure. */
export function classifySmtpError(error: unknown): MailFailure {
  if (error instanceof MailFailure) return error;
  const e = (error ?? {}) as {
    code?: unknown;
    responseCode?: unknown;
    permanent?: unknown;
  };
  const reply = typeof e.responseCode === 'number' ? e.responseCode : null;
  const own = typeof e.code === 'string' && CODE.test(e.code) ? e.code : null;
  const code = reply !== null ? String(reply) : (own ?? 'unknown');
  // A permanent refusal: 5xx, except 503 (the session's state, not the
  // message). Anything else may go through later: a 4xx, no answer at all,
  // a connection that could not be made, credentials refused (which a
  // corrected configuration fixes).
  const permanent =
    e.permanent === true ||
    (reply !== null && reply >= 500 && reply < 600 && reply !== 503);
  return new MailFailure(permanent ? 'permanent' : 'retry', code);
}

/** Through an SMTP server, over a small pool of connections. */
export class SmtpSender implements MailSender {
  readonly mode = 'smtp' as const;
  private readonly transport;

  constructor(private readonly config: MailConfig) {
    const smtp = config.smtp!;
    this.transport = createTransport({
      pool: true,
      maxConnections: 2,
      host: smtp.host,
      port: smtp.port,
      secure: smtp.tls === 'implicit',
      requireTLS: smtp.tls === 'starttls',
      ignoreTLS: smtp.tls === 'none',
      ...(smtp.auth && { auth: { user: smtp.auth.user, pass: smtp.auth.pass } }),
      // Certificates are always checked; nothing older than TLS 1.2.
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      // Short enough that no send outlasts a claim (see EmailWorker).
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      // Nothing about a message or a credential goes to any log.
      logger: false,
      debug: false,
      // The message is built here, from text only: nodemailer reads no file
      // and fetches no address for it.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(mail: OutgoingMail) {
    try {
      await this.transport.sendMail({
        from: { name: this.config.from.name, address: this.config.from.address },
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        messageId: mail.messageId,
        headers: mail.headers,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch (error) {
      throw classifySmtpError(error);
    }
  }

  close() {
    this.transport.close();
    return Promise.resolve();
  }
}

/**
 * Keeps each email in `email_outbox`, fully rendered, and sends nothing:
 * what the API does until a mail service is configured. Keeping one twice
 * keeps it once.
 */
export class OutboxSender implements MailSender {
  readonly mode = 'outbox' as const;

  constructor(private readonly tenantDb: TenantDb) {}

  async send(mail: OutgoingMail) {
    await this.tenantDb.withTenant(mail.tenantId, async (tx) => {
      await tx
        .insert(emailOutbox)
        .values({
          tenantId: mail.tenantId,
          queueId: mail.queueId,
          toAddress: mail.to,
          subject: mail.subject,
          textBody: mail.text,
          htmlBody: mail.html,
          headers: { 'Message-ID': mail.messageId, ...mail.headers },
        })
        .onConflictDoNothing();
    });
  }

  close() {
    return Promise.resolve();
  }
}
