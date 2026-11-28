import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { MailConfig } from '../src/email/config.js';
import {
  BACKOFF_MINUTES,
  EmailWorker,
  MAX_ATTEMPTS,
} from '../src/email/email-worker.service.js';
import { MailQueue } from '../src/email/mail-queue.service.js';
import { ProvisioningService } from '../src/identity/provisioning.service.js';
import {
  MAIL_CONFIG,
  MailFailure,
  type MailSender,
  type OutgoingMail,
} from '../src/email/sender.js';
import { signUnsubscribe } from '../src/email/unsubscribe-token.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { DocumentNotifier } from '../src/policies/document-notifier.js';
import {
  testBench,
  type Hospital,
  type Staff,
  type TestBench,
} from './support/hospital.js';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NO_LIMITS = { users: null, sites: null, storageMb: null, aiCreditsPerMonth: null };
const NO_EXTRAS = { sso: false, publicReporting: false, clinicalAiSuggestions: false };

/**
 * Email (docs/specs/email.md): what is sent at once and in the digests, to
 * whom, and what it says; the preferences and the organization's switch;
 * the unsubscribe link; modules and the subscription; and the queue: sent
 * once with several processes, tried again with backoff, never breaking
 * what caused it. Nothing here sends mail: the API is in outbox mode
 * (vitest.config.ts), and the failures of a mail server are played by
 * senders of the test's own.
 */
describe('email', () => {
  const run = randomBytes(4).toString('hex');
  let bench: TestBench;
  const http = () => bench.http();

  let a: Hospital;
  let b: Hospital; // another hospital
  let facility: string;
  let nursing: string;
  let ward: string;

  let quality: Staff; // quality officer everywhere: triages, signs off, reviews
  let arabic: Staff; // the same, reads Trustline in Arabic
  let nurse: Staff; // reports, and is assigned incidents
  let writer: Staff; // writes documents
  let authority: Staff; // gives the final approval of documents
  let leaver: Staff; // a quality officer whose account is switched off
  let bAdmin: string; // the cookie of the other hospital's administrator

  let worker: EmailWorker;
  let outbox: MailSender;
  let config: MailConfig;

  // What no email may ever hold: written into the report and its comments.
  const DESCRIPTION = `A fictional visitor, Zed Example-${run}, slipped near bed 4.`;
  const COMMENT = `Spoke to Zed Example-${run} about it.`;

  type QueueRow = {
    id: string;
    user_id: string;
    category: string;
    status: string;
    reason: string | null;
    attempts: number;
    last_error: string | null;
    kind: string | null;
  };
  const queue = async (h: Hospital = a) =>
    (
      await bench.owner.db.execute<QueueRow>(sql`
        select q.id, q.user_id, q.category, q.status, q.reason, q.attempts, q.last_error, n.kind
        from email_queue q left join notifications n on n.id = q.notification_id
        where q.tenant_id = ${h.id} order by q.created_at, q.id`)
    ).rows;

  type Kept = {
    user_id: string;
    category: string;
    kind: string | null;
    to_address: string;
    subject: string;
    text_body: string;
    html_body: string;
    headers: Record<string, string>;
  };
  const kept = async (h: Hospital = a) =>
    (
      await bench.owner.db.execute<Kept>(sql`
        select q.user_id, q.category, n.kind, o.to_address, o.subject, o.text_body, o.html_body, o.headers
        from email_outbox o
        join email_queue q on q.id = o.queue_id
        left join notifications n on n.id = q.notification_id
        where o.tenant_id = ${h.id} order by o.created_at, o.id`)
    ).rows;

  /** Forgets every email so far, so that a test reads only its own. */
  const clear = () =>
    bench.owner.db.execute(
      sql`delete from email_queue where tenant_id in (${a.id}, ${b.id})`,
    );
  const work = (now = new Date()) => worker.run(now, [a.id, b.id]);
  /** Who of these an email of this kind went to, by name. */
  const names = new Map<string, string>();
  const to = (rows: { user_id: string }[]) =>
    rows.map((r) => names.get(r.user_id) ?? r.user_id).sort();

  const report = async (who: Staff, extra: Record<string, unknown> = {}) =>
    (
      await http()
        .post('/incidents')
        .set('Cookie', who.cookie)
        .send({
          type: 'incident',
          categoryId: a.categories.equipment,
          orgUnitId: ward,
          occurredAt: new Date(Date.now() - HOUR).toISOString(),
          description: DESCRIPTION,
          harmLevel: 'none',
          anonymous: false,
          ...extra,
        })
        .expect(201)
    ).body as { id: string; reference: string };

  const triage = (who: Staff, id: string, body: Record<string, unknown>) =>
    http()
      .post(`/incidents/${id}/triage`)
      .set('Cookie', who.cookie)
      .send({ harmLevel: 'none', isSentinel: false, ownerUnitId: ward, ...body });

  const preferences = (cookie: string) =>
    http().get('/me/notification-preferences').set('Cookie', cookie);
  const setPreferences = (cookie: string, body: unknown) =>
    http()
      .patch('/me/notification-preferences')
      .set('Cookie', cookie)
      .send(body as object);
  const setSubscription = (h: Hospital, body: Record<string, unknown>) =>
    http()
      .patch(`/platform/tenants/${h.id}/subscription`)
      .set('Cookie', bench.platform)
      .send(body);

  const auditOf = async (h: Hospital, action: string) =>
    (
      await bench.owner.db.execute<{
        actor_id: string | null;
        entity_id: string;
        changes: Record<string, unknown>;
        ip_address: string | null;
      }>(
        sql`select actor_id, entity_id, changes, ip_address from audit_log where tenant_id = ${h.id} and action = ${action} order by occurred_at, id`,
      )
    ).rows;

  /** A sender that fails as told, and counts what it was asked to send. */
  const failing = (failure: () => Error) => {
    const asked: OutgoingMail[] = [];
    const sender: MailSender = {
      mode: 'outbox',
      send: (mail) => {
        asked.push(mail);
        return Promise.reject(failure());
      },
      close: () => Promise.resolve(),
    };
    return { sender, asked };
  };

  beforeAll(async () => {
    bench = await testBench('mail', run);
    a = await bench.createHospital('a', { locales: ['en', 'ar'] });
    b = await bench.createHospital('b');
    facility = await bench.createUnit(a, 'facility', 'F', null);
    nursing = await bench.createUnit(a, 'department', 'NUR', facility);
    ward = await bench.createUnit(a, 'unit', 'WARD', nursing);
    await bench.createRole(a, 'writer', ['policies.view', 'policies.manage']);
    quality = await bench.createStaff(a, 'quality', { role: 'quality_officer', orgUnitId: null });
    arabic = await bench.createStaff(a, 'arabic', { role: 'quality_officer', orgUnitId: null });
    nurse = await bench.createStaff(a, 'nurse', { role: 'reporter', orgUnitId: null });
    writer = await bench.createStaff(a, 'writer', { role: 'writer', orgUnitId: null });
    authority = await bench.createStaff(a, 'authority', { role: 'approving_authority', orgUnitId: null });
    leaver = await bench.createStaff(a, 'leaver', { role: 'quality_officer', orgUnitId: null });
    for (const s of [quality, arabic, nurse, writer, authority, leaver]) names.set(s.id, s.name);
    names.set(a.adminId, 'admin');
    bAdmin = b.cookie;

    worker = bench.app.get(EmailWorker);
    outbox = worker.sender;
    config = bench.app.get<MailConfig>(MAIL_CONFIG);
    // The digest is tested on its own, below: until then it is never due.
    worker.digestHour = 24;
  });

  afterAll(async () => {
    if (worker) worker.sender = outbox;
    await bench?.close();
  });

  it('keeps mail in the outbox in the tests, and sends none', () => {
    expect(outbox.mode).toBe('outbox');
    expect(config.mode).toBe('outbox');
    expect(worker.active).toBe(false);
  });

  describe('GET and PATCH /me/notification-preferences', () => {
    it('needs a session', async () => {
      await http().get('/me/notification-preferences').expect(401);
      await http().patch('/me/notification-preferences').send({ digest: false }).expect(401);
    });

    it('is on for both by default, in the organization’s language', async () => {
      expect((await preferences(arabic.cookie).expect(200)).body).toEqual({
        immediate: true,
        digest: true,
        language: null,
        organizationEnabled: true,
        // A quality officer decides approval steps and triages (quality
        // review 3, S3): the screen warns before they switch these off.
        reliedOn: { approves: true, triages: true },
      });
    });

    it('takes only its own strict input', async () => {
      for (const body of [
        {},
        { digest: 'no' },
        { immediate: null },
        { language: 'xx' },
        { digest: false, userId: quality.id },
        [],
      ]) {
        await setPreferences(arabic.cookie, body).expect(400);
      }
      // A language the organization does not work in.
      expect(
        (await setPreferences(arabic.cookie, { language: 'fr' }).expect(400)).body.code,
      ).toBe('language_mismatch');
    });

    it('changes the caller’s own, audited once for what changed', async () => {
      const before = (await auditOf(a, 'notification_preferences_changed')).length;
      const changed = await setPreferences(arabic.cookie, { language: 'ar' }).expect(200);
      expect(changed.body).toEqual({
        immediate: true,
        digest: true,
        language: 'ar',
        organizationEnabled: true,
        reliedOn: { approves: true, triages: true },
      });
      await setPreferences(arabic.cookie, { language: 'ar' }).expect(200);
      const entries = (await auditOf(a, 'notification_preferences_changed')).slice(before);
      expect(entries).toEqual([
        {
          actor_id: arabic.id,
          entity_id: arabic.id,
          changes: { language: { from: null, to: 'ar' }, via: 'settings' },
          ip_address: null,
        },
      ]);
      // Nobody else's changed: not a colleague's, not another hospital's.
      expect((await preferences(quality.cookie).expect(200)).body.language).toBeNull();
      expect((await preferences(bAdmin).expect(200)).body).toMatchObject({
        immediate: true,
        digest: true,
      });
    });

    it('switches each kind off and on', async () => {
      await setPreferences(nurse.cookie, { immediate: false, digest: false }).expect(200);
      expect((await preferences(nurse.cookie).expect(200)).body).toMatchObject({
        immediate: false,
        digest: false,
      });
      const [last] = (await auditOf(a, 'notification_preferences_changed')).slice(-1);
      expect(last.changes).toEqual({
        immediate: { from: true, to: false },
        digest: { from: true, to: false },
        via: 'settings',
      });
      await setPreferences(nurse.cookie, { immediate: true, digest: true }).expect(200);
    });

    it('goes back to the organization’s language with null', async () => {
      await setPreferences(quality.cookie, { language: 'ar' }).expect(200);
      const back = await setPreferences(quality.cookie, { language: null }).expect(200);
      expect(back.body.language).toBeNull();
      const [last] = (await auditOf(a, 'notification_preferences_changed')).slice(-1);
      expect(last.changes).toEqual({ language: { from: 'ar', to: null }, via: 'settings' });
    });
  });

  describe('GET and PUT /settings/email', () => {
    it('needs a session, and settings.manage for the whole organization', async () => {
      await http().get('/settings/email').expect(401);
      await http().put('/settings/email').send({ enabled: false }).expect(401);
      for (const who of [nurse, quality]) {
        const res = await http().get('/settings/email').set('Cookie', who.cookie).expect(403);
        expect(res.body).toMatchObject({ code: 'missing_permission', permission: 'settings.manage' });
        await http()
          .put('/settings/email')
          .set('Cookie', who.cookie)
          .send({ enabled: false })
          .expect(403);
      }
    });

    it('takes only { enabled }', async () => {
      for (const body of [{}, { enabled: 'no' }, { enabled: false, tenantId: b.id }]) {
        await http().put('/settings/email').set('Cookie', a.cookie).send(body).expect(400);
      }
    });

    it('is on by default, says mail is kept in the outbox, and switches for this organization only', async () => {
      expect((await http().get('/settings/email').set('Cookie', a.cookie).expect(200)).body).toEqual({
        enabled: true,
        delivery: 'outbox',
      });
      const off = await http()
        .put('/settings/email')
        .set('Cookie', a.cookie)
        .send({ enabled: false })
        .expect(200);
      expect(off.body).toEqual({ enabled: false, delivery: 'outbox' });
      expect((await preferences(quality.cookie).expect(200)).body.organizationEnabled).toBe(false);
      // The other hospital's is its own.
      expect((await http().get('/settings/email').set('Cookie', bAdmin).expect(200)).body.enabled).toBe(true);
      await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: false }).expect(200);
      await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: true }).expect(200);
      expect(await auditOf(a, 'email_setting_changed')).toEqual([
        { actor_id: a.adminId, entity_id: a.id, changes: { enabled: { from: true, to: false } }, ip_address: null },
        { actor_id: a.adminId, entity_id: a.id, changes: { enabled: { from: false, to: true } }, ip_address: null },
      ]);
      expect(await auditOf(b, 'email_setting_changed')).toEqual([]);
    });
  });

  describe('immediately', () => {
    beforeEach(clear);

    it('tells those who may triage of a serious report, saying nothing but its reference', async () => {
      const minor = await report(nurse);
      const serious = await report(nurse, { harmLevel: 'severe' });
      // Only the serious one is queued; the minor one stays in the app.
      const queued = await queue();
      expect(queued.every((r) => r.kind === 'incident_reported' && r.status === 'pending')).toBe(true);
      expect(to(queued)).toEqual(['admin', arabic.name, leaver.name, quality.name].sort());

      const done = await work();
      expect(done).toMatchObject({ kept: 4, sent: 0, failed: 0 });
      const mails = await kept();
      expect(to(mails)).toEqual(['admin', arabic.name, leaver.name, quality.name].sort());
      for (const mail of mails) {
        const all = `${mail.subject}\n${mail.text_body}\n${mail.html_body}\n${JSON.stringify(mail.headers)}`;
        expect(all).toContain(serious.reference);
        expect(all).not.toContain(minor.reference);
        // Never the description, who reported it, or anything of them.
        expect(all).not.toContain('Zed Example');
        expect(all).not.toContain(nurse.name);
        expect(all).not.toContain(nurse.email);
        expect(all).not.toMatch(/<img|<script|src=/i);
        expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
        expect(mail.headers['Auto-Submitted']).toBe('auto-generated');
        expect(mail.headers['Message-ID']).toMatch(/^<[0-9a-f-]{36}@localhost>$/);
        expect(mail.headers['List-Unsubscribe']).toMatch(
          /^<http:\/\/localhost:3000\/api\/v1\/email\/unsubscribe\/v1\.[\w-]+\.[\w-]+>$/,
        );
      }
      const english = mails.find((m) => m.user_id === quality.id)!;
      expect(english.to_address).toBe(quality.email);
      expect(english.subject).toBe(`Serious incident reported: ${serious.reference}`);
      expect(english.text_body).toContain(`Open in Trustline: http://localhost:3000/en/incidents/${serious.id}`);
      expect(english.text_body).toContain('Hospital a');
      expect(english.html_body).toContain('<html lang="en" dir="ltr">');
      // In the language the person chose, right to left.
      const inArabic = mails.find((m) => m.user_id === arabic.id)!;
      expect(inArabic.html_body).toContain('<html lang="ar" dir="rtl">');
      expect(inArabic.subject).toBe(`بلاغ عن حادث خطير: \u2066${serious.reference}\u2069`);
      expect(inArabic.text_body).toContain(`/ar/incidents/${serious.id}`);
      // Sent once: a second run finds nothing to do.
      expect(await work()).toMatchObject({ kept: 0, skipped: 0 });
      expect((await queue()).every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true);
    });

    it('tells the assignee, and those who may sign off of a sentinel event and of a request to sign it off', async () => {
      const { id, reference } = await report(nurse);
      await clear();
      await triage(quality, id, { harmLevel: 'severe', isSentinel: true, assignedTo: nurse.id }).expect(200);
      const queued = await queue();
      expect(to(queued.filter((r) => r.kind === 'incident_assigned'))).toEqual([nurse.name]);
      // Not the one who triaged it.
      expect(to(queued.filter((r) => r.kind === 'sentinel_flagged'))).toEqual(
        ['admin', arabic.name, leaver.name].sort(),
      );
      await work();
      const assigned = (await kept()).find((m) => m.kind === 'incident_assigned')!;
      expect(assigned.subject).toBe(`Incident ${reference} is assigned to you`);
      expect(assigned.text_body).toContain(`/en/incidents/${id}`);

      await clear();
      await http()
        .post(`/incidents/${id}/status`)
        .set('Cookie', quality.cookie)
        .send({ to: 'awaiting_sign_off', note: 'Root cause found.' })
        .expect(200);
      const asked = await queue();
      expect(to(asked.filter((r) => r.kind === 'sign_off_requested'))).toEqual(
        ['admin', arabic.name, leaver.name].sort(),
      );
      await work();
      expect((await kept()).map((m) => m.subject)).toContain(`Sign-off requested: incident ${reference}`);
    });

    it('does not email a comment, a status change or anything else that can wait', async () => {
      const { id } = await report(nurse, { harmLevel: 'severe' });
      await clear();
      await http()
        .post(`/incidents/${id}/comments`)
        .set('Cookie', quality.cookie)
        .send({ body: COMMENT, visibility: 'internal' })
        .expect(201);
      await triage(quality, id, { harmLevel: 'mild' }).expect(200);
      expect(await queue()).toEqual([]);
    });

    it('sends nothing to whoever switched it off, has left, or when the organization switched email off', async () => {
      await setPreferences(arabic.cookie, { immediate: false }).expect(200);
      await report(nurse, { harmLevel: 'death' });
      await http()
        .patch(`/users/${leaver.id}`)
        .set('Cookie', a.cookie)
        .send({ status: 'disabled' })
        .expect(200);
      await work();
      const outcome = Object.fromEntries(
        (await queue()).map((r) => [names.get(r.user_id), `${r.status} ${r.reason ?? ''}`.trim()]),
      );
      expect(outcome).toEqual({
        admin: 'sent',
        [quality.name]: 'sent',
        [arabic.name]: 'skipped opted_out',
        [leaver.name]: 'skipped inactive',
      });
      await setPreferences(arabic.cookie, { immediate: true }).expect(200);

      await clear();
      await report(nurse, { harmLevel: 'death' });
      await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: false }).expect(200);
      expect(await work()).toMatchObject({ skipped: 3, kept: 0 });
      expect(new Set((await queue()).map((r) => r.reason))).toEqual(new Set(['organization_off']));
      await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: true }).expect(200);
    });

    it('asks for a review of a document by its number and version, and not while the subscription is suspended', async () => {
      const typeList = (await http().get('/policies/types').set('Cookie', a.cookie).expect(200)).body as {
        id: string;
        code: string;
      }[];
      const categoryList = (await http().get('/policies/categories').set('Cookie', a.cookie).expect(200))
        .body as { id: string; code: string }[];
      const submit = async () => {
        const doc = (
          await http()
            .post('/policies/documents')
            .set('Cookie', writer.cookie)
            .send({
              typeId: typeList.find((t) => t.code === 'procedure')!.id,
              categoryId: categoryList.find((c) => c.code === 'SAF')!.id,
              title: { en: `Confidential title ${run}` },
              ownerId: writer.id,
              ownerUnitId: nursing,
            })
            .expect(201)
        ).body as { id: string; number: string; inProgress: { id: string } };
        const version = (
          await http()
            .get(`/policies/documents/${doc.id}/versions/${doc.inProgress.id}`)
            .set('Cookie', writer.cookie)
            .expect(200)
        ).body as { id: string; revision: number; version: number };
        const written = (
          await http()
            .patch(`/policies/documents/${doc.id}/versions/${version.id}`)
            .set('Cookie', writer.cookie)
            .send({
              revision: version.revision,
              content: {
                en: {
                  purpose: 'To make a spill safe.',
                  scope: 'Everyone.',
                  responsibilities: 'Whoever finds it.',
                  steps: '1. Mark the area.',
                },
              },
            })
            .expect(200)
        ).body as { revision: number };
        await http()
          .post(`/policies/documents/${doc.id}/versions/${version.id}/submit`)
          .set('Cookie', writer.cookie)
          .send({ revision: written.revision })
          .expect(200);
        return { doc, version };
      };

      const { doc, version } = await submit();
      const queued = await queue();
      // The quality officers: the route's review step is theirs (the one
      // whose account is off apart).
      expect(to(queued.filter((r) => r.kind === 'document_step_assigned'))).toEqual(
        [arabic.name, quality.name].sort(),
      );
      await work();
      const review = (await kept()).find((m) => m.user_id === quality.id)!;
      expect(review.subject).toBe(`Document ${doc.number} awaits your review`);
      expect(review.text_body).toContain(`Document ${doc.number}, version ${version.version}, awaits your review.`);
      expect(review.text_body).toContain(`/en/policies/${doc.id}/versions/${version.id}`);
      // Never its title.
      expect(`${review.subject}${review.text_body}${review.html_body}`).not.toContain('Confidential title');

      // Suspended: approvals wait, incidents do not.
      await clear();
      await submit();
      await setSubscription(a, { status: 'suspended' }).expect(200);
      try {
        const serious = await report(nurse, { harmLevel: 'severe' });
        await work();
        const rows = await queue();
        expect(
          new Set(rows.filter((r) => r.kind === 'document_step_assigned').map((r) => r.reason)),
        ).toEqual(new Set(['suspended']));
        expect(rows.filter((r) => r.kind === 'incident_reported').every((r) => r.status === 'sent')).toBe(true);
        expect((await kept()).some((m) => m.subject.includes(serious.reference))).toBe(true);
        // While suspended one's preferences can still be changed, and email
        // switched off for everyone but not on.
        await setPreferences(quality.cookie, { digest: true }).expect(200);
        await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: false }).expect(200);
        expect(
          (await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: true }).expect(403)).body,
        ).toEqual({ code: 'subscription_suspended' });
      } finally {
        await setSubscription(a, { status: 'active' }).expect(200);
        await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: true }).expect(200);
      }
    });

    it('never emails about a module that is off', async () => {
      const original = (
        await http().get(`/platform/tenants/${a.id}/subscription`).set('Cookie', bench.platform).expect(200)
      ).body.plan.id as string;
      const docsOnly = (
        await http()
          .post('/platform/plans')
          .set('Cookie', bench.platform)
          .send({
            code: `${bench.prefix}-docs`,
            name: { en: 'Documents', ar: 'الوثائق', fr: 'Documents' },
            modules: ['policies'],
            limits: NO_LIMITS,
            extras: NO_EXTRAS,
          })
          .expect(201)
      ).body.id as string;
      await report(nurse, { harmLevel: 'severe' });
      await setSubscription(a, { planId: docsOnly }).expect(200);
      try {
        await work();
        expect(new Set((await queue()).map((r) => r.reason))).toEqual(new Set(['module_off']));
        expect(await kept()).toEqual([]);
      } finally {
        await setSubscription(a, { planId: original }).expect(200);
      }
    });

    it('never fails the action that caused it: a queue that cannot be written leaves the transaction going', async () => {
      const mail = bench.app.get(MailQueue);
      const tenantDb = bench.app.get(TenantDb);
      const after = await tenantDb.withTenant(a.id, async (tx) => {
        // A notification that does not exist: the database refuses the row.
        const queued = await mail.enqueue(tx, a.id, [
          { id: randomUUID(), userId: quality.id, kind: 'incident_assigned', data: { serious: false } },
        ]);
        expect(queued).toBe(0);
        // The transaction it was called in still works, and commits.
        const { rows } = await tx.execute<{ one: number }>(sql`select 1 as one`);
        return rows[0].one;
      });
      expect(after).toBe(1);
      expect(await queue()).toEqual([]);
    });
  });

  describe('the queue', () => {
    beforeEach(async () => {
      worker.sender = outbox;
      await clear();
    });
    afterAll(() => {
      worker.sender = outbox;
    });

    it('is tried again with backoff while the server refuses for now, then given up', async () => {
      await report(nurse, { harmLevel: 'severe' });
      const count = (await queue()).length;
      const { sender, asked } = failing(() => new MailFailure('retry', '451'));
      worker.sender = sender;
      let now = new Date();
      expect(await work(now)).toMatchObject({ retried: count });
      let rows = await queue();
      expect(rows.every((r) => r.status === 'pending' && r.attempts === 1 && r.last_error === '451')).toBe(true);
      // Not before its time.
      expect(await work(new Date(now.getTime() + 30_000))).toMatchObject({ retried: 0 });
      for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
        now = new Date(now.getTime() + BACKOFF_MINUTES[attempt - 2] * MINUTE + 1_000);
        await work(now);
      }
      rows = await queue();
      expect(rows.every((r) => r.status === 'failed' && r.reason === 'gave_up')).toBe(true);
      expect(rows.every((r) => r.attempts === MAX_ATTEMPTS)).toBe(true);
      expect(asked).toHaveLength(count * MAX_ATTEMPTS);
      // Every attempt of one message carries the same Message-ID.
      expect(new Set(asked.map((m) => m.messageId)).size).toBe(count);
    });

    it('is given up at once when the server refuses for good', async () => {
      await report(nurse, { harmLevel: 'severe' });
      worker.sender = failing(() => new MailFailure('permanent', '550')).sender;
      await work();
      const rows = await queue();
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.status === 'failed' && r.reason === 'refused' && r.attempts === 1)).toBe(true);
    });

    it('tries again, counts no attempt, and waits before sending again, when the server refuses the login', async () => {
      // nodemailer's own shape of a refused login: it calls it permanent.
      const refusedLogin = () =>
        Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535, permanent: true, command: 'AUTH PLAIN' });
      await report(nurse, { harmLevel: 'severe' });
      const count = (await queue()).length;
      expect(count).toBeGreaterThan(1);
      const { sender, asked } = failing(refusedLogin);
      worker.sender = sender;
      const now = new Date();
      try {
        expect(await work(now)).toMatchObject({ loginRefused: true, retried: 1, givenUp: 0 });
        // Tried once, for one email; every one went back with no attempt
        // counted (security review 9, finding 2).
        expect(asked).toHaveLength(1);
        let rows = await queue();
        expect(rows.every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true);
        expect(rows.filter((r) => r.last_error === 'EAUTH')).toHaveLength(1);
        // Nothing is tried for five minutes, in any client.
        expect(await work(new Date(now.getTime() + 2 * MINUTE))).toMatchObject({ loginRefused: true, retried: 0 });
        expect(asked).toHaveLength(1);
        // A long outage gives nobody's email up.
        for (let i = 1; i <= 8; i++) await work(new Date(now.getTime() + i * 6 * MINUTE));
        rows = await queue();
        expect(rows.every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true);
        expect(asked.length).toBeGreaterThan(1);
        expect(asked.length).toBeLessThan(10);
        // Mended: everything goes.
        worker.sender = outbox;
        expect(await work(new Date(now.getTime() + 60 * MINUTE))).toMatchObject({ kept: count, loginRefused: false });
      } finally {
        worker.sender = outbox;
        worker.sendingPausedUntil = 0;
      }
    });

    it('treats a refusal to relay at RCPT TO as the configuration’s, not the recipient’s', async () => {
      // Postfix's answer when the relay does not know this sender.
      const relayDenied = () =>
        Object.assign(new Error('Can\'t send mail - all recipients were rejected'), {
          code: 'EENVELOPE',
          responseCode: 554,
          command: 'RCPT TO',
          response: '554 5.7.1 <someone@test.invalid>: Relay access denied',
        });
      await report(nurse, { harmLevel: 'severe' });
      worker.sender = failing(relayDenied).sender;
      try {
        expect(await work()).toMatchObject({ loginRefused: true, givenUp: 0 });
        const rows = await queue();
        expect(rows.every((r) => r.status === 'pending' && r.attempts === 0)).toBe(true);
      } finally {
        worker.sender = outbox;
        worker.sendingPausedUntil = 0;
      }
    });

    it('reads the organization’s switch for each email, not once a run', async () => {
      for (let i = 0; i < 2; i++) await report(nurse, { harmLevel: 'severe' });
      const handed: string[] = [];
      worker.sender = {
        mode: 'outbox',
        send: async (mail) => {
          handed.push(mail.queueId);
          // Switched off for the organization while the run goes on.
          await bench.owner.db.execute(
            sql`insert into email_settings (tenant_id, enabled) values (${a.id}, false)
                on conflict (tenant_id) do update set enabled = false`,
          );
          await outbox.send(mail);
        },
        close: () => Promise.resolve(),
      };
      try {
        await work();
        expect(handed).toHaveLength(1);
        const reasons = (await queue()).map((r) => r.reason).filter(Boolean);
        expect(new Set(reasons)).toEqual(new Set(['organization_off']));
      } finally {
        await bench.owner.db.execute(sql`update email_settings set enabled = true where tenant_id = ${a.id}`);
      }
    });

    it('cannot point at another hospital’s notification or queue row', async () => {
      await report(nurse, { harmLevel: 'severe' });
      const [theirs] = (
        await bench.owner.db.execute<{ id: string }>(sql`select id from notifications where tenant_id = ${a.id} limit 1`)
      ).rows;
      const [row] = await queue();
      // As the owner, past row-level security, as a foreign key is checked.
      await expect(
        bench.owner.db.execute(
          sql`insert into email_queue (tenant_id, user_id, category, notification_id) values (${b.id}, ${b.adminId}, 'immediate', ${theirs.id})`,
        ),
      ).rejects.toThrow();
      await expect(
        bench.owner.db.execute(
          sql`insert into email_outbox (tenant_id, queue_id, to_address, subject, text_body, html_body, headers)
              values (${b.id}, ${row.id}, 'x@test.invalid', 's', 't', 'h', '{}'::jsonb)`,
        ),
      ).rejects.toThrow();
    });

    it('sends what cannot wait, and deletes what is past keeping, when the digests cannot be queued', async () => {
      await report(nurse, { harmLevel: 'severe' });
      const count = (await queue()).length;
      await bench.owner.db.execute(
        sql`update email_settings set digests_queued_on = null where tenant_id = ${a.id}`,
      );
      // Something old enough to delete.
      await bench.owner.db.execute(
        sql`insert into email_queue (tenant_id, user_id, category, period, status, updated_at)
            values (${a.id}, ${quality.id}, 'daily_digest', '2020-01-01', 'sent', now() - interval '31 days')`,
      );
      const provisioning = bench.app.get(ProvisioningService);
      // A failure as a lost connection gives it, its message holding data.
      const lost = () => Object.assign(new Error(`connection to ${quality.email} lost`), { code: 'ECONNRESET' });
      const spy = vi.spyOn(provisioning, 'activeUserIds').mockImplementation(() => Promise.reject(lost()));
      const logged = vi.spyOn(Logger.prototype, 'error');
      worker.digestHour = 0;
      try {
        const done = await work();
        expect(done).toMatchObject({ kept: count, queued: 0 });
        expect(done.failed).toBeGreaterThan(0);
        // Said with the client and the code, never the message.
        const lines = logged.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('Email digests'));
        expect(lines).toContain(`Email digests could not be queued for client ${a.id}: Error (ECONNRESET)`);
        expect(lines.join('\n')).not.toContain(quality.email);
      } finally {
        spy.mockRestore();
        logged.mockRestore();
        worker.digestHour = 24;
      }
      const rows = await queue();
      expect(rows.some((r) => r.category === 'daily_digest')).toBe(false);
      expect(rows.every((r) => r.status === 'sent')).toBe(true);
    });

    it('sends each email once, with several processes at work at the same moment', async () => {
      for (let i = 0; i < 3; i++) await report(nurse, { harmLevel: 'severe' });
      const count = (await queue()).length;
      const handed: string[] = [];
      worker.sender = {
        mode: 'outbox',
        send: async (mail) => {
          handed.push(mail.queueId);
          await new Promise((r) => setTimeout(r, 5));
          await outbox.send(mail);
        },
        close: () => Promise.resolve(),
      };
      const now = new Date();
      await Promise.all([work(now), work(now), work(now), work(now)]);
      expect(handed).toHaveLength(count);
      expect(new Set(handed).size).toBe(count);
      expect((await kept()).length).toBe(count);
      expect((await queue()).every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true);
    });

    it('takes over an email whose process died while sending, once its claim has lapsed', async () => {
      await report(nurse, { harmLevel: 'severe' });
      await bench.owner.db.execute(
        sql`update email_queue set status = 'sending', attempts = 1, claimed_until = now() + interval '10 minutes' where tenant_id = ${a.id}`,
      );
      expect(await work()).toMatchObject({ kept: 0 });
      // A run whose own clock is ahead takes over nothing: a claim lapses by
      // the database's clock only (security review 8).
      expect(await work(new Date(Date.now() + 11 * MINUTE))).toMatchObject({ kept: 0 });
      // Lapsed by the database's clock: taken over.
      await bench.owner.db.execute(
        sql`update email_queue set claimed_until = now() - interval '1 second' where tenant_id = ${a.id}`,
      );
      const count = (await queue()).length;
      expect(await work()).toMatchObject({ kept: count });
      expect((await queue()).every((r) => r.status === 'sent' && r.attempts === 2)).toBe(true);
    });

    it('drops an email a day old, and in SMTP mode one to an address that cannot receive mail', async () => {
      await report(nurse, { harmLevel: 'severe' });
      await bench.owner.db.execute(
        sql`update email_queue set created_at = now() - interval '25 hours' where tenant_id = ${a.id}`,
      );
      await work();
      expect(new Set((await queue()).map((r) => r.reason))).toEqual(new Set(['expired']));

      await clear();
      await report(nurse, { harmLevel: 'severe' });
      const asked: OutgoingMail[] = [];
      worker.sender = {
        mode: 'smtp',
        send: (mail) => {
          asked.push(mail);
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
      };
      await work();
      // Everyone here is @test.invalid, which is nobody's mailbox.
      expect(asked).toEqual([]);
      expect(new Set((await queue()).map((r) => r.reason))).toEqual(new Set(['no_address']));
    });

    it('deletes what is finished after 30 days, and the copies the outbox kept', async () => {
      await report(nurse, { harmLevel: 'severe' });
      await work();
      expect((await kept()).length).toBeGreaterThan(0);
      await bench.owner.db.execute(
        sql`update email_queue set updated_at = now() - interval '31 days' where tenant_id = ${a.id}`,
      );
      await work();
      expect(await queue()).toEqual([]);
      expect(await kept()).toEqual([]);
    });
  });

  describe('the unsubscribe link', () => {
    let link: string;
    let token: string;

    beforeAll(async () => {
      worker.sender = outbox;
      await clear();
      await setPreferences(quality.cookie, { immediate: true, digest: true }).expect(200);
      await report(nurse, { harmLevel: 'severe' });
      await work();
      const mail = (await kept()).find((m) => m.user_id === quality.id)!;
      link = mail.headers['List-Unsubscribe'].slice(1, -1);
      expect(mail.text_body).toContain(link);
      token = link.split('/').pop()!;
    });

    const page = (t: string) => http().get(`/email/unsubscribe/${t}`);
    const oneClick = (t: string) =>
      http()
        .post(`/email/unsubscribe/${t}`)
        .type('form')
        .send('List-Unsubscribe=One-Click');

    it('shows a page with one button, which changes nothing and says nothing of the person', async () => {
      const res = await page(token).expect(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.text).toContain('<form method="post"');
      expect(res.text).toContain('Stop receiving the immediate emails');
      for (const secret of [quality.name, quality.email, 'Hospital a', a.slug]) {
        expect(res.text).not.toContain(secret);
      }
      expect((await preferences(quality.cookie).expect(200)).body.immediate).toBe(true);
    });

    it('switches that kind off in one click, without a session, audited as the person’s', async () => {
      const res = await oneClick(token).expect(200);
      expect(res.text).toContain('You will no longer receive the immediate emails.');
      for (const secret of [quality.name, quality.email, 'Hospital a']) {
        expect(res.text).not.toContain(secret);
      }
      expect((await preferences(quality.cookie).expect(200)).body).toMatchObject({
        immediate: false,
        digest: true,
      });
      const [last] = (await auditOf(a, 'notification_preferences_changed')).slice(-1);
      expect(last).toMatchObject({
        actor_id: quality.id,
        entity_id: quality.id,
        changes: { immediate: { from: true, to: false }, via: 'unsubscribe_link' },
      });
      // Again: the same page, nothing more written.
      const entries = (await auditOf(a, 'notification_preferences_changed')).length;
      await oneClick(token).expect(200);
      await http().post(`/email/unsubscribe/${token}`).send({}).expect(200);
      expect((await auditOf(a, 'notification_preferences_changed')).length).toBe(entries);
      await setPreferences(quality.cookie, { immediate: true }).expect(200);
    });

    it('tells the person in Trustline, and stops working once they switch that kind back on', async () => {
      // The link was used above: the person was told, once.
      const notices = (
        await bench.owner.db.execute<{ kind: string; data: Record<string, unknown> }>(
          sql`select kind, data from notifications where tenant_id = ${a.id} and user_id = ${quality.id} and kind = 'email_turned_off'`,
        )
      ).rows;
      expect(notices).toEqual([{ kind: 'email_turned_off', data: { switch: 'immediate', serious: false } }]);
      // Switched back on since (above): the old link no longer works, on
      // the page or in one click, and changes nothing.
      const shown = await page(token).expect(404);
      expect(shown.text).toContain('This link is not valid or has expired.');
      await oneClick(token).expect(404);
      expect((await preferences(quality.cookie).expect(200)).body.immediate).toBe(true);
      // One issued since works.
      const fresh = signUnsubscribe(config.linkSecret, {
        tenantId: a.id,
        userId: quality.id,
        switch: 'immediate',
        locale: 'en',
      });
      await page(fresh).expect(200);
      // The other kind was never switched back on: its old links still hold.
      const digestLink = signUnsubscribe(
        config.linkSecret,
        { tenantId: a.id, userId: quality.id, switch: 'digest', locale: 'en' },
        new Date(Date.now() - HOUR),
      );
      await page(digestLink).expect(200);
    });

    it('takes no other input', async () => {
      await http().post(`/email/unsubscribe/${token}`).send({ 'List-Unsubscribe': 'Two-Clicks' }).expect(400);
      await http().post(`/email/unsubscribe/${token}`).type('form').send('switch=digest').expect(400);
      await http().post(`/email/unsubscribe/${token}`).send({ userId: nurse.id }).expect(400);
    });

    it('answers a link that is not valid, altered, expired or of another hospital with a page that says only that', async () => {
      const [version, payload, signature] = token.split('.');
      const forged = Buffer.from(
        JSON.stringify({ t: a.id, u: nurse.id, s: 'immediate', l: 'en', e: 4_000_000_000 }),
      ).toString('base64url');
      const old = signUnsubscribe(
        config.linkSecret,
        { tenantId: a.id, userId: quality.id, switch: 'immediate', locale: 'en' },
        new Date(Date.now() - 91 * 24 * HOUR),
      );
      // Signed as it should be, but naming a person of the other hospital
      // under this one: nobody there.
      const crossed = signUnsubscribe(config.linkSecret, {
        tenantId: b.id,
        userId: quality.id,
        switch: 'immediate',
        locale: 'en',
      });
      for (const bad of [
        'nonsense',
        `${version}.${forged}.${signature}`,
        `${version}.${payload}.${signature.slice(0, -3)}abc`,
        old,
        crossed,
      ]) {
        const shown = await page(bad).expect(404);
        expect(shown.text).toContain('This link is not valid or has expired.');
        expect(shown.headers['content-security-policy']).toContain("default-src 'none'");
        await oneClick(bad).expect(404);
      }
      // In the browser's language when the link cannot say.
      expect((await page('nonsense').set('Accept-Language', 'fr-FR,fr;q=0.9').expect(404)).text).toContain(
        'Ce lien n’est pas valide',
      );
      expect((await preferences(nurse.cookie).expect(200)).body.immediate).toBe(true);
      expect((await preferences(bAdmin).expect(200)).body.immediate).toBe(true);
    });

    it('is in the language of the email it came in', async () => {
      await clear();
      await report(nurse, { harmLevel: 'severe' });
      await work();
      const mail = (await kept()).find((m) => m.user_id === arabic.id)!;
      const arabicToken = mail.headers['List-Unsubscribe'].slice(1, -1).split('/').pop()!;
      const res = await page(arabicToken).expect(200);
      expect(res.text).toContain('<html lang="ar" dir="rtl">');
    });
  });

  describe('the digests', () => {
    beforeAll(async () => {
      worker.sender = outbox;
      await clear();
    });
    afterAll(() => {
      worker.digestHour = 24;
    });

    it('sends each person what waits for them each morning, once a day, counts and references only', async () => {
      // Something waits: an incident assigned to the nurse, and a document
      // whose review is the quality officers'.
      const { id, reference } = await report(quality);
      await triage(quality, id, { harmLevel: 'mild', assignedTo: nurse.id }).expect(200);
      await setPreferences(writer.cookie, { digest: false }).expect(200);
      await clear();

      worker.digestHour = 0;
      const first = await work();
      expect(first.queued).toBeGreaterThan(0);
      const rows = await queue();
      const digests = rows.filter((r) => r.category === 'daily_digest');
      // Everyone active but the one who switched it off; once each.
      expect(to(digests)).toEqual(
        ['admin', arabic.name, authority.name, nurse.name, quality.name].sort(),
      );
      const outcome = Object.fromEntries(
        digests.map((r) => [names.get(r.user_id), `${r.status} ${r.reason ?? ''}`.trim()]),
      );
      // Nothing waits for the approving authority: no empty email.
      expect(outcome[authority.name]).toBe('skipped nothing_waiting');
      expect(outcome[nurse.name]).toBe('sent');

      const mails = await kept();
      const nurses = mails.find((m) => m.user_id === nurse.id && m.category === 'daily_digest')!;
      expect(nurses.subject).toMatch(/^What waits for you in Trustline: [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
      // This one, and the sentinel event assigned to the nurse above.
      expect(nurses.text_body).toContain('Incidents assigned to you: 2');
      expect(nurses.text_body).toContain(`- ${reference}: http://localhost:3000/en/incidents/${id}`);
      expect(nurses.text_body).toContain('Stop these summary emails');
      expect(nurses.text_body).not.toContain('Zed Example');
      expect(nurses.text_body).not.toContain(quality.name);
      expect(nurses.headers['List-Unsubscribe']).toContain('/api/v1/email/unsubscribe/');

      const qualitys = mails.find((m) => m.user_id === quality.id && m.category === 'daily_digest')!;
      expect(qualitys.text_body).toMatch(/Documents to review or approve: \d+/);
      expect(qualitys.text_body).toContain('/en/policies/');
      expect(qualitys.text_body).not.toContain('Confidential title');
      const arabics = mails.find((m) => m.user_id === arabic.id && m.category === 'daily_digest')!;
      expect(arabics.html_body).toContain('dir="rtl"');
      expect(arabics.text_body).toContain('وثائق بانتظار مراجعتك أو اعتمادك');

      // Once a day, however often it runs.
      expect((await work()).queued).toBe(0);
      expect((await queue()).filter((r) => r.category === 'daily_digest')).toHaveLength(digests.length);
      await setPreferences(writer.cookie, { digest: true }).expect(200);
    });

    it('sends the weekly digest of overdue acknowledgements to the managers it is written for', async () => {
      await clear();
      const notifier = bench.app.get(DocumentNotifier, { strict: false });
      const tenantDb = bench.app.get(TenantDb);
      await tenantDb.withTenant(a.id, (tx) =>
        notifier.sendDigest(tx, a.id, [
          { userId: quality.id, data: { overdue: 4, people: 2, week: '2026-W48' } },
        ]),
      );
      await work();
      const [mail] = (await kept()).filter((m) => m.category === 'weekly_digest');
      expect(mail.user_id).toBe(quality.id);
      expect(mail.subject).toBe('Overdue acknowledgements this week');
      expect(mail.text_body).toContain('Acknowledgements overdue: 4');
      expect(mail.text_body).toContain('People concerned: 2');
      expect(mail.text_body).toContain('http://localhost:3000/en/policies/overdue');

      // The digest switch governs it.
      await clear();
      await setPreferences(quality.cookie, { digest: false }).expect(200);
      await tenantDb.withTenant(a.id, (tx) =>
        notifier.sendDigest(tx, a.id, [
          { userId: quality.id, data: { overdue: 1, people: 1, week: '2026-W49' } },
        ]),
      );
      worker.digestHour = 24;
      await work();
      expect((await queue()).map((r) => r.reason)).toEqual(['opted_out']);
      await setPreferences(quality.cookie, { digest: true }).expect(200);
    });

    /** Today's digests not made yet: as on a new morning. */
    const newMorning = async () => {
      await clear();
      await bench.owner.db.execute(
        sql`update email_settings set digests_queued_on = null where tenant_id = ${a.id}`,
      );
      worker.digestHour = 0;
    };
    const digestsKept = async () =>
      (await kept()).filter((m) => m.category === 'daily_digest');
    const digestOutcome = async () =>
      Object.fromEntries(
        (await queue())
          .filter((r) => r.category === 'daily_digest')
          .map((r) => [names.get(r.user_id), `${r.status} ${r.reason ?? ''}`.trim()]),
      );

    it('prepares none while the organization has email off, and sends it the same day once it is on', async () => {
      await newMorning();
      await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: false }).expect(200);
      try {
        expect(await work()).toMatchObject({ queued: 0 });
        expect(await queue()).toEqual([]);
      } finally {
        await http().put('/settings/email').set('Cookie', a.cookie).send({ enabled: true }).expect(200);
      }
      expect((await work()).queued).toBeGreaterThan(0);
      expect((await digestsKept()).some((m) => m.user_id === nurse.id)).toBe(true);
    });

    it('lists incidents but not approvals or reviews while the subscription is suspended', async () => {
      await newMorning();
      await setSubscription(a, { status: 'suspended' }).expect(200);
      try {
        await work();
      } finally {
        await setSubscription(a, { status: 'active' }).expect(200);
      }
      const mails = await digestsKept();
      const nurses = mails.find((m) => m.user_id === nurse.id)!;
      expect(nurses.text_body).toContain('Incidents assigned to you: 2');
      expect(mails.length).toBeGreaterThan(0);
      for (const mail of mails) {
        expect(mail.text_body).not.toMatch(/Documents to review or approve|Periodic reviews due/);
        expect(mail.text_body).not.toContain('وثائق بانتظار مراجعتك أو اعتمادك');
      }
      // What waited for the quality officer was approvals only: nothing.
      expect((await digestOutcome())[quality.name]).toBe('skipped nothing_waiting');
    });

    it('has no section of a module that is off', async () => {
      const original = (
        await http().get(`/platform/tenants/${a.id}/subscription`).set('Cookie', bench.platform).expect(200)
      ).body.plan.id as string;
      const docsOnly = (
        await http()
          .post('/platform/plans')
          .set('Cookie', bench.platform)
          .send({
            code: `${bench.prefix}-docs-digest`,
            name: { en: 'Documents', ar: 'الوثائق', fr: 'Documents' },
            modules: ['policies'],
            limits: NO_LIMITS,
            extras: NO_EXTRAS,
          })
          .expect(201)
      ).body.id as string;
      await newMorning();
      await setSubscription(a, { planId: docsOnly }).expect(200);
      try {
        await work();
      } finally {
        await setSubscription(a, { planId: original }).expect(200);
      }
      // The nurse had only incidents waiting.
      expect((await digestOutcome())[nurse.name]).toBe('skipped nothing_waiting');
      const qualitys = (await digestsKept()).find((m) => m.user_id === quality.id)!;
      expect(qualitys.text_body).toMatch(/Documents to review or approve: \d+/);
      expect(qualitys.text_body).not.toContain('Incidents assigned to you');
    });

    it('is not sent on a later day than its own', async () => {
      await newMorning();
      worker.sender = failing(() => new MailFailure('retry', '451')).sender;
      try {
        await work();
      } finally {
        worker.sender = outbox;
      }
      const waiting = (await queue()).filter(
        (r) => r.category === 'daily_digest' && r.status === 'pending',
      );
      expect(waiting.length).toBeGreaterThan(0);
      // As if it was yesterday's, still being tried today.
      await bench.owner.db.execute(
        sql`update email_queue set period = period - 1, next_attempt_at = now()
            where tenant_id = ${a.id} and category = 'daily_digest' and status = 'pending'`,
      );
      await work();
      const after = new Map((await queue()).map((r) => [r.id, r]));
      for (const row of waiting) {
        expect(after.get(row.id)).toMatchObject({ status: 'skipped', reason: 'expired' });
      }
      expect(await digestsKept()).toEqual([]);
    });
  });

  // Last: suspending a client ends its sessions for good, and the tests
  // above use the other hospital's.
  describe('a client Trustline has suspended', () => {
    it('is sent nothing, and its emails expire and are deleted after 30 days like anyone’s', async () => {
      worker.sender = outbox;
      worker.digestHour = 24;
      await clear();
      const bFacility = await bench.createUnit(b, 'facility', 'BF', null);
      const bWard = await bench.createUnit(b, 'unit', 'BW', bFacility);
      // Reported by someone else: the administrator, who triages, is told.
      const bNurse = await bench.createStaff(b, 'b-nurse', { role: 'reporter', orgUnitId: null });
      const reportInB = () =>
        http()
          .post('/incidents')
          .set('Cookie', bNurse.cookie)
          .send({
            type: 'incident',
            categoryId: b.categories.equipment,
            orgUnitId: bWard,
            occurredAt: new Date(Date.now() - HOUR).toISOString(),
            description: DESCRIPTION,
            harmLevel: 'severe',
            anonymous: false,
          })
          .expect(201);
      await reportInB();
      await work();
      expect((await kept(b)).length).toBeGreaterThan(0);
      await reportInB();
      const status = (to: 'active' | 'suspended') =>
        http().patch(`/platform/tenants/${b.id}`).set('Cookie', bench.platform).send({ status: to }).expect(200);
      await status('suspended');
      try {
        // Nothing is sent, and nothing is dropped before its day is out.
        const before = (await kept(b)).length;
        expect(await work()).toMatchObject({ kept: 0, skipped: 0 });
        expect((await kept(b)).length).toBe(before);
        const pending = (await queue(b)).filter((r) => r.status === 'pending');
        expect(pending.length).toBeGreaterThan(0);

        await bench.owner.db.execute(
          sql`update email_queue set created_at = now() - interval '25 hours'
              where tenant_id = ${b.id} and status = 'pending'`,
        );
        await work();
        const expired = new Map((await queue(b)).map((r) => [r.id, r]));
        for (const row of pending) {
          expect(expired.get(row.id)).toMatchObject({ status: 'skipped', reason: 'expired' });
        }
        expect((await kept(b)).length).toBe(before);

        await bench.owner.db.execute(
          sql`update email_queue set updated_at = now() - interval '31 days' where tenant_id = ${b.id}`,
        );
        await work();
        expect(await queue(b)).toEqual([]);
        expect(await kept(b)).toEqual([]);
      } finally {
        await status('active');
      }
    });
  });
});
