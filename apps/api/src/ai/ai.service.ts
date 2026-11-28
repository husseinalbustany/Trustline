import {
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  aiPlatformSettings,
  aiRequests,
  aiUsageNotices,
  notifications,
  users,
  type AiModel,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { AccessService } from '../identity/access.service.js';
import type { ModuleCode } from '../subscriptions/modules.js';
import { failureOf } from './anthropic-provider.js';
import {
  costs,
  live,
  monthOf,
  nextMonthStarts,
  offerOf,
  readClientAi,
  utcMonthStart,
  type ConnectionRow,
  type NotOfferedReason,
} from './client-ai.js';
import { REVISIONS_PER_DRAFT, WARNING_SHARE, type AiFeature } from './features.js';
import {
  AiProviderError,
  parseStructured,
  RealProviderUnderTestError,
  type AiProvider,
  type ProviderFailure,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResult,
} from './provider.js';
import { AiProviders } from './providers.js';
import { NameIndex, Redaction } from './redaction.js';

/** Who a request is made for: the client, and the person if there is one. */
export type AiCaller = {
  tenant: { id: string; timeZone: string; modules: readonly ModuleCode[] };
  /** Null for what runs without a person (a scheduled check). */
  user: { id: string } | null;
};

/** What a feature asks. The text is the feature's; nothing of it is kept. */
export type AiRunRequest = {
  system?: string;
  messages: ProviderMessage[];
  /** The longest answer, in tokens. */
  maxTokens: number;
  /** `quick`: the feature's quick model, where Trustline set one. */
  tier?: 'standard' | 'quick';
  /** A JSON schema the answer must follow; the answer is then `data`. */
  output?: { schema: Record<string, unknown> };
  /**
   * Names to remove besides the client's users': the people a record
   * names (a patient, a reporter, a witness), in whatever language.
   */
  people?: string[];
  /**
   * Drafting: the conversation this request belongs to (the draft's own
   * id), so that its questions, the draft and up to five revisions count
   * as one draft. Ignored by the other features, where every request
   * counts once.
   */
  unit?: string;
  /** Drafting: whether this request revises the draft. */
  revision?: boolean;
  /** How long one attempt may take, in milliseconds. 60 seconds unless set. */
  timeoutMs?: number;
};

export type AiRefusalCode =
  | 'ai_not_offered'
  | 'ai_switched_off'
  | 'ai_allowance_reached'
  | 'ai_spending_limit'
  | 'ai_unavailable';

export type AiRefusal = {
  ok: false;
  code: AiRefusalCode;
  feature: AiFeature;
  /** `ai_not_offered`: why. */
  reason?: NotOfferedReason;
  /** `ai_allowance_reached`: the allowance, and the day it starts again. */
  allowance?: number;
  resetsOn?: string;
};

export type AiSuccess = {
  ok: true;
  /** The record of the request (`ai_requests`), for the feature to keep. */
  requestId: string;
  /** The answer, with every name and identifier put back. */
  text: string;
  /** The answer as data, put back the same way, when a schema was given. */
  data?: unknown;
  /** The provider's id of the model that answered. */
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type AiRunResult = AiSuccess | AiRefusal;

/** The HTTP answer for a refusal, for a feature's route to throw. */
export function aiRefusalException(refusal: AiRefusal) {
  const { ok: _ok, ...body } = refusal;
  return refusal.code === 'ai_unavailable'
    ? new ServiceUnavailableException(body)
    : new ConflictException(body);
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
/** Before the one retry of an attempt that failed in a way worth retrying. */
export const RETRY_DELAY_MS = 500;
const MAX_TEXT = 400_000;

/** A lock held to the end of the transaction, by name. */
const lock = (tx: Transaction, name: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);

/** The most a request can cost: a generous count of what is sent, and the longest answer. */
function reservation(request: AiRunRequest, prices: AiModel | undefined) {
  if (!prices) return 0;
  const chars = [request.system ?? '', ...request.messages.map((m) => m.content)].reduce((n, t) => n + t.length, 0);
  // Three characters a token, which over-counts most text.
  return costOf({ inputTokens: Math.ceil(chars / 3), outputTokens: request.maxTokens }, prices);
}

/** What a call cost, in millionths of a dollar, at the model's prices. */
export function costOf(usage: { inputTokens: number; outputTokens: number }, prices: AiModel | undefined) {
  if (!prices) return 0;
  return Math.ceil(usage.inputTokens * prices.inputUsdPerMTok + usage.outputTokens * prices.outputUsdPerMTok);
}

/** A feature's mistake in what it asks: never the person's, so it throws. */
function assertRequest(request: AiRunRequest) {
  const texts = [request.system ?? '', ...request.messages.map((m) => m.content)];
  if (
    request.messages.length === 0 ||
    request.messages.some((m) => (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') ||
    texts.reduce((n, t) => n + t.length, 0) > MAX_TEXT ||
    !Number.isInteger(request.maxTokens) ||
    request.maxTokens < 1 ||
    request.maxTokens > 64_000 ||
    (request.timeoutMs !== undefined && (request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS)) ||
    (request.unit !== undefined && (request.unit.length < 1 || request.unit.length > 200)) ||
    (request.people?.length ?? 0) > 1000
  ) {
    throw new Error('AiService.run: the request is malformed');
  }
}

type Admitted = {
  ok: true;
  requestId: string;
  connection: ConnectionRow;
  model: string;
  prices: AiModel | undefined;
  people: string[];
};

/**
 * The single entry point of every AI feature
 * (docs/specs/ai-providers-and-allowances.md). `run()`:
 *
 * 1. checks, in one transaction of the client's: the AI module and the
 *    module the feature assists, that Trustline offers the feature and has
 *    configured it, the client's own switch, the allowance, and the
 *    client's and the platform's spending limits; and records the request
 *    as under way, with the most it can cost, so that two requests can
 *    never both take the last of an allowance or a limit;
 * 2. removes the names of the client's people and those the feature
 *    passes in, and identifiers, from every text;
 * 3. calls the provider, with a timeout, and once more after a failure
 *    worth retrying;
 * 4. puts the names back in the answer;
 * 5. records how the request ended: its size, its cost, its outcome;
 * 6. returns the answer, or a refusal with a code.
 *
 * A provider's failure never throws: the feature gets `ai_unavailable`, and
 * everything else goes on. Only a fault of the code throws.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger('AiService');

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly providers: AiProviders,
    private readonly access: AccessService,
  ) {}

  async run(caller: AiCaller, feature: AiFeature, request: AiRunRequest): Promise<AiRunResult> {
    assertRequest(request);
    const tenantId = caller.tenant.id;
    const month = monthOf(new Date(), caller.tenant.timeZone);
    const admitted = await this.tenantDb.withTenant(tenantId, (tx) =>
      this.admit(tx, caller, feature, request, month),
    );
    if (!admitted.ok) return admitted;

    // Names out. The mapping lives in this object, for this request only.
    const redaction = new Redaction(new NameIndex([...admitted.people, ...(request.people ?? [])]));
    redaction.reserve([request.system ?? '', ...request.messages.map((m) => m.content)]);
    const sent: ProviderRequest = {
      model: admitted.model,
      ...(request.system && { system: redaction.redact(request.system) }),
      messages: request.messages.map((m) => ({ role: m.role, content: redaction.redact(m.content) })),
      maxTokens: request.maxTokens,
      ...(request.output && { output: request.output }),
    };

    const attempts = { n: 0 };
    let result: ProviderResult | null = null;
    let data: unknown;
    let failure: ProviderFailure | null = null;
    try {
      const provider = this.providers.for(admitted.connection);
      result = await this.call(provider, sent, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, attempts);
      if (request.output) data = redaction.restoreDeep(parseStructured(result.text));
    } catch (e) {
      if (e instanceof RealProviderUnderTestError) throw e;
      failure = e instanceof AiProviderError ? e.failure : failureOf(e);
    }

    const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0 };
    await this.finish(tenantId, admitted.requestId, {
      outcome: failure ? 'failed' : 'succeeded',
      reason: failure,
      attempts: attempts.n,
      ...usage,
      costMicroUsd: costOf(usage, admitted.prices),
    });

    if (failure || !result) {
      // The kind only: a provider's message can quote the request.
      this.logger.warn(`AI request ${admitted.requestId} of client ${tenantId} failed: ${failure}`);
      return { ok: false, code: 'ai_unavailable', feature };
    }
    return {
      ok: true,
      requestId: admitted.requestId,
      text: redaction.restore(result.text),
      ...(request.output && { data }),
      model: admitted.model,
      usage,
    };
  }

  /** One attempt, and one more if the first failed in a way worth retrying. */
  private async call(provider: AiProvider, request: ProviderRequest, timeoutMs: number, attempts: { n: number }) {
    for (;;) {
      attempts.n++;
      try {
        return await withTimeout(provider, request, timeoutMs);
      } catch (e) {
        if (e instanceof RealProviderUnderTestError) throw e;
        const error = e instanceof AiProviderError ? e : new AiProviderError(failureOf(e));
        if (attempts.n === 1 && error.retryable) {
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          continue;
        }
        throw error;
      }
    }
  }

  private async admit(
    tx: Transaction,
    caller: AiCaller,
    feature: AiFeature,
    request: AiRunRequest,
    month: string,
  ): Promise<Admitted | AiRefusal> {
    const tenantId = caller.tenant.id;
    const client = await readClientAi(tx, tenantId);
    const offer = offerOf(client, caller.tenant.modules, feature);
    if (!offer.offered) return { ok: false, code: 'ai_not_offered', feature, reason: offer.reason };
    if (!client.settings!.clientEnabled) return { ok: false, code: 'ai_switched_off', feature };

    const choice = client.features[feature]!;
    const model = request.tier === 'quick' ? (choice.quickModel ?? choice.model) : choice.model;
    const prices = choice.connection.models.find((m) => m.id === model);
    const allowance = client.allowances[feature];
    const unitKey = feature === 'drafting' ? (request.unit ?? null) : null;
    const revision = feature === 'drafting' && request.revision === true;
    const base = {
      tenantId,
      feature,
      connectionId: choice.connection.id,
      model,
      userId: caller.user?.id ?? null,
      month,
      unitKey,
      revision,
    };
    const refuse = async (reason: 'allowance_reached' | 'spending_limit', counted: boolean) => {
      await tx.insert(aiRequests).values({ ...base, counted, outcome: 'refused', reason, finishedAt: new Date() });
    };

    // Allowance: one request at a time per client and feature, from here
    // to the end of the transaction, so that the count is right.
    await lock(tx, `trustline.ai.allowance.${tenantId}.${feature}`);
    const counted = await this.counts(tx, feature, unitKey, revision);
    let used = 0;
    if (counted && allowance !== null) {
      used = await this.used(tx, month, feature);
      if (used >= allowance) {
        await this.notice(tx, tenantId, month, feature, 'reached', used, allowance);
        await refuse('allowance_reached', counted);
        return { ok: false, code: 'ai_allowance_reached', feature, allowance, resetsOn: nextMonthStarts(month) };
      }
    }

    // Spending: what the client's requests cost this month, and every
    // client's this month in UTC, with this one at its most.
    const reserved = reservation(request, prices);
    const clientLimit = client.settings!.monthlySpendingLimitMicroUsd;
    if (clientLimit !== null) {
      await lock(tx, `trustline.ai.spend.${tenantId}`);
      const [{ spent }] = await tx
        .select({ spent: sql<string>`coalesce(sum(${aiRequests.costMicroUsd}), 0)::bigint` })
        .from(aiRequests)
        .where(and(eq(aiRequests.month, month), costs));
      if (Number(spent) + reserved > clientLimit) {
        await this.reportSpending(tx, tenantId, 'client', month);
        await refuse('spending_limit', counted);
        return { ok: false, code: 'ai_spending_limit', feature };
      }
    }
    const [platform] = await tx
      .select({ limit: aiPlatformSettings.monthlySpendingLimitMicroUsd })
      .from(aiPlatformSettings);
    if (platform?.limit !== null && platform?.limit !== undefined) {
      await lock(tx, 'trustline.ai.spend.platform');
      const since = utcMonthStart(new Date());
      const { rows } = await tx.execute<{ spent: string }>(sql`select ai_platform_spend_since(${since.toISOString()}::timestamptz) as spent`);
      if (Number(rows[0].spent) + reserved > platform.limit) {
        await this.reportSpending(tx, tenantId, 'platform', since.toISOString().slice(0, 7));
        await refuse('spending_limit', counted);
        return { ok: false, code: 'ai_spending_limit', feature };
      }
    }

    const [row] = await tx
      .insert(aiRequests)
      .values({ ...base, counted, outcome: 'pending', attempts: 0, costMicroUsd: reserved })
      .returning({ id: aiRequests.id });

    if (counted && allowance !== null && allowance > 0) {
      const after = used + 1;
      if (after >= Math.ceil(allowance * WARNING_SHARE)) {
        await this.notice(tx, tenantId, month, feature, 'warning', after, allowance);
      }
      if (after >= allowance) await this.notice(tx, tenantId, month, feature, 'reached', after, allowance);
    }

    // The client's people, in every language their names are written in.
    const people = (await tx.select({ name: users.name }).from(users)).flatMap((u) =>
      Object.values(u.name).filter((n): n is string => typeof n === 'string'),
    );
    return { ok: true, requestId: row.id, connection: choice.connection, model, prices, people };
  }

  /**
   * Whether this request opens a unit of the allowance. A suggestion and
   * an assistant message: every request. A draft: the first request of its
   * conversation, and after five revisions the next revision, which opens
   * another draft. A conversation keeps counting from the month it was
   * opened in; one whose opening failed opens again.
   */
  private async counts(tx: Transaction, feature: AiFeature, unitKey: string | null, revision: boolean) {
    if (feature !== 'drafting' || unitKey === null) return true;
    const [opened] = await tx
      .select({ createdAt: aiRequests.createdAt })
      .from(aiRequests)
      .where(and(eq(aiRequests.feature, 'drafting'), eq(aiRequests.unitKey, unitKey), eq(aiRequests.counted, true), live))
      .orderBy(desc(aiRequests.createdAt))
      .limit(1);
    if (!opened) return true;
    if (!revision) return false;
    const [{ revisions }] = await tx
      .select({ revisions: count() })
      .from(aiRequests)
      .where(
        and(
          eq(aiRequests.feature, 'drafting'),
          eq(aiRequests.unitKey, unitKey),
          eq(aiRequests.revision, true),
          gte(aiRequests.createdAt, opened.createdAt),
          live,
        ),
      );
    return revisions >= REVISIONS_PER_DRAFT;
  }

  /** The units of a feature's allowance used in the month. */
  private async used(tx: Transaction, month: string, feature: AiFeature) {
    const [{ used }] = await tx
      .select({ used: count() })
      .from(aiRequests)
      .where(and(eq(aiRequests.month, month), eq(aiRequests.feature, feature), eq(aiRequests.counted, true), live));
    return used;
  }

  /**
   * Tells the client's administrators (who hold `settings.manage` for the
   * whole organization), once a month per feature, that 80% of its
   * allowance is used, or all of it.
   */
  private async notice(
    tx: Transaction,
    tenantId: string,
    month: string,
    feature: AiFeature,
    level: 'warning' | 'reached',
    used: number,
    allowance: number,
  ) {
    const [first] = await tx
      .insert(aiUsageNotices)
      .values({ tenantId, month, feature, level })
      .onConflictDoNothing()
      .returning({ level: aiUsageNotices.level });
    if (!first) return;
    const holders = await this.access.holders(tx, ['settings.manage'], []);
    const to = [...holders.everywhere('settings.manage')];
    if (to.length === 0) return;
    await tx.insert(notifications).values(
      to.map((userId) => ({
        tenantId,
        userId,
        kind: level === 'warning' ? ('ai_allowance_warning' as const) : ('ai_allowance_reached' as const),
        data: { feature, used, allowance, month, resetsOn: nextMonthStarts(month), serious: false },
      })),
    );
  }

  /**
   * Tells Trustline's staff, in the platform's own log, once a month, that
   * a spending limit stopped requests: the client's, or the platform's.
   */
  private async reportSpending(tx: Transaction, tenantId: string, scope: 'client' | 'platform', month: string) {
    this.logger.warn(`AI requests stopped by the ${scope} spending limit (client ${tenantId}, ${month})`);
    await tx.execute(sql`select ai_report_spending_limit(${tenantId}::uuid, ${scope}, ${month})`);
  }

  /** Records how a request ended. A failure to record never hides the answer. */
  private async finish(
    tenantId: string,
    requestId: string,
    end: {
      outcome: 'succeeded' | 'failed';
      reason: ProviderFailure | null;
      attempts: number;
      inputTokens: number;
      outputTokens: number;
      costMicroUsd: number;
    },
  ) {
    try {
      await this.tenantDb.withTenant(tenantId, (tx) =>
        tx
          .update(aiRequests)
          .set({ ...end, finishedAt: new Date() })
          .where(eq(aiRequests.id, requestId)),
      );
    } catch {
      // Left pending, it stops counting after PENDING_STALE_MINUTES.
      this.logger.error(`AI request ${requestId} of client ${tenantId} could not be recorded as ended`);
    }
  }
}

/** One call, given up after `timeoutMs` whatever the provider does. */
export async function withTimeout(provider: AiProvider, request: ProviderRequest, timeoutMs: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiProviderError('timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([provider.complete(request, { timeoutMs, signal: controller.signal }), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}
