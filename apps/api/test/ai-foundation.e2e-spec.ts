import '../src/env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AnthropicProvider } from '../src/ai/anthropic-provider.js';
import { AiService, MAX_MESSAGE_CHARS, MAX_REQUEST_CHARS, type AiCaller, type AiRunRequest } from '../src/ai/ai.service.js';
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
import { EntitlementsService } from '../src/subscriptions/entitlements.service.js';
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
  const credentialEnv = `AI_CREDENTIAL_ANTHROPIC_TEST_${run.toUpperCase()}`;
  const bedrockEnv = `AI_CREDENTIAL_BEDROCK_TEST_${run.toUpperCase()}`;
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
  const ask = (content: string, extra: Partial<AiRunRequest> = {}): AiRunRequest => ({
    messages: [{ role: 'user' as const, content }],
    maxTokens: 200,
    people: [],
    ...extra,
  });
  /** A request of a draft: its own, unless one is named. */
  const draftAsk = (content: string, unit: string = randomUUID(), extra: Partial<AiRunRequest> = {}) => ask(content, { unit, ...extra });
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
    delete process.env[bedrockEnv];
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
        credentialEnv: bedrockEnv,
        models: [{ id: 'eu.anthropic.claude-sonnet-5-5', label: 'Sonnet', inputUsdPerMTok: 3, outputUsdPerMTok: 15 }],
      };
      const mismatch = await portal('post', '/platform/ai/connections').send(bedrockBody).expect(400);
      expect(mismatch.body).toMatchObject({ code: 'model_inference_mismatch', model: 'eu.anthropic.claude-sonnet-5-5' });
      const inRegion = await portal('post', '/platform/ai/connections')
        .send({ ...bedrockBody, inferenceType: 'in_region' })
        .expect(400);
      expect(inRegion.body.code).toBe('model_inference_mismatch');
      expect((await portal('post', '/platform/ai/connections').send({ ...bedrockBody, region: 'uae' }).expect(400)).body.code).toBe('invalid_region');
      // A regional profile of another geography than the region's.
      const sonnet = (id: string) => [{ id, label: 'Sonnet', inputUsdPerMTok: 3, outputUsdPerMTok: 15 }];
      for (const [region, inferenceType, id] of [
        ['me-central-1', 'regional', 'us.anthropic.claude-sonnet-5-5'],
        ['eu-west-1', 'regional', 'us.anthropic.claude-sonnet-5-5'],
        // An ARN of another region, or of a profile that may send requests elsewhere.
        ['me-central-1', 'in_region', 'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-5-5'],
        ['me-central-1', 'in_region', 'arn:aws:bedrock:me-central-1:123456789012:application-inference-profile/abc'],
      ]) {
        const res = await portal('post', '/platform/ai/connections').send({ ...bedrockBody, region, inferenceType, models: sonnet(id) }).expect(400);
        expect([id, res.body.code]).toEqual([id, 'model_inference_mismatch']);
      }
      await portal('post', '/platform/ai/connections')
        .send({ ...bedrockBody, name: `${bench.prefix} EU`, region: 'eu-west-1', inferenceType: 'regional', models: sonnet('eu.anthropic.claude-sonnet-5-5') })
        .expect(201);
      await portal('post', '/platform/ai/connections')
        .send({ ...bedrockBody, name: `${bench.prefix} UAE only`, inferenceType: 'in_region', models: sonnet('arn:aws:bedrock:me-central-1::foundation-model/anthropic.claude-sonnet-5-5') })
        .expect(201);
      // One kind's credential is never named for another kind.
      expect(
        (await portal('post', '/platform/ai/connections').send({ ...bedrockBody, models: sonnet('global.anthropic.claude-sonnet-5-5'), credentialEnv }).expect(400)).body.code,
      ).toBe('credential_env_mismatch');
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

    it('are tested, and while the fake provider answers, are not said to work', async () => {
      const res = await portal('post', `/platform/ai/connections/${anthropic.id}/test`).send({ model: 'claude-haiku-5-5' }).expect(200);
      expect(res.body).toEqual({ works: null, credentialsPresent: true, mode: 'fake' });
      // Nothing was called: the fake says nothing of the connection.
      expect(fakeAi.calls).toHaveLength(0);
      await portal('post', `/platform/ai/connections/${anthropic.id}/test`).send({ model: 'gpt-9' }).expect(400, { code: 'unknown_model' });
      const [tested] = await bench.owner.db
        .select({ details: platformAuditLog.details })
        .from(platformAuditLog)
        .where(and(eq(platformAuditLog.action, 'ai_connection_tested'), sql`${platformAuditLog.details} ->> 'connectionId' = ${anthropic.id}`));
      expect(tested.details).toEqual({ connectionId: anthropic.id, model: 'claude-haiku-5-5', works: null, mode: 'fake' });
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
        platformAdminName: 'Staff',
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
      // Another credential is another account with the provider.
      await portal('patch', `/platform/ai/connections/${bedrock.id}`)
        .send({ credentialEnv: `${bedrockEnv}_OTHER` })
        .expect(409, { code: 'connection_in_use', tenantIds: [b.id] });
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
      expect(await ai.run(off, 'drafting', draftAsk('Hi'))).toEqual({ ok: false, code: 'ai_not_offered', feature: 'drafting', reason: 'module' });
      const bCaller = await callerOf(b);
      expect(await ai.run(bCaller, 'insights', ask('Hi'))).toMatchObject({ ok: false, code: 'ai_not_offered', reason: 'not_configured' });
      // Offered, but b has not switched AI on.
      expect(await ai.run(bCaller, 'drafting', draftAsk('Hi'))).toEqual({ ok: false, code: 'ai_switched_off', feature: 'drafting' });
      expect(fakeAi.calls).toHaveLength(0);
    });

    it('refuses everything while the client’s subscription is suspended, read afresh', async () => {
      const bCaller = await callerOf(b);
      await portal('patch', `/platform/tenants/${b.id}/subscription`).send({ status: 'suspended' }).expect(200);
      try {
        expect(await ai.run(bCaller, 'drafting', draftAsk('Hi'))).toEqual({ ok: false, code: 'subscription_suspended', feature: 'drafting' });
      } finally {
        await portal('patch', `/platform/tenants/${b.id}/subscription`).send({ status: 'active' }).expect(200);
      }
    });

    it('refuses a request too large to send, before anything is read, and a malformed one throws', async () => {
      const caller = await callerOf(a);
      expect(await ai.run(caller, 'assistant', ask('x'.repeat(MAX_MESSAGE_CHARS + 1)))).toEqual({
        ok: false,
        code: 'ai_request_too_large',
        feature: 'assistant',
        maxMessageChars: MAX_MESSAGE_CHARS,
        maxRequestChars: MAX_REQUEST_CHARS,
      });
      const third = 'x'.repeat(MAX_REQUEST_CHARS / 3);
      expect(
        await ai.run(caller, 'assistant', { ...ask(third), system: 'Be brief.', messages: [third, third, third].map((content) => ({ role: 'user' as const, content })) }),
      ).toMatchObject({ code: 'ai_request_too_large' });
      // A feature's own mistakes: no people list, a draft with no id or an id that is not one.
      await expect(ai.run(caller, 'assistant', { messages: [{ role: 'user', content: 'x' }], maxTokens: 10 } as unknown as AiRunRequest)).rejects.toThrow(/malformed/);
      await expect(ai.run(caller, 'drafting', ask('x'))).rejects.toThrow(/malformed/);
      await expect(ai.run(caller, 'drafting', ask('x', { unit: 'Fire procedure, Building A' }))).rejects.toThrow(/malformed/);
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
      const shape = z.object({ who: z.string(), steps: z.array(z.string()) });
      const res = await ai.run(await callerOf(a), 'drafting', draftAsk('Draft for Mariam Al-Khoury', randomUUID(), {
        tier: 'quick',
        people: ['Mariam Al-Khoury'],
        output: shape,
      }));
      expect(res).toMatchObject({ ok: true, model: 'claude-haiku-5-5', data: { who: 'Mariam Al-Khoury', steps: ['Call Mariam Al-Khoury'] } });
      expect(fakeAi.calls[0].request.output).toEqual({ schema: z.toJSONSchema(shape) });
    });

    it('treats an answer that does not fit the shape asked for as unavailable, and counts and costs it', async () => {
      fakeAi.respondWith(() => JSON.stringify({ who: 42 }));
      const res = await ai.run(await callerOf(a), 'assistant', ask('Give data', { output: z.object({ who: z.string() }) }));
      expect(res).toEqual({ ok: false, code: 'ai_unavailable', feature: 'assistant' });
      const [row] = await requestsOf(a.id);
      expect(row).toMatchObject({ outcome: 'failed', reason: 'invalid_output', counted: true, attempts: 1 });
      expect(row.costMicroUsd).toBeGreaterThan(0);
    });

    it('retries once a failure worth retrying, and not one that is not', async () => {
      const caller = await callerOf(a);
      fakeAi.respondWith((_, attempt) => {
        if (attempt === 1) throw new AiProviderError('overloaded');
        return 'fine';
      });
      expect(await ai.run(caller, 'assistant', ask('Hello'))).toMatchObject({ ok: true, text: 'fine' });
      const [ok] = await requestsOf(a.id);
      // Overloaded is refused before any work: the first attempt cost nothing.
      expect(ok).toMatchObject({ outcome: 'succeeded', attempts: 2 });
      expect(ok.costMicroUsd).toBe(Math.ceil(ok.inputTokens * 3 + ok.outputTokens * 15));

      // A server error may have been billed: recorded at the most an attempt can cost.
      fakeAi.reset();
      fakeAi.respondWith((_, attempt) => {
        if (attempt === 1) throw new AiProviderError('server');
        return 'fine';
      });
      expect(await ai.run(caller, 'assistant', ask('Hello'))).toMatchObject({ ok: true });
      const [billed] = await requestsOf(a.id);
      // "Hello": 2 tokens in at $3, 200 out at $15 a million, at most.
      expect(billed.costMicroUsd).toBe(2 * 3 + 200 * 15 + Math.ceil(billed.inputTokens * 3 + billed.outputTokens * 15));

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
      // Both attempts may have been billed: each at the most it could cost.
      expect((await requestsOf(a.id))[0]).toMatchObject({ outcome: 'failed', reason: 'timeout', attempts: 2, costMicroUsd: 2 * (2 * 3 + 200 * 15) });
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

    it('counts a draft once for up to twenty requests in a month, and again after them', async () => {
      const caller = await callerOf(a);
      // The quick request above opened one draft of the two allowed.
      const unit = randomUUID();
      for (let i = 0; i < 20; i++) expect([i, (await ai.run(caller, 'drafting', draftAsk(`Step ${i}`, unit))).ok]).toEqual([i, true]);
      const steps = (await requestsOf(a.id)).filter((r) => r.feature === 'drafting' && r.unitKey === unit);
      expect(steps.filter((r) => r.counted)).toHaveLength(1);
      // The twenty-first would open a third draft: over the allowance of two.
      expect(await ai.run(caller, 'drafting', draftAsk('Step 21', unit))).toMatchObject({ ok: false, code: 'ai_allowance_reached', allowance: 2 });
      expect(await ai.run(caller, 'drafting', draftAsk('Another document'))).toMatchObject({ code: 'ai_allowance_reached' });
    });

    it('counts a draft again in a new month', async () => {
      const c = await bench.createHospital('m', { timeZone: 'Asia/Dubai' });
      await portal('patch', `/platform/tenants/${c.id}/subscription`).send({ planId }).expect(200);
      await configure(c, { offered: true, features: allFeatures(anthropic.id) }).expect(200);
      await http().put('/ai/settings').set('Cookie', c.cookie).send({ enabled: true }).expect(200);
      const caller = await callerOf(c);
      const unit = randomUUID();
      // The draft was opened, and counted, in an earlier month.
      await bench.owner.db.insert(aiRequests).values({
        tenantId: c.id, feature: 'drafting', connectionId: anthropic.id, model: 'claude-sonnet-5-5', month: '2000-01',
        unitKey: unit, counted: true, outcome: 'succeeded', finishedAt: new Date(),
      });
      expect(await ai.run(caller, 'drafting', draftAsk('Carry on', unit))).toMatchObject({ ok: true });
      const [row] = await requestsOf(c.id);
      expect(row).toMatchObject({ unitKey: unit, counted: true, month: monthOf(new Date(), 'Asia/Dubai') });
      expect((await settingsOf(c.cookie).expect(200)).body.features[0]).toMatchObject({ feature: 'drafting', used: 1 });
    });

    it('lets a request be finished once, and never rewritten after', async () => {
      const [done] = await requestsOf(a.id);
      expect(done.outcome).not.toBe('pending');
      await expect(
        bench.app.get(TenantDb).withTenant(a.id, (tx) => tx.update(aiRequests).set({ outcome: 'failed', costMicroUsd: 0 }).where(eq(aiRequests.id, done.id))),
      ).rejects.toMatchObject({ cause: { code: '23514' } });
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
      // The platform-wide limit is shared by every client on this database:
      // start from whatever it holds now, and put it back afterwards.
      const before = (await portal('get', '/platform/ai/settings').expect(200)).body.monthlySpendingLimitUsd ?? null;
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
        expect(entry.details).toEqual({ monthlySpendingLimitUsd: { from: before, to: 0.01 } });
      } finally {
        await portal('put', '/platform/ai/settings').send({ monthlySpendingLimitUsd: before }).expect(200);
      }
      await portal('put', '/platform/ai/settings').send({ monthlySpendingLimitUsd: -1 }).expect(400);
    });

    it('fails a test that would reach a real provider, rather than calling it unavailable', async () => {
      const real = { mode: 'real', credentialsPresent: () => true, for: () => new AnthropicProvider('sk-test') } as unknown as AiProviders;
      const service = new AiService(bench.app.get(TenantDb), real, bench.app.get(AccessService), bench.app.get(EntitlementsService));
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
      expect(await ai.run(await callerOf(a), 'drafting', draftAsk('Hi'))).toMatchObject({ code: 'ai_not_offered', reason: 'not_offered' });
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
