import { once } from 'node:events';
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { mailConfig } from './config.js';
import { classifySmtpError, MailFailure, SmtpSender, type OutgoingMail } from './sender.js';

/**
 * An SMTP server of the test's own, on this machine, that answers RCPT TO
 * (and MAIL FROM, and a login when it offers one) as told and keeps what it
 * is sent. No mail leaves the machine.
 */
async function fakeSmtp(
  rcptReply = '250 OK',
  { mailReply = '250 OK', authReply }: { mailReply?: string; authReply?: string } = {},
) {
  const received: { envelope: string[]; data: string }[] = [];
  const server: Server = createServer((socket: Socket) => {
    let buffer = '';
    let inData = false;
    let envelope: string[] = [];
    let data = '';
    socket.write('220 localhost ESMTP test\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push({ envelope, data });
          envelope = [];
          data = '';
          socket.write('250 queued\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') {
          socket.write(authReply ? '250-localhost\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n' : '250-localhost\r\n250 8BITMIME\r\n');
        } else if (verb === 'AUTH') socket.write(`${authReply ?? '503 no auth'}\r\n`);
        else if (verb === 'MAIL') {
          envelope.push(line);
          socket.write(`${mailReply}\r\n`);
        } else if (verb === 'RCPT') {
          envelope.push(line);
          socket.write(`${rcptReply}\r\n`);
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 bye\r\n');
          return;
        } else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: (server.address() as AddressInfo).port, received };
}

const senderFor = (port: number, credentials: Record<string, string> = {}) =>
  new SmtpSender(
    mailConfig({
      ...credentials,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: String(port),
      SMTP_TLS: 'none',
      MAIL_FROM_ADDRESS: 'no-reply@trustline.example',
      MAIL_FROM_NAME: 'Trustline',
      WEB_BASE_URL: 'http://localhost:3000',
      EMAIL_LINK_SECRET: 'a-secret-of-at-least-thirty-two-characters!',
    }),
  );

const mail: OutgoingMail = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  queueId: '00000000-0000-4000-8000-000000000002',
  to: 'person@hospital.example',
  subject: 'أُسندت إليك الحادثة INC-2026-00042',
  text: 'نص الرسالة',
  html: '<p dir="rtl">نص الرسالة</p>',
  messageId: '<00000000-0000-4000-8000-000000000002@trustline.example>',
  headers: {
    'List-Unsubscribe': '<http://localhost:3000/api/v1/email/unsubscribe/v1.a.b>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    'Auto-Submitted': 'auto-generated',
  },
};

describe('the SMTP sender', () => {
  it('hands a message over with its headers, its Message-ID and both bodies', async () => {
    const smtp = await fakeSmtp();
    const sender = senderFor(smtp.port);
    try {
      await sender.send(mail);
      expect(smtp.received).toHaveLength(1);
      const [{ envelope, data }] = smtp.received;
      expect(envelope).toEqual([
        expect.stringContaining('<no-reply@trustline.example>'),
        expect.stringContaining('<person@hospital.example>'),
      ]);
      expect(data).toMatch(/^Message-ID: <00000000-0000-4000-8000-000000000002@trustline\.example>$/m);
      expect(data).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
      expect(data).toMatch(/^Auto-Submitted: auto-generated$/m);
      expect(data).toMatch(/^From: Trustline <no-reply@trustline\.example>$/m);
      // The Arabic subject, encoded as headers must be.
      expect(data).toMatch(/^Subject: =\?UTF-8\?/m);
      expect(data).toContain('multipart/alternative');
      expect(data).toContain('text/plain');
      expect(data).toContain('text/html');
    } finally {
      await sender.close();
      smtp.server.close();
    }
  });

  it('says to try again when the server refuses for now, and not when it refuses for good', async () => {
    for (const [reply, outcome, code] of [
      ['451 try later', 'retry', '451'],
      ['550 no such mailbox', 'permanent', '550'],
    ] as const) {
      const smtp = await fakeSmtp(reply);
      const sender = senderFor(smtp.port);
      try {
        const error = await sender.send(mail).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(MailFailure);
        expect(error).toMatchObject({ outcome, code });
        // Nothing of the message, the address or the server's words.
        expect((error as Error).message).toBe(`Mail not sent (${code})`);
      } finally {
        await sender.close();
        smtp.server.close();
      }
    }
  });

  it('says to try again, and to stop sending, when the server refuses the login', async () => {
    const smtp = await fakeSmtp('250 OK', { authReply: '535 5.7.8 Authentication credentials invalid' });
    const sender = senderFor(smtp.port, { SMTP_USER: 'trustline', SMTP_PASSWORD: 'not-the-password' });
    try {
      const error = await sender.send(mail).catch((e: unknown) => e);
      expect(error).toMatchObject({ outcome: 'retry', code: 'EAUTH', stopsSending: true });
      expect(smtp.received).toEqual([]);
    } finally {
      await sender.close();
      smtp.server.close();
    }
  });

  it('says to try again when the server refuses the sender, which is not this message’s doing', async () => {
    const smtp = await fakeSmtp('250 OK', { mailReply: '553 5.7.1 Sender address rejected' });
    const sender = senderFor(smtp.port);
    try {
      const error = await sender.send(mail).catch((e: unknown) => e);
      expect(error).toMatchObject({ outcome: 'retry', code: '553', stopsSending: false });
    } finally {
      await sender.close();
      smtp.server.close();
    }
  });

  it('says to try again when the server cannot be reached', async () => {
    const smtp = await fakeSmtp();
    const { port } = smtp;
    smtp.server.close();
    await once(smtp.server, 'close');
    const sender = senderFor(port);
    try {
      const error = await sender.send(mail).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MailFailure);
      expect((error as MailFailure).outcome).toBe('retry');
      expect((error as MailFailure).code).toMatch(/^E[A-Z]+$/);
    } finally {
      await sender.close();
    }
  });
});

describe('classifying a failure', () => {
  it.each([
    // This message or this recipient, refused for good.
    [{ responseCode: 550, code: 'EENVELOPE', command: 'RCPT TO' }, 'permanent', '550', false],
    [{ responseCode: 554, code: 'EMESSAGE', command: 'DATA' }, 'permanent', '554', false],
    // For now.
    [{ responseCode: 421, code: 'EENVELOPE', command: 'RCPT TO' }, 'retry', '421', false],
    [{ responseCode: 451, code: 'EMESSAGE', command: 'DATA' }, 'retry', '451', false],
    // The configuration or the server, whatever the reply code and
    // nodemailer's own `permanent` say (security review 8, M1): the login
    // refused (nodemailer's own shape), no login, TLS, the protocol, the
    // connection, and the sender refused at MAIL FROM.
    [{ code: 'EAUTH', responseCode: 535, permanent: true, command: 'AUTH PLAIN' }, 'retry', 'EAUTH', true],
    [{ code: 'ENOAUTH', permanent: true }, 'retry', 'ENOAUTH', true],
    [{ code: 'EENVELOPE', responseCode: 530, permanent: true, command: 'MAIL FROM' }, 'retry', '530', false],
    [{ code: 'EENVELOPE', responseCode: 550, permanent: true, command: 'MAIL FROM' }, 'retry', '550', false],
    [{ code: 'EENVELOPE', responseCode: 553, permanent: true, command: 'MAIL FROM' }, 'retry', '553', false],
    [{ code: 'ETLS', responseCode: 554, permanent: true }, 'retry', '554', false],
    [{ code: 'EPROTOCOL', responseCode: 503 }, 'retry', '503', false],
    [{ code: 'ECONNECTION' }, 'retry', 'ECONNECTION', false],
    [{ permanent: true, responseCode: 552 }, 'retry', '552', false],
    [{ code: 'a code with spaces and an@address' }, 'retry', 'unknown', false],
    [new Error('boom'), 'retry', 'unknown', false],
    [null, 'retry', 'unknown', false],
  ])('%j', (error, outcome, code, stopsSending) => {
    expect(classifySmtpError(error)).toMatchObject({ outcome, code, stopsSending });
  });
});
