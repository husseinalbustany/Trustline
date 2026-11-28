import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { asc, eq, gte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  assertConnection,
  createConnectionSchema,
  platformAiSchema,
  testConnectionSchema,
  updateConnectionSchema,
} from '../ai/ai-input.js';
import { withTimeout } from '../ai/ai.service.js';
import {
  connectionColumns,
  costs,
  microUsd,
  monthOf,
  readClientAi,
  usageOf,
  usd,
  utcMonthStart,
  type ConnectionRow,
} from '../ai/client-ai.js';
import { AI_FEATURES, WARNING_SHARE } from '../ai/features.js';
import { RealProviderUnderTestError } from '../ai/provider.js';
import { AiProviders } from '../ai/providers.js';
import type { Database, Transaction } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import { pgErrorCode } from '../database/errors.js';
import {
  aiClientFeatures,
  aiClientSettings,
  aiPlatformSettings,
  aiProviderConnections,
  aiRequests,
  tenants,
} from '../database/schema.js';
import { ForModule } from '../subscriptions/module.decorator.js';
import {
  PlatformAuthGuard,
  type PlatformRequest,
} from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';

/** The fields of a connection whose change the platform log records. */
const CONNECTION_FIELDS = ['name', 'region', 'inferenceType', 'models', 'credentialEnv', 'active'] as const;

/** How long the test of a connection waits for its tiny answer. */
const TEST_TIMEOUT_MS = 20_000;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Trustline's AI provider connections, its own AI settings, and every
 * client's AI usage, for its staff (docs/specs/ai-providers-and-
 * allowances.md, "Providers"). A connection holds where it processes
 * requests and the models it offers, and names the environment variable
 * its credential is in: the credential itself is never stored, typed in
 * or shown, only whether it is present. Every change is written to the
 * platform audit log in the same transaction. A connection is deactivated,
 * never deleted.
 */
@Controller('platform/ai')
@UseGuards(PlatformAuthGuard)
@ForModule('core')
export class PlatformAiController {
  private readonly logger = new Logger('PlatformAi');

  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly auth: PlatformAuthService,
    private readonly providers: AiProviders,
  ) {}

  /** Every connection, inactive ones too, with how many clients use each. */
  @Get('connections')
  async list() {
    const rows = await this.db
      .select({ ...connectionColumns, createdAt: aiProviderConnections.createdAt, updatedAt: aiProviderConnections.updatedAt })
      .from(aiProviderConnections)
      .orderBy(asc(aiProviderConnections.name));
    const uses = await this.db
      .select({ connectionId: aiClientFeatures.connectionId, clients: sql<number>`count(distinct ${aiClientFeatures.tenantId})::int` })
      .from(aiClientFeatures)
      .groupBy(aiClientFeatures.connectionId);
    return rows.map((row) => this.shown(row, uses.find((u) => u.connectionId === row.id)?.clients ?? 0));
  }

  @Get('connections/:id')
  async get(@Param('id') id: string) {
    return this.one(this.db, this.parseId(id));
  }

  /** 409 `name_taken`; 400 with a code when it would not say truly where it processes. */
  @Post('connections')
  async create(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = createConnectionSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    assertConnection(parsed.data);
    try {
      return await this.db.transaction(async (tx) => {
        const [created] = await tx.insert(aiProviderConnections).values(parsed.data).returning({ id: aiProviderConnections.id });
        const { kind, name, region, inferenceType, models, credentialEnv, active } = parsed.data;
        await this.auth.audit(
          req.platformAdmin.id,
          'ai_connection_created',
          null,
          { connectionId: created.id, name, kind, region, inferenceType, models, credentialEnv, active },
          tx,
        );
        return this.one(tx, created.id);
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw new ConflictException({ code: 'name_taken' });
      throw e;
    }
  }

  /**
   * Edits a connection, or deactivates it (`active: false`) or activates it
   * again. While a client uses it, where it processes cannot change, it
   * cannot be deactivated (409 `connection_in_use`, with the `tenantIds`),
   * and no model a client uses can be taken off it (409 `model_in_use`):
   * the client would be served from elsewhere than it was told. Move the
   * clients first.
   */
  @Patch('connections/:id')
  async update(@Param('id') id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const connectionId = this.parseId(id);
    const parsed = updateConnectionSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) throw new BadRequestException();
    try {
      return await this.db.transaction(async (tx) => {
        const [current] = await tx
          .select(connectionColumns)
          .from(aiProviderConnections)
          .where(eq(aiProviderConnections.id, connectionId))
          .for('update');
        if (!current) throw new NotFoundException();
        const next = { ...current, ...parsed.data };
        assertConnection(next);
        const using = await tx
          .select({ tenantId: aiClientFeatures.tenantId, model: aiClientFeatures.model, quickModel: aiClientFeatures.quickModel })
          .from(aiClientFeatures)
          .where(eq(aiClientFeatures.connectionId, connectionId));
        if (using.length > 0) {
          const tenantIds = [...new Set(using.map((u) => u.tenantId))];
          if (next.region !== current.region || next.inferenceType !== current.inferenceType || !next.active) {
            throw new ConflictException({ code: 'connection_in_use', tenantIds });
          }
          const kept = new Set(next.models.map((m) => m.id));
          for (const use of using) {
            for (const model of [use.model, use.quickModel]) {
              if (model && !kept.has(model)) {
                throw new ConflictException({
                  code: 'model_in_use',
                  model,
                  tenantIds: [...new Set(using.filter((u) => u.model === model || u.quickModel === model).map((u) => u.tenantId))],
                });
              }
            }
          }
        }
        const changes = Object.fromEntries(
          CONNECTION_FIELDS.filter((key) => !same(current[key], next[key])).map((key) => [key, { from: current[key], to: next[key] }]),
        );
        if (Object.keys(changes).length > 0) {
          await tx
            .update(aiProviderConnections)
            .set({ ...parsed.data, updatedAt: new Date() })
            .where(eq(aiProviderConnections.id, connectionId));
          await this.auth.audit(req.platformAdmin.id, 'ai_connection_updated', null, { connectionId, changes }, tx);
        }
        return this.one(tx, connectionId);
      });
    } catch (e) {
      if (pgErrorCode(e) === '23505') throw new ConflictException({ code: 'name_taken' });
      throw e;
    }
  }

  /**
   * A tiny call through the connection (the fake provider's, unless real
   * providers are switched on), to the model named or the first it offers
   * (400 `unknown_model`): it says only whether it works and whether the
   * credential is present, never why it failed. Audited.
   */
  @Post('connections/:id/test')
  @HttpCode(200)
  async test(@Param('id') id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const connectionId = this.parseId(id);
    const parsed = testConnectionSchema.safeParse(body ?? undefined);
    if (!parsed.success) throw new BadRequestException();
    const [connection] = await this.db.select(connectionColumns).from(aiProviderConnections).where(eq(aiProviderConnections.id, connectionId));
    if (!connection) throw new NotFoundException();
    const model = parsed.data.model ?? connection.models[0]?.id;
    if (!model || !connection.models.some((m) => m.id === model)) {
      throw new BadRequestException({ code: 'unknown_model' });
    }
    const credentialsPresent = this.providers.credentialsPresent(connection.credentialEnv);
    let works = false;
    try {
      const provider = this.providers.for(connection);
      const answer = await withTimeout(
        provider,
        { model, messages: [{ role: 'user', content: 'Reply with the word OK.' }], maxTokens: 5 },
        TEST_TIMEOUT_MS,
      );
      works = typeof answer.text === 'string';
    } catch (e) {
      if (e instanceof RealProviderUnderTestError) throw e;
      this.logger.warn(`Test of AI connection ${connectionId} failed`);
    }
    await this.auth.audit(req.platformAdmin.id, 'ai_connection_tested', null, { connectionId, model, works });
    return { works, credentialsPresent };
  }

  /**
   * Trustline's own AI settings: the spending limit over every client
   * together in the UTC month, what has been spent of it, and whether
   * requests go to the real providers or the fake one.
   */
  @Get('settings')
  async settings() {
    return this.settingsView(this.db);
  }

  @Put('settings')
  async setSettings(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = platformAiSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const limit = microUsd(parsed.data.monthlySpendingLimitUsd);
    return this.db.transaction(async (tx) => {
      await tx.insert(aiPlatformSettings).values({ id: true }).onConflictDoNothing();
      const [current] = await tx.select().from(aiPlatformSettings).for('update');
      if (current.monthlySpendingLimitMicroUsd !== limit) {
        await tx
          .update(aiPlatformSettings)
          .set({ monthlySpendingLimitMicroUsd: limit, updatedBy: req.platformAdmin.id, updatedAt: new Date() })
          .where(eq(aiPlatformSettings.id, true));
        await this.auth.audit(
          req.platformAdmin.id,
          'ai_platform_settings_updated',
          null,
          { monthlySpendingLimitUsd: { from: usd(current.monthlySpendingLimitMicroUsd), to: usd(limit) } },
          tx,
        );
      }
      return this.settingsView(tx);
    });
  }

  /**
   * Every client Trustline has set up for AI or that used it this month:
   * whether it is offered and switched on, each feature's use against its
   * allowance in the client's month, and its cost beside it. Those close
   * to an allowance (80%) or over one come first.
   */
  @Get('usage')
  async usage() {
    const now = new Date();
    const clients = await this.db
      .selectDistinct({ id: tenants.id, slug: tenants.slug, name: tenants.name, timeZone: tenants.timeZone })
      .from(tenants)
      .leftJoin(aiClientSettings, eq(aiClientSettings.tenantId, tenants.id))
      .leftJoin(aiRequests, eq(aiRequests.tenantId, tenants.id))
      .where(or(sql`${aiClientSettings.tenantId} is not null`, gte(aiRequests.createdAt, new Date(now.getTime() - 32 * 86_400_000))));
    const out = [];
    for (const client of clients) {
      const month = monthOf(now, client.timeZone);
      const ai = await readClientAi(this.db, client.id);
      const used = await usageOf(this.db, client.id, month);
      const features = Object.fromEntries(
        AI_FEATURES.map((f) => {
          const allowance = ai.allowances[f];
          const { used: n, costMicroUsd } = used.byFeature[f];
          return [f, { configured: !!ai.features[f], allowance, used: n, costUsd: usd(costMicroUsd) }];
        }),
      );
      const near = AI_FEATURES.some((f) => {
        const a = ai.allowances[f];
        return a !== null && a > 0 && used.byFeature[f].used >= Math.ceil(a * WARNING_SHARE);
      });
      const over =
        AI_FEATURES.some((f) => ai.allowances[f] !== null && ai.allowances[f]! > 0 && used.byFeature[f].used >= ai.allowances[f]!) ||
        (ai.settings?.monthlySpendingLimitMicroUsd != null && used.costMicroUsd >= ai.settings.monthlySpendingLimitMicroUsd);
      out.push({
        tenantId: client.id,
        slug: client.slug,
        name: client.name,
        month,
        offered: ai.settings?.offered ?? false,
        enabled: ai.settings?.clientEnabled ?? false,
        features,
        costUsd: usd(used.costMicroUsd),
        monthlySpendingLimitUsd: usd(ai.settings?.monthlySpendingLimitMicroUsd ?? null),
        near,
        over,
      });
    }
    return out.sort((a, b) => Number(b.over) - Number(a.over) || Number(b.near) - Number(a.near) || a.slug.localeCompare(b.slug));
  }

  private async settingsView(db: Database | Transaction) {
    const [row] = await db.select().from(aiPlatformSettings);
    const since = utcMonthStart(new Date());
    const [{ spent }] = await db
      .select({ spent: sql<string>`coalesce(sum(${aiRequests.costMicroUsd}), 0)::bigint` })
      .from(aiRequests)
      .where(sql`${aiRequests.createdAt} >= ${since.toISOString()}::timestamptz and ${costs}`);
    return {
      monthlySpendingLimitUsd: usd(row?.monthlySpendingLimitMicroUsd ?? null),
      month: since.toISOString().slice(0, 7),
      spentUsd: usd(Number(spent)),
      mode: this.providers.mode,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  private async one(db: Database | Transaction, id: string) {
    const [row] = await db
      .select({ ...connectionColumns, createdAt: aiProviderConnections.createdAt, updatedAt: aiProviderConnections.updatedAt })
      .from(aiProviderConnections)
      .where(eq(aiProviderConnections.id, id));
    if (!row) throw new NotFoundException();
    const [{ clients }] = await db
      .select({ clients: sql<number>`count(distinct ${aiClientFeatures.tenantId})::int` })
      .from(aiClientFeatures)
      .where(eq(aiClientFeatures.connectionId, id));
    return this.shown(row, clients);
  }

  /** A connection as the portal shows it: whether its credential is present, never its value. */
  private shown(row: ConnectionRow & { createdAt: Date; updatedAt: Date }, clients: number) {
    return { ...row, credentialsPresent: this.providers.credentialsPresent(row.credentialEnv), clients };
  }

  private parseId(id: string) {
    const parsed = z.uuid().safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    return parsed.data;
  }
}
