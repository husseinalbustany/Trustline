import { randomBytes } from 'node:crypto';

/** How the API delivers email: through SMTP, or into the outbox. */
export type MailMode = 'smtp' | 'outbox';

export type SmtpTls = 'starttls' | 'implicit' | 'none';

export type SmtpSettings = {
  host: string;
  port: number;
  tls: SmtpTls;
  /** Both or neither. */
  auth: { user: string; pass: string } | null;
};

export type MailConfig = {
  mode: MailMode;
  /** Set in SMTP mode only. */
  smtp: SmtpSettings | null;
  from: { address: string; name: string };
  /** Where the links in an email lead: the web app, no trailing slash. */
  webBaseUrl: string;
  /** Signs unsubscribe links. */
  linkSecret: string;
  /**
   * What is wrong with the configuration, by variable name. Never a value:
   * this is logged. In SMTP mode, anything here turns it into outbox mode.
   */
  problems: string[];
  /** Notes for the log, e.g. that the link secret is a random one. */
  notes: string[];
};

const MIN_SECRET_LENGTH = 32;
const DEFAULT_WEB_BASE_URL = 'http://localhost:3000';
const DEFAULT_FROM_ADDRESS = 'trustline@localhost';
const DEFAULT_FROM_NAME = 'Trustline';

// An address of the plain form name@domain.tld, one line. Not every address
// RFC 5322 allows, which is the point: this goes into a header.
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
// A display name: one line, no control characters, no angle brackets.
// eslint-disable-next-line no-control-regex
const DISPLAY_NAME = /^[^\u0000-\u001f\u007f<>"]{1,100}$/;

export const isLoopbackHost = (host: string) =>
  host === 'localhost' ||
  host === '::1' ||
  host === '[::1]' ||
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/** The web address, as a base with no trailing slash, or null if unusable. */
function webBase(value: string): { base: string; host: string; https: boolean } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  const base = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  return { base, host: url.hostname, https: url.protocol === 'https:' };
}

/**
 * Reads the mail configuration from the environment
 * (docs/specs/email.md, section 5). Never throws: email must never stop the
 * API from serving. A configuration that cannot be used in SMTP mode falls
 * back to the outbox, and `problems` names each variable at fault.
 */
export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const get = (name: string) => env[name]?.trim() ?? '';
  const problems: string[] = [];
  const notes: string[] = [];

  const forced = get('MAIL_TRANSPORT');
  if (forced && forced !== 'outbox' && forced !== 'smtp') {
    problems.push('MAIL_TRANSPORT must be "smtp" or "outbox"');
  }
  const host = get('SMTP_HOST');
  const wantsSmtp = forced === 'outbox' ? false : host !== '';
  if (forced === 'smtp' && !host) problems.push('SMTP_HOST is not set');

  // The sender.
  const fromAddress = get('MAIL_FROM_ADDRESS');
  const fromName = get('MAIL_FROM_NAME') || DEFAULT_FROM_NAME;
  if (wantsSmtp && !fromAddress) problems.push('MAIL_FROM_ADDRESS is not set');
  if (fromAddress && !ADDRESS.test(fromAddress)) {
    problems.push('MAIL_FROM_ADDRESS is not an email address');
  }
  if (!DISPLAY_NAME.test(fromName)) {
    problems.push('MAIL_FROM_NAME must be one line of at most 100 characters, without < > or "');
  }

  // Where the links lead.
  const webSet = get('WEB_BASE_URL');
  const web = webBase(webSet || DEFAULT_WEB_BASE_URL);
  if (wantsSmtp && !webSet) problems.push('WEB_BASE_URL is not set');
  if (webSet && !web) {
    problems.push('WEB_BASE_URL must be an http or https address with no query');
  }
  if (wantsSmtp && web && !web.https && !isLoopbackHost(web.host)) {
    problems.push('WEB_BASE_URL must use https');
  }

  // What signs the unsubscribe links.
  let linkSecret = get('EMAIL_LINK_SECRET');
  if (linkSecret && linkSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`EMAIL_LINK_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
    linkSecret = '';
  }
  if (!linkSecret) {
    if (wantsSmtp) problems.push('EMAIL_LINK_SECRET is not set');
    linkSecret = randomBytes(32).toString('base64url');
    notes.push(
      'EMAIL_LINK_SECRET is not set: unsubscribe links are signed with a key of this process only and stop working when it ends',
    );
  }

  // The SMTP server.
  let smtp: SmtpSettings | null = null;
  if (wantsSmtp) {
    const tlsSet = get('SMTP_TLS') || 'starttls';
    const tls = (['starttls', 'implicit', 'none'] as const).find((t) => t === tlsSet);
    if (!tls) problems.push('SMTP_TLS must be "starttls", "implicit" or "none"');
    const portSet = get('SMTP_PORT');
    const port = portSet ? Number(portSet) : tls === 'implicit' ? 465 : 587;
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      problems.push('SMTP_PORT must be a port number');
    }
    if (tls === 'none' && !isLoopbackHost(host)) {
      problems.push('SMTP_TLS=none is allowed only for a server on this machine');
    }
    const user = get('SMTP_USER');
    const pass = env.SMTP_PASSWORD ?? '';
    if (!!user !== !!pass) {
      problems.push('SMTP_USER and SMTP_PASSWORD must be set together');
    }
    smtp = {
      host,
      port,
      tls: tls ?? 'starttls',
      auth: user && pass ? { user, pass } : null,
    };
  }

  const mode: MailMode = wantsSmtp && problems.length === 0 ? 'smtp' : 'outbox';
  return {
    mode,
    smtp: mode === 'smtp' ? smtp : null,
    from: {
      address: fromAddress && ADDRESS.test(fromAddress) ? fromAddress : DEFAULT_FROM_ADDRESS,
      name: DISPLAY_NAME.test(fromName) ? fromName : DEFAULT_FROM_NAME,
    },
    webBaseUrl: web?.base ?? DEFAULT_WEB_BASE_URL,
    linkSecret,
    problems,
    notes,
  };
}

/**
 * What the API says about mail when it starts: how it sends, or why it does
 * not. Names variables and the server, never a credential or a secret.
 */
export function describeMail(config: MailConfig): { level: 'log' | 'warn' | 'error'; message: string }[] {
  const lines: { level: 'log' | 'warn' | 'error'; message: string }[] = [];
  for (const problem of config.problems) {
    lines.push({ level: 'error', message: `Mail configuration: ${problem}.` });
  }
  if (config.mode === 'smtp' && config.smtp) {
    lines.push({
      level: 'log',
      message: `Mail is sent through ${config.smtp.host}:${config.smtp.port} (TLS: ${config.smtp.tls}${config.smtp.auth ? ', with credentials' : ''}).`,
    });
  } else {
    lines.push({
      level: 'warn',
      message:
        config.problems.length > 0
          ? 'Mail is not configured correctly: emails are kept in the outbox (email_outbox) and not sent.'
          : 'Mail is not configured: emails are kept in the outbox (email_outbox) and not sent.',
    });
  }
  for (const note of config.notes) lines.push({ level: 'warn', message: `${note}.` });
  return lines;
}
