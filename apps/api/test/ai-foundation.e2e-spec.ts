import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AnthropicProvider } from '../src/ai/anthropic-provider.js';
import { AiService, type AiCaller } from '../src/ai/ai.service.js';
import { monthOf } from '../src/ai/client-ai.js';
import { fakeAi } from '../src/ai/fake-provider.js';
import { AiProviderError } from '../src/ai/provider.js';
import { AiProviders } from '../src/ai/providers.js';
import {
  aiRequests,
  auditLog,
  notifications,
  platformAuditLog,
} from '../src/database/schema.js';
import { TenantDb } from '../src/database/tenant-db.service.js';
import { AccessService } from '../src/identity/access.service.js';
import { testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

const NO_LIMITS = { users: null, sites: null, storageMb: null, aiCreditsPerMonth: null };
const NO_EXTRAS = { sso: false, publicReporting: false, clinicalAiSuggestions: false };
const words = (en: string) => ({ en, ar: `${en} (ar)`, fr: `${en} (fr)` });

/**
 * The AI foundation (docs/specs/ai-providers-and-allowances.md, steps 1 and
 * 2): provider connections and each client's AI settings in the admin
 * portal, the client's switch, allowances and spending limits, the request
 * records, and `AiService.run()` with names removed and put back. Every
 * request is answered by the fake provider; none reaches a real one.
 */
describe('the AI foundation', () => {
  const run = randomBytes(4).toString('hex');
  const credentialEnv = `AI_CREDENTIAL_TEST_${run.toUpperCase()}`;
  let bench: TestBench;
  const http = () => bench.http();
  const p = () => bench.platform;
  let ai: AiService;

  let planId: string;
  let a: Hospital;
  let b: Hospital;
  let noModule: Hospital;
  let reporter: Staff;
  let anthropic: { id: string };
  let bedrock: { id: string };

  const portal = (method: 'get' | 'post' | 'patch' | 'put', path: string) =>
    http()[method](path).set('Cookie', p());
  const settingsOf = (cookie: string) => http().get('/ai/settings').set('Cookie', cookie);
  const callerOf = async (h: Hospital): Promise<AiCaller> => {
    const { body } = await http().get('/auth/me').set('Cookie', h.cookie).expect(200);
    return { tenant: body.tenant, user: { id: body.user.id } };
  };
  const ask = (content: string, extra: Record<string, unknown> = {}) => ({
    messages: [{ role: 'user' as const, content }],
    maxTokens: 200,
    ...extra,
  });
  const requestsOf = (tenantId: string) =>
    bench.owner.db.select().from(aiRequests).where(eq(aiRequests.tenantId, tenantId)).orderBy(desc(aiRequests.createdAt));
  const noticesOf = (h: Hospital, kind: string) =>
    bench.owner.db
      .select({ data: notifications.data, userId: notifications.userId })
      .from(notifications)
      .where(and(eq(notifications.tenantId, h.id), sql`${notifications.kind}::text = ${kind}`));
  const configure = (h: Hospital, body: Record<string, unknown>) => portal('patch', `/platform/tenants/${h.id}/ai`).send(body);
  const allFeatures = (connectionId: string, model = 'claude-sonnet-5-5') => ({
    drafting: { connectionId, model, quickModel: 'claude-haiku-5-5' },
    insights: { connectionId, model },
    assistant: { connectionId, model },
  });

  beforeAll(async () => {
    bench = await testBench('aif', run);
    ai = bench.app.get(AiService);
    const plan = await portal('post', '/platform/plans')
      .send({
        code: `${bench.prefix}-ai`,
        name: words('AI test plan'),
        modules: ['incidents', 'policies', 'ai_assistant'],
        limits: NO_LIMITS,
        extras: NO_EXTRAS,
        aiAllowances: { drafting: 2, insights: 5, assistant: null },
      })
      .expect(201);
    planId = plan.body.id;
    const bare = await portal('post', '/platform/plans')
      .send({ code: `${bench.prefix}-bare`, name: words('No AI'), modules: ['incidents'], limits: NO_LIMITS, extras: NO_EXTRAS })
      .expect(201);
    expect(bare.body.aiAllowances).toEqual({ drafting: 0, insights: 0, assistant: 0 });

    a = await bench.createHospital('a', { timeZone: 'Asia/Dubai' });
    b = await bench.createHospital('b');
    noModule = await bench.createHospital('n');
    for (const [h, id] of [[a, planId], [b, planId], [noModule, bare.body.id]] as const) {
      await portal('patch', `/platform/tenants/${h.id}/subscription`).send({ planId: id }).expect(200);
    }
    reporter = await bench.createStaff(a, 'reporter', { role: 'reporter', orgUnitId: null });
  });

  afterEach(() => fakeAi.reset());

  afterAll(async () => {
    await bench.owner.db.execute(sql`update ai_platform_settings set monthly_spending_limit_micro_usd = null`);
    delete process.env[credentialEnv];
    await bench.close();
  });

  describe('provider connections, in the admin portal', () => {
    const anthropicBody = () => ({
      name: `${bench.prefix} Anthropic`,
      kind: 'anthropic',
      region: 'global',
      inferenceType: 'global',
      credentialEnv,
      models: [
        { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
        { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', inputUsdPerMTok: 1, outputUsdPerMTok: 5 },
      ],
    });

    it('are for Trustline staff only', async () => {
      const id = randomUUID();
      for (const [method, path] of [
        ['get', '/platform/ai/connections'],
        ['post', '/platform/ai/connections'],
        ['get', `/platform/ai/connections/${id}`],
        ['patch', `/platform/ai/connections/${id}`],
        ['post', `/platform/ai/connections/${id}/test`],
        ['get', '/platform/ai/settings'],
        ['put', '/platform/ai/settings'],
        ['get', '/platform/ai/usage'],
        ['get', `/platform/tenants/${id}/ai`],
        ['patch', `/platform/tenants/${id}/ai`],
      ] as const) {
        await http()[method](path).send({}).expect(401);
        // A hospital's own session is not Trustline's.
        await http()[method](path).set('Cookie', a.cookie).send({}).expect(401);
      }
    });

    it('refuse what is malformed, names no credential but one of their own, and never another secret', async () => {
      const bad = [
        { ...anthropicBody(), extra: true },
        { ...anthropicBody(), credentialEnv: 'DATABASE_URL' },
        { ...anthropicBody(), credentialEnv: 'AI_CREDENTIAL_lower' },
        { ...anthropicBody(), models: [] },
        { ...anthropicBody(), kind: 'vertex' },
        { ...anthropicBody(), models: [{ id: 'm', label: 'M', inputUsdPerMTok: -1, outputUsdPerMTok: 1 }] },
        { ...anthropicBody(), apiKey: 'sk-should-never-be-accepted' },
      ];
      for (const body of bad) await portal('post', '/platform/ai/connections').send(body).expect(400);
    });

    it('must say truly where they process requests', async () => {
      const bedrockBody = {
        name: `${bench.prefix} Bedrock`,
        kind: 'bedrock',
        region: 'me-central-1',
        inferenceType: 'global',
        credentialEnv,
        models: [{ id: 'eu.anthropic.claude-sonnet-5-5', label: 'Sonnet', inputUsdPerMTok: 3, outputUsdPerMTok: 15 }],
      };
      const mismatch = await portal('post', '/platform/ai/connections').send(bedrockBody).expect(400);
      expect(mismatch.body).toMatchObject({ code: 'model_inference_mismatch', model: 'eu.anthropic.claude-sonnet-5-5' });
      const inRegion = await portal('post', '/platform/ai/connections')
        .send({ ...bedrockBody, inferenceType: 'in_region' })
        .expect(400);
      expect(inRegion.body.code).toBe('model_inference_mismatch');
      expect((await portal('post', '/platform/ai/connections').send({ ...bedrockBody, region: 'uae' }).expect(400)).body.code).toBe('invalid_region');
      expect(
        (await portal('post', '/platform/ai/connections').send({ ...anthropicBody(), inferenceType: 'in_region' }).expect(400)).body.code,
      ).toBe('inference_type_not_offered');

      const created = await portal('post', '/platform/ai/connections')
        .send({ ...bedrockBody, models: [{ id: 'global.anthropic.claude-sonnet-5-5', label: 'Sonnet', inputUsdPerMTok: 3, outputUsdPerMTok: 15 }] })
        .expect(201);
      bedrock = created.body;
      expect(created.body).toMatchObject({ kind: 'bedrock', region: 'me-central-1', inferenceType: 'global', active: true, clients: 0 });
    });

    it('are created with the name of their credential’s variable, shown only as present or not', async () => {
      const res = await portal('post', '/platform/ai/connections').send(anthropicBody()).expect(201);
      anthropic = res.body;
      expect(res.body).toMatchObject({ kind: 'anthropic', credentialEnv, credentialsPresent: false, active: true });
      process.env[credentialEnv] = 'sk-test-never-sent-anywhere';
      const listed = await portal('get', '/platform/ai/connections').expect(200);
      const mine = listed.body.find((c: { id: string }) => c.id === anthropic.id);
      expect(mine.credentialsPresent).toBe(true);
      expect(JSON.stringify(listed.body)).not.toContain('sk-test-never-sent-anywhere');
      await portal('post', '/platform/ai/connections').send(anthropicBody()).expect(409, { code: 'name_taken' });
      const [entry] = await bench.owner.db
        .select({ details: platformAuditLog.details })
        .from(platformAuditLog)
        .where(and(eq(platformAuditLog.action, 'ai_connection_created'), sql`${platformAuditLog.details} ->> 'connectionId' = ${anthropic.id}`));
      expect(entry.details).toMatchObject({ kind: 'anthropic', credentialEnv });
    });

    it('answer 404 for one that does not exist', async () => {
      await portal('get', `/platform/ai/connections/${randomUUID()}`).expect(404);
      await portal('get', '/platform/ai/connections/not-an-id').expect(404);
      await portal('patch', `/platform/ai/connections/${randomUUID()}`).send({ name: 'x' }).expect(404);
      await portal('post', `/platform/ai/connections/${randomUUID()}/test`).send({}).expect(404);
    });

    it('are edited and audited with what changed', async () => {
      await portal('patch', `/platform/ai/connections/${anthropic.id}`).send({}).expect(400);
      await portal('patch', `/platform/ai/connections/${anthropic.id}`).send({ kind: 'bedrock' }).expect(400);
      const res = await portal('patch', `/platform/ai/connections/${bedrock.id}`).send({ name: `${bench.prefix} Bedrock UAE` }).expect(200);
      expect(res.body.name).toBe(`${bench.prefix} Bedrock UAE`);
      const [entry] = await bench.owner.db
        .select({ details: platformAuditLog.details })
        .from(platformAuditLog)
        .where(and(eq(platformAuditLog.action, 'ai_connection_updated'), sql`${platformAuditLog.details} ->> 'connectionId' = ${bedrock.id}`));
      expect(entry.details).toMatchObject({ changes: { name: { from: `${bench.prefix} Bedrock`, to: `${bench.prefix} Bedrock UAE` } } });
    });

    it('are tested with a tiny call that says only whether it works, through the fake provider', async () => {
      const ok = await portal('post', `/platform/ai/connections/${anthropic.id}/test`).send({}).expect(200);
      expect(ok.body).toEqual({ works: true, credentialsPresent: true });
      expect(fakeAi.calls).toHaveLength(1);
      expect(fakeAi.calls[0].request).toMatchObject({ model: 'claude-sonnet-5-5', maxTokens: 5 });
      fakeAi.respondWith(() => {
        throw new AiProviderError('auth');
      });
      const failed = await portal('post', `/platform/ai/connections/${anthropic.id}/test`).send({ model: 'claude-haiku-5-5' }).expect(200);
      expect(failed.body).toEqual({ works: false, credentialsPresent: true });
      await portal('post', `/platform/ai/connections/${anthropic.id}/test`).send({ model: 'gpt-9' }).expect(400, { code: 'unknown_model' });
      const tested = await bench.owner.db
        .select({ details: platformAuditLog.details })
        .from(platformAuditLog)
        .where(and(eq(platformAuditLog.action, 'ai_connection_tested'), sql`${platformAuditLog.details} ->> 'connectionId' = ${anthropic.id}`));
      expect(tested.map((t) => (t.details as { works: boolean }).works).sort((x, y) => Number(x) - Number(y))).toEqual([false, true]);
    });
  });

  describe('a client’s AI settings, in the admin portal', () => {
    it('answer 404 for a client that does not exist, and refuse what is malformed', async () => {
      await portal('get', `/platform/tenants/${randomUUID()}/ai`).expect(404);
      await configure({ ...a, id: randomUUID() }, { offered: true }).expect(404);
      for (const body of [
        {},
        { offered: 'yes' },
        { features: { translation: null } },
        { features: { drafting: { connectionId: 'x', model: 'm' } } },
        { allowanceOverrides: { drafting: -1 } },
        { monthlySpendingLimitUsd: 0.001 },
        { clientEnabled: true },
      ]) {
        await configure(a, body).expect(400);
      }
    });

    it('refuse a connection or model that cannot serve', async () => {
      expect(
        (await configure(a, { features: { drafting: { connectionId: randomUUID(), model: 'claude-sonnet-5-5' } } }).expect(400)).body,
      ).toMatchObject({ code: 'unknown_connection', feature: 'drafting' });
      expect(
        (await configure(a, { features: { insights: { connectionId: anthropic.id, model: 'global.anthropic.claude-sonnet-5-5' } } }).expect(400)).body,
      ).toMatchObject({ code: 'unknown_model', feature: 'insights' });
    });

    it('start from what the plan gives and offer nothing', async () => {
      const res = await portal('get', `/platform/tenants/${a.id}/ai`).expect(200);
      expect(res.body).toMatchObject({
        offered: false,
        features: { drafting: null, insights: null, assistant: null },
        planAllowances: { drafting: 2, insights: 5, assistant: null },
        allowances: { drafting: 2, insights: 5, assistant: null },
        clientEnabled: false,
      });
    });

    it('are set, audited in both logs, and tell the client’s administrators of the provider', async () => {
      const res = await configure(a, { offered: true, features: allFeatures(anthropic.id), medicalOptionAllowed: true }).expect(200);
      expect(res.body.features.drafting).toMatchObject({
        connection: { id: anthropic.id, kind: 'anthropic', region: 'global', inferenceType: 'global', active: true },
        model: 'claude-sonnet-5-5',
        quickModel: 'claude-haiku-5-5',
      });
      const [platformEntry] = await bench.owner.db
        .select({ details: platformAuditLog.details })
        .from(platformAuditLog)
        .where(and(eq(platformAuditLog.action, 'ai_client_settings_updated'), eq(platformAuditLog.targetTenantId, a.id)));
      expect(platformEntry.details).toMatchObject({ changes: { offered: { from: false, to: true }, 'features.drafting': { from: null } } });
      const [clientEntry] = await bench.owner.db
        .select({ actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'ai_settings_changed')));
      expect(clientEntry.actorId).toBeNull();
      expect(clientEntry.changes).toMatchObject({
        offered: { from: false, to: true },
        features: { drafting: { from: null, to: { kind: 'anthropic', region: 'global', inferenceType: 'global', model: 'claude-sonnet-5-5' } } },
        medicalOptionAllowed: { from: false, to: true },
        platformAdminEmail: expect.stringContaining('@test.invalid'),
      });
      // Never the connection's own name, nor where its credential is.
      expect(JSON.stringify(clientEntry.changes)).not.toContain(credentialEnv);
      const told = await noticesOf(a, 'ai_provider_changed');
      expect(told).toEqual([{ userId: a.adminId, data: { features: 'drafting,insights,assistant', serious: false } }]);
      const listed = await http().get('/notifications').set('Cookie', a.cookie).expect(200);
      expect(listed.body.items.map((n: { kind: string }) => n.kind)).toContain('ai_provider_changed');
      // The reporter is not an administrator.
      expect(told.some((n) => n.userId === reporter.id)).toBe(false);
    });

    it('write nothing when nothing changes', async () => {
      const before = await bench.owner.db.select().from(platformAuditLog).where(eq(platformAuditLog.targetTenantId, a.id));
      await configure(a, { offered: true }).expect(200);
      const after = await bench.owner.db.select().from(platformAuditLog).where(eq(platformAuditLog.targetTenantId, a.id));
      expect(after.length).toBe(before.length);
    });

    it('override an allowance, which the client’s log records; a spending limit, which it does not', async () => {
      await configure(b, { offered: true, features: allFeatures(bedrock.id, 'global.anthropic.claude-sonnet-5-5') }).expect(400);
      // Bedrock has no haiku: the quick model is refused.
      await configure(b, {
        offered: true,
        features: { drafting: { connectionId: bedrock.id, model: 'global.anthropic.claude-sonnet-5-5' } },
        allowanceOverrides: { drafting: 50 },
        monthlySpendingLimitUsd: 25.5,
      }).expect(200);
      const res = await portal('get', `/platform/tenants/${b.id}/ai`).expect(200);
      expect(res.body).toMatchObject({ allowances: { drafting: 50, insights: 5, assistant: null }, monthlySpendingLimitUsd: 25.5 });
      const [entry] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, b.id), eq(auditLog.action, 'ai_settings_changed')));
      expect(entry.changes).toMatchObject({ allowances: { drafting: { from: 2, to: 50 } } });
      expect(JSON.stringify(entry.changes)).not.toMatch(/spending|25\.5/i);
    });

    it('keep a connection a client uses from moving, being deactivated or losing its model', async () => {
      const moved = await portal('patch', `/platform/ai/connections/${bedrock.id}`).send({ region: 'eu-west-1' }).expect(409);
      expect(moved.body).toEqual({ code: 'connection_in_use', tenantIds: [b.id] });
      await portal('patch', `/platform/ai/connections/${bedrock.id}`).send({ active: false }).expect(409);
      const lost = await portal('patch', `/platform/ai/connections/${anthropic.id}`)
        .send({ models: [{ id: 'claude-sonnet-5-5', label: 'Sonnet', inputUsdPerMTok: 3, outputUsdPerMTok: 15 }] })
        .expect(409);
      expect(lost.body).toMatchObject({ code: 'model_in_use', model: 'claude-haiku-5-5', tenantIds: [a.id] });
    });
  });

  describe('the client’s own settings (GET and PUT /ai/settings)', () => {
    it('need a session', async () => {
      await http().get('/ai/settings').expect(401);
      await http().put('/ai/settings').send({ enabled: true }).expect(401);
    });

    it('do not exist for a client without the AI module', async () => {
      await settingsOf(noModule.cookie).expect(404);
      await http().put('/ai/settings').set('Cookie', noModule.cookie).send({ enabled: true }).expect(404);
    });

    it('show anyone what is offered, by which provider and where, and nothing of usage', async () => {
      const res = await settingsOf(reporter.cookie).expect(200);
      expect(res.body).toEqual({
        available: true,
        enabled: false,
        features: ['drafting', 'insights', 'assistant'].map((feature) => ({
          feature,
          offered: true,
          active: false,
          provider: { kind: 'anthropic', region: 'global', inferenceType: 'global' },
        })),
      });
    });

    it('show the administrators the models, the allowances and the usage', async () => {
      const res = await settingsOf(a.cookie).expect(200);
      expect(res.body).toMatchObject({
        available: true,
        enabled: false,
        month: monthOf(new Date(), 'Asia/Dubai'),
        medicalOptionAllowed: true,
        switchedBy: null,
      });
      expect(res.body.features[0]).toEqual({
        feature: 'drafting',
        offered: true,
        active: false,
        provider: { kind: 'anthropic', region: 'global', inferenceType: 'global' },
        reason: null,
        model: 'claude-sonnet-5-5',
        quickModel: 'claude-haiku-5-5',
        allowance: 2,
        used: 0,
        warning: false,
        reached: false,
      });
    });

    it('are each client’s own: one never sees another’s', async () => {
      const res = await settingsOf(b.cookie).expect(200);
      expect(res.body.features.map((f: { feature: string; offered: boolean; reason: string | null }) => [f.feature, f.offered, f.reason])).toEqual([
        ['drafting', true, null],
        ['insights', false, 'not_configured'],
        ['assistant', false, 'not_configured'],
      ]);
      expect(res.body.features[0].provider).toEqual({ kind: 'bedrock', region: 'me-central-1', inferenceType: 'global' });
    });

    it('are switched by those who manage the whole organization’s settings, and the switch is audited', async () => {
      await http().put('/ai/settings').set('Cookie', reporter.cookie).send({ enabled: true }).expect(403);
      for (const body of [{}, { enabled: 'on' }, { enabled: true, extra: 1 }]) {
        await http().put('/ai/settings').set('Cookie', a.cookie).send(body).expect(400);
      }
      const on = await http().put('/ai/settings').set('Cookie', a.cookie).send({ enabled: true }).expect(200);
      expect(on.body).toMatchObject({ enabled: true, switchedBy: { id: a.adminId } });
      expect(on.body.features.every((f: { active: boolean }) => f.active)).toBe(true);
      const entries = await bench.owner.db
        .select({ actorId: auditLog.actorId, changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'ai_use_changed')));
      expect(entries).toEqual([{ actorId: a.adminId, changes: { from: false, to: true } }]);
      // The same again changes and audits nothing.
      await http().put('/ai/settings').set('Cookie', a.cookie).send({ enabled: true }).expect(200);
      expect(
        await bench.owner.db.select().from(auditLog).where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'ai_use_changed'))),
      ).toHaveLength(1);
    });

    it('cannot be switched on before Trustline offers anything', async () => {
      const c = await bench.createHospital('c');
      await portal('patch', `/platform/tenants/${c.id}/subscription`).send({ planId }).expect(200);
      await http().put('/ai/settings').set('Cookie', c.cookie).send({ enabled: true }).expect(409, { code: 'ai_not_offered' });
      // Off is always allowed, and changes nothing.
      await http().put('/ai/settings').set('Cookie', c.cookie).send({ enabled: false }).expect(200);
    });
  });

  describe('AiService.run', () => {
    it('refuses, with a code, what is not offered or not switched on', async () => {
      const off = await callerOf(noModule);
      expect(await ai.run(off, 'drafting', ask('Hi'))).toEqual({ ok: false, code: 'ai_not_offered', feature: 'drafting', reason: 'module' });
      const bCaller = await callerOf(b);
      expect(await ai.run(bCaller, 'insights', ask('Hi'))).toMatchObject({ ok: false, code: 'ai_not_offered', reason: 'not_configured' });
      // Offered, but b has not switched AI on.
      expect(await ai.run(bCaller, 'drafting', ask('Hi'))).toEqual({ ok: false, code: 'ai_switched_off', feature: 'drafting' });
      expect(fakeAi.calls).toHaveLength(0);
    });

    it('sends no name or identifier, and puts them back in the answer', async () => {
      const caller = await callerOf(a);
      const text = 'Nurse Person reporter (Person reporter@x.org) saw Mariam Al-Khoury fall; call +971 50 123 4567. MRN 00451234.';
      const res = await ai.run(caller, 'insights', ask(text, { people: ['Mariam El Khoury'], system: 'About Person reporter.' }));
      expect(res.ok).toBe(true);
      const sent = fakeAi.calls[0].request;
      const everything = JSON.stringify(sent);
      for (const leak of ['reporter', 'Mariam', 'Khoury', '971', '4567', '00451234', 'x.org']) {
        expect([leak, everything.includes(leak)]).toEqual([leak, false]);
      }
      expect(sent.messages[0].content).toBe('Nurse [PERSON_1] ([PERSON_2] [EMAIL_1]) saw [PERSON_3] fall; call [PHONE_1]. MRN [MRN_1].');
      expect(sent.system).toBe('About [PERSON_1].');
      expect(sent.model).toBe('claude-sonnet-5-5');
      if (res.ok) expect(res.text).toBe(`Fake answer: ${text}`);
    });

    it('records the request: who, which feature, connection and model, its size, cost and outcome, never its text', async () => {
      const [row] = await requestsOf(a.id);
      expect(row).toMatchObject({
        feature: 'insights',
        connectionId: anthropic.id,
        model: 'claude-sonnet-5-5',
        userId: a.adminId,
        month: monthOf(new Date(), 'Asia/Dubai'),
        counted: true,
        outcome: 'succeeded',
        reason: null,
        attempts: 1,
      });
      expect(row.inputTokens).toBeGreaterThan(0);
      expect(row.outputTokens).toBeGreaterThan(0);
      expect(row.costMicroUsd).toBe(Math.ceil(row.inputTokens * 3 + row.outputTokens * 15));
      expect(JSON.stringify(row)).not.toMatch(/Mariam|reporter|4567/);
    });

    it('uses the quick model when asked, and returns data put back when a schema is given', async () => {
      fakeAi.respondWith(() => JSON.stringify({ who: '[PERSON_1]', steps: ['Call [PERSON_1]'] }));
      const res = await ai.run(await callerOf(a), 'drafting', ask('Draft for Mariam Al-Khoury', {
        tier: 'quick',
        people: ['Mariam Al-Khoury'],
        output: { schema: { type: 'object' } },
        unit: `draft-${run}-q`,
      }));
      expect(res).toMatchObject({ ok: true, model: 'claude-haiku-5-5', data: { who: 'Mariam Al-Khoury', steps: ['Call Mariam Al-Khoury'] } });
      expect(fakeAi.calls[0].request.output).toEqual({ schema: { type: 'object' } });
    });

    it('retries once a failure worth retrying, and not one that is not', async () => {
      const caller = await callerOf(a);
      fakeAi.respondWith((_, attempt) => {
        if (attempt === 1) throw new AiProviderError('overloaded');
        return 'fine';
      });
      expect(await ai.run(caller, 'assistant', ask('Hello'))).toMatchObject({ ok: true, text: 'fine' });
      expect((await requestsOf(a.id))[0]).toMatchObject({ outcome: 'succeeded', attempts: 2 });

      fakeAi.reset();
      fakeAi.respondWith(() => {
        throw new AiProviderError('bad_request');
      });
      expect(await ai.run(caller, 'assistant', ask('Hello'))).toEqual({ ok: false, code: 'ai_unavailable', feature: 'assistant' });
      expect(fakeAi.calls).toHaveLength(1);
      expect((await requestsOf(a.id))[0]).toMatchObject({ outcome: 'failed', reason: 'bad_request', attempts: 1, counted: true });
    });

    it('gives up on a provider that does not answer in time, twice, and the feature is told it is unavailable', async () => {
      fakeAi.respondWith(() => new Promise(() => undefined));
      const res = await ai.run(await callerOf(a), 'assistant', ask('Hello', { timeoutMs: 50 }));
      expect(res).toEqual({ ok: false, code: 'ai_unavailable', feature: 'assistant' });
      expect(fakeAi.calls).toHaveLength(2);
      expect((await requestsOf(a.id))[0]).toMatchObject({ outcome: 'failed', reason: 'timeout', attempts: 2, costMicroUsd: 0 });
    });

    it('counts suggestions against the allowance, warns at 80% and refuses at 100%, once a month each', async () => {
      const caller = await callerOf(a);
      // One suggestion so far (the first request of these tests).
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await ai.run(caller, 'insights', ask(`Suggestion ${i}`)));
      expect(results.map((r) => r.ok)).toEqual([true, true, true, true, false]);
      const month = monthOf(new Date(), 'Asia/Dubai');
      const [y, m] = month.split('-').map(Number);
      const resetsOn = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
      expect(results[4]).toEqual({ ok: false, code: 'ai_allowance_reached', feature: 'insights', allowance: 5, resetsOn });
      expect((await requestsOf(a.id))[0]).toMatchObject({ outcome: 'refused', reason: 'allowance_reached' });
      expect(await noticesOf(a, 'ai_allowance_warning')).toEqual([
        { userId: a.adminId, data: { feature: 'insights', used: 4, allowance: 5, month, resetsOn, serious: false } },
      ]);
      expect(await noticesOf(a, 'ai_allowance_reached')).toEqual([
        { userId: a.adminId, data: { feature: 'insights', used: 5, allowance: 5, month, resetsOn, serious: false } },
      ]);
      // Refused again: no new notice. Other features go on.
      expect(await ai.run(caller, 'insights', ask('Again'))).toMatchObject({ code: 'ai_allowance_reached' });
      expect(await noticesOf(a, 'ai_allowance_reached')).toHaveLength(1);
      expect(await ai.run(caller, 'assistant', ask('Still here'))).toMatchObject({ ok: true });
      const shown = await settingsOf(a.cookie).expect(200);
      expect(shown.body.features[1]).toMatchObject({ feature: 'insights', allowance: 5, used: 5, warning: true, reached: true });
    });

    it('counts a draft once for its questions, the draft and five revisions; the sixth revision is another draft', async () => {
      const caller = await callerOf(a);
      // The quick request above opened one draft of the two allowed.
      const unit = `draft-${run}-main`;
      const steps = [
        ask('Questions?', { unit }),
        ask('The draft', { unit }),
        ...Array.from({ length: 5 }, (_, i) => ask(`Revision ${i + 1}`, { unit, revision: true })),
      ];
      for (const step of steps) expect(await ai.run(caller, 'drafting', step)).toMatchObject({ ok: true });
      const counted = (await requestsOf(a.id)).filter((r) => r.feature === 'drafting' && r.unitKey === unit);
      expect(counted.map((r) => r.counted)).toEqual([false, false, false, false, false, false, true]);
      // A sixth revision would open a third draft: over the allowance of two.
      expect(await ai.run(caller, 'drafting', ask('Revision 6', { unit, revision: true }))).toMatchObject({
        ok: false,
        code: 'ai_allowance_reached',
        allowance: 2,
      });
      expect(await ai.run(caller, 'drafting', ask('Another document', { unit: `draft-${run}-other` }))).toMatchObject({
        code: 'ai_allowance_reached',
      });
    });

    it('stops at the client’s spending limit, and tells Trustline’s staff once', async () => {
      await configure(a, { allowanceOverrides: { drafting: 2, insights: null, assistant: null }, monthlySpendingLimitUsd: 0.01 }).expect(200);
      const caller = await callerOf(a);
      // The most this can cost is 1,000 tokens at $15 a million: over a cent.
      const big = ask('Large', { maxTokens: 1000 });
      expect(await ai.run(caller, 'insights', big)).toEqual({ ok: false, code: 'ai_spending_limit', feature: 'insights' });
      expect(await ai.run(caller, 'assistant', big)).toMatchObject({ code: 'ai_spending_limit' });
      const told = await bench.owner.db
        .select({ details: platformAuditLog.details, adminId: platformAuditLog.adminId })
        .from(platformAuditLog)
        .where(and(eq(platformAuditLog.action, 'ai_spending_limit_reached'), eq(platformAuditLog.targetTenantId, a.id)));
      expect(told).toEqual([{ adminId: null, details: { scope: 'client', month: monthOf(new Date(), 'Asia/Dubai') } }]);
      expect((await requestsOf(a.id))[0]).toMatchObject({ outcome: 'refused', reason: 'spending_limit' });
      await configure(a, { monthlySpendingLimitUsd: null }).expect(200);
      expect(await ai.run(caller, 'insights', big)).toMatchObject({ ok: true });
    });

    it('stops at the platform-wide spending limit, and tells Trustline’s staff once', async () => {
      const set = await portal('put', '/platform/ai/settings').send({ monthlySpendingLimitUsd: 0.01 }).expect(200);
      try {
        expect(set.body).toMatchObject({ monthlySpendingLimitUsd: 0.01, mode: 'fake' });
        const caller = await callerOf(a);
        expect(await ai.run(caller, 'assistant', ask('Large', { maxTokens: 1000 }))).toMatchObject({ code: 'ai_spending_limit' });
        const told = await bench.owner.db
          .select({ details: platformAuditLog.details })
          .from(platformAuditLog)
          .where(and(eq(platformAuditLog.action, 'ai_spending_limit_reached'), sql`${platformAuditLog.details} ->> 'scope' = 'platform'`));
        expect(told.map((t) => t.details)).toContainEqual({ scope: 'platform', month: new Date().toISOString().slice(0, 7) });
        const [entry] = await bench.owner.db
          .select({ details: platformAuditLog.details })
          .from(platformAuditLog)
          .where(eq(platformAuditLog.action, 'ai_platform_settings_updated'))
          .orderBy(desc(platformAuditLog.createdAt))
          .limit(1);
        expect(entry.details).toEqual({ monthlySpendingLimitUsd: { from: null, to: 0.01 } });
      } finally {
        await portal('put', '/platform/ai/settings').send({ monthlySpendingLimitUsd: null }).expect(200);
      }
      await portal('put', '/platform/ai/settings').send({ monthlySpendingLimitUsd: -1 }).expect(400);
    });

    it('fails a test that would reach a real provider, rather than calling it unavailable', async () => {
      const real = { mode: 'real', credentialsPresent: () => true, for: () => new AnthropicProvider('sk-test') } as unknown as AiProviders;
      const service = new AiService(bench.app.get(TenantDb), real, bench.app.get(AccessService));
      await expect(service.run(await callerOf(a), 'assistant', ask('Hello'))).rejects.toThrow(/real AI provider/);
    });
  });

  describe('usage, for Trustline’s staff', () => {
    it('shows each client’s use against its allowances and its cost', async () => {
      const one = await portal('get', `/platform/tenants/${a.id}/ai`).expect(200);
      expect(one.body.usage.insights.used).toBe(6);
      expect(one.body.costUsd).toBeGreaterThan(0);
      const all = await portal('get', '/platform/ai/usage').expect(200);
      const mine = all.body.find((c: { tenantId: string }) => c.tenantId === a.id);
      expect(mine).toMatchObject({ offered: true, enabled: true, near: true, features: { insights: { used: 6, allowance: null } } });
    });
  });

  describe('a plan’s allowances', () => {
    it('are part of the plan, refused when malformed, and a change is in the clients’ logs', async () => {
      await portal('patch', `/platform/plans/${planId}`).send({ aiAllowances: { drafting: 1 } }).expect(400);
      const res = await portal('patch', `/platform/plans/${planId}`).send({ aiAllowances: { drafting: 2, insights: 7, assistant: null } }).expect(200);
      expect(res.body.aiAllowances).toEqual({ drafting: 2, insights: 7, assistant: null });
      // b follows the plan for insights; a has its own allowance for it.
      const [bEntry] = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, b.id), eq(auditLog.action, 'subscription_changed'), sql`${auditLog.changes} ? 'planUpdated'`));
      expect(bEntry.changes).toMatchObject({ aiAllowances: { insights: { from: 5, to: 7 } } });
      const aEntries = await bench.owner.db
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'subscription_changed'), sql`${auditLog.changes} ? 'planUpdated'`));
      expect(aEntries).toEqual([]);
    });
  });

  describe('a change of provider', () => {
    it('tells the administrators which features moved, and withdrawing AI tells them too', async () => {
      await configure(a, { features: { assistant: { connectionId: bedrock.id, model: 'global.anthropic.claude-sonnet-5-5' } } }).expect(200);
      const told = await noticesOf(a, 'ai_provider_changed');
      expect(told.map((n) => n.data.features)).toEqual(expect.arrayContaining(['drafting,insights,assistant', 'assistant']));
      await configure(a, { offered: false }).expect(200);
      expect((await noticesOf(a, 'ai_provider_changed')).map((n) => n.data.features)).toContain('drafting,insights,assistant');
      expect(await ai.run(await callerOf(a), 'drafting', ask('Hi'))).toMatchObject({ code: 'ai_not_offered', reason: 'not_offered' });
      // Withdrawn, the connection can be deactivated once no client uses it.
      await configure(a, { features: { drafting: null, insights: null, assistant: null } }).expect(200);
      await configure(b, { features: { drafting: null } }).expect(200);
      const off = await portal('patch', `/platform/ai/connections/${bedrock.id}`).send({ active: false }).expect(200);
      expect(off.body.active).toBe(false);
      await configure(b, { features: { drafting: { connectionId: bedrock.id, model: 'global.anthropic.claude-sonnet-5-5' } } }).expect(400, {
        code: 'connection_inactive',
        feature: 'drafting',
      });
    });
  });
});
