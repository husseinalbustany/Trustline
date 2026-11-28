import { describeMail, mailConfig } from './config.js';

const SECRET = 'a-secret-of-at-least-thirty-two-characters!';
const PASSWORD = 'pa55word-never-logged';

const smtpEnv = (extra: Record<string, string> = {}) => ({
  SMTP_HOST: 'smtp.mail.example',
  SMTP_USER: 'mailer',
  SMTP_PASSWORD: PASSWORD,
  MAIL_FROM_ADDRESS: 'no-reply@trustline.example',
  MAIL_FROM_NAME: 'Trustline',
  WEB_BASE_URL: 'https://trustline.example/',
  EMAIL_LINK_SECRET: SECRET,
  ...extra,
});

/** Everything a configuration would put into the log. */
const logged = (env: Record<string, string>) => {
  const config = mailConfig(env);
  return [
    ...config.problems,
    ...config.notes,
    ...describeMail(config).map((l) => l.message),
  ].join('\n');
};

describe('mail configuration', () => {
  it('keeps mail in the outbox when nothing is configured, and says so', () => {
    const config = mailConfig({});
    expect(config.mode).toBe('outbox');
    expect(config.smtp).toBeNull();
    expect(config.problems).toEqual([]);
    expect(config.webBaseUrl).toBe('http://localhost:3000');
    expect(config.linkSecret.length).toBeGreaterThanOrEqual(32);
    const lines = describeMail(config);
    expect(lines.some((l) => /Mail is not configured/.test(l.message))).toBe(true);
    expect(lines.some((l) => /EMAIL_LINK_SECRET is not set/.test(l.message))).toBe(true);
  });

  it('sends through SMTP when it is configured, with STARTTLS required by default', () => {
    const config = mailConfig(smtpEnv());
    expect(config.problems).toEqual([]);
    expect(config.mode).toBe('smtp');
    expect(config.smtp).toEqual({
      host: 'smtp.mail.example',
      port: 587,
      tls: 'starttls',
      auth: { user: 'mailer', pass: PASSWORD },
    });
    expect(config.webBaseUrl).toBe('https://trustline.example');
    expect(config.from).toEqual({
      address: 'no-reply@trustline.example',
      name: 'Trustline',
    });
    expect(config.linkSecret).toBe(SECRET);
  });

  it('takes TLS from the first byte on 465 unless told another port', () => {
    expect(mailConfig(smtpEnv({ SMTP_TLS: 'implicit' })).smtp?.port).toBe(465);
    expect(
      mailConfig(smtpEnv({ SMTP_TLS: 'implicit', SMTP_PORT: '2465' })).smtp
        ?.port,
    ).toBe(2465);
  });

  it('is forced to the outbox by MAIL_TRANSPORT=outbox, whatever else is set', () => {
    const config = mailConfig(smtpEnv({ MAIL_TRANSPORT: 'outbox' }));
    expect(config.mode).toBe('outbox');
    expect(config.smtp).toBeNull();
    expect(config.problems).toEqual([]);
  });

  it.each([
    [{ MAIL_FROM_ADDRESS: '' }, 'MAIL_FROM_ADDRESS is not set'],
    [{ MAIL_FROM_ADDRESS: 'not an address' }, 'MAIL_FROM_ADDRESS is not an email address'],
    [{ MAIL_FROM_NAME: 'Trust\nline' }, 'MAIL_FROM_NAME must be one line'],
    [{ WEB_BASE_URL: '' }, 'WEB_BASE_URL is not set'],
    [{ WEB_BASE_URL: 'http://trustline.example' }, 'WEB_BASE_URL must use https'],
    [{ WEB_BASE_URL: 'https://trustline.example/?a=1' }, 'WEB_BASE_URL must be an http or https address'],
    [{ EMAIL_LINK_SECRET: '' }, 'EMAIL_LINK_SECRET is not set'],
    [{ EMAIL_LINK_SECRET: 'short' }, 'EMAIL_LINK_SECRET must be at least 32 characters'],
    [{ SMTP_TLS: 'maybe' }, 'SMTP_TLS must be'],
    [{ SMTP_TLS: 'none' }, 'SMTP_TLS=none is allowed only for a server on this machine'],
    [{ SMTP_PORT: '70000' }, 'SMTP_PORT must be a port number'],
    [{ SMTP_PASSWORD: '' }, 'SMTP_USER and SMTP_PASSWORD must be set together'],
    [{ MAIL_TRANSPORT: 'pigeon' }, 'MAIL_TRANSPORT must be'],
  ])(
    'falls back to the outbox, naming what is wrong: %j',
    (change, problem) => {
      const config = mailConfig(smtpEnv(change));
      expect(config.mode).toBe('outbox');
      expect(config.smtp).toBeNull();
      expect(config.problems.join('\n')).toContain(problem);
      expect(
        describeMail(config).some((l) => l.level === 'error' && l.message.includes(problem)),
      ).toBe(true);
    },
  );

  it('allows a server without TLS and a web address without https on this machine only', () => {
    const config = mailConfig(
      smtpEnv({
        SMTP_HOST: '127.0.0.1',
        SMTP_TLS: 'none',
        WEB_BASE_URL: 'http://localhost:3000',
      }),
    );
    expect(config.problems).toEqual([]);
    expect(config.mode).toBe('smtp');
  });

  it('never logs a password, a user name or a secret, whatever is wrong', () => {
    for (const env of [
      smtpEnv(),
      smtpEnv({ SMTP_TLS: 'none' }),
      smtpEnv({ EMAIL_LINK_SECRET: 'short-secret-value' }),
      smtpEnv({ SMTP_USER: '' }),
      {},
    ]) {
      const text = logged(env);
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('short-secret-value');
      expect(text).not.toContain('mailer');
    }
  });
});
