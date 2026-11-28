import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
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
import { allows, EntitlementsService } from '../subscriptions/entitlements.service.js';
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
import { REQUESTS_PER_DRAFT, WARNING_SHARE, type AiFeature } from './features.js';
import {
  AiProviderError,
  parseStructured,
  RealProviderUnderTestError,
  type AiProvider,
  type ProviderFailure,
  type ProviderMessage,
  type ProviderRequest,
  type ProviderResult,
  type ProviderUsage,
} from './provider.js';
import { AiProviders } from './providers.js';
import { NameIndex, Redaction } from './redaction.js';

/**
 * Who a request is made for: the client, and the person if there is one.
 * What the client may use is read afresh by `run()`, never taken from here.
 */
export type AiCaller = {
  tenant: { id: string; timeZone: string };
  /** Null for what runs without a person (a scheduled check). */
  user: { id: string } | null;
};

/** What a feature asks. The text is the feature's; nothing of it is kept. */
export type AiRunRequest<T = unknown> = {
  /**
   * The feature's instructions. Record text belongs in the messages,
   * wrapped with `asData()` (ai/prompt.ts), never here.
   */
  system?: string;
  messages: ProviderMessage[];
  /** The longest answer, in tokens. */
  maxTokens: number;
  /** `quick`: the feature's quick model, where Trustline set one. */
  tier?: 'standard' | 'quick';
  /**
   * The shape the answer must have, when the feature needs data: sent to
   * the provider as a JSON schema, and checked on the answer, names put
   * back, before it is returned as `data`. An answer that does not fit
   * fails as `invalid_output` (`ai_unavailable`).
   */
  output?: z.ZodType<T>;
  /**
   * Every person a record sent in this request names, in whatever language
   * and field: the patient, the reporter, witnesses, relatives, staff.
   * Required (an empty list where the request holds no record): name
   * removal knows the client's users, and the names a title or a word for
   * a relationship announces, but no other name (the spec, "Limits of
   * name removal").
   */
  people: string[];
  /**
   * Drafting only, and required there: the id (a UUID) of the draft this
   * request belongs to, so that its questions, the draft and its revisions
   * count as one draft, up to REQUESTS_PER_DRAFT requests in a month.
   */
  unit?: string;
  /** How long one attempt may take, in milliseconds. 60 seconds unless set. */
  timeoutMs?: number;
};

export type AiRefusalCode =
  | 'ai_not_offered'
  | 'ai_switched_off'
  | 'ai_allowance_reached'
  | 'ai_spending_limit'
  | 'ai_request_too_large'
  | 'subscription_suspended'
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
  /** `ai_request_too_large`: the limits, in characters. */
  maxMessageChars?: number;
  maxRequestChars?: number;
};

export type AiSuccess<T = unknown> = {
  ok: true;
  /** The record of the request (`ai_requests`), for the feature to keep. */
  requestId: string;
  /** The answer, with every name and identifier put back. Untrusted text. */
  text: string;
  /** The answer as data, checked against `output`, names put back. */
  data?: T;
  /** The provider's id of the model that answered. */
  model: string;
  usage: { inputTokens: number; outputTokens: number };
};

export type AiRunResult<T = unknown> = AiSuccess<T> | AiRefusal;

/** The HTTP answer for a refusal, for a feature's route to throw. */
export function aiRefusalException(refusal: AiRefusal) {
  const { ok: _ok, ...body } = refusal;
  switch (refusal.code) {
    case 'ai_unavailable':
      return new ServiceUnavailableException(body);
    case 'ai_request_too_large':
      return new BadRequestException(body);
    case 'subscription_suspended':
      return new ForbiddenException(body);
    default:
      return new ConflictException(body);
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
/** Before the one retry of an attempt that failed in a way worth retrying. */
export const RETRY_DELAY_MS = 500;
/** One attempt and one retry. */
export const MAX_ATTEMPTS = 2;
/**
 * The longest message, and the longest request (the system text and every
 * message), in characters (security review 13, H1). A feature keeps what
 * it sends within these; one that does not is refused with
 * `ai_request_too_large`, before anything is read or sent.
 */
export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_REQUEST_CHARS = 60_000;
const MAX_PEOPLE = 2_000;
const MAX_PERSON_CHARS = 200;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The failures after which the provider may still have billed the attempt:
 * it may have done the work and the answer been lost. Recorded at the most
 * the attempt could cost (security review 13, M3). The others (refused
 * before any work: rate limited, overloaded, credentials, a bad request)
 * cost nothing.
 */
const MAYBE_BILLED: ReadonlySet<ProviderFailure> = new Set(['timeout', 'connection', 'server', 'other']);

/** A lock held to the end of the transaction, by name. */
const lock = (tx: Transaction, name: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${name}, 0))`);

/** The most one attempt can cost: a generous count of what is sent, and the longest answer. */
function attemptReservation(request: AiRunRequest, prices: AiModel | undefined) {
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
function assertRequest(feature: AiFeature, request: AiRunRequest) {
  const malformed =
    request.messages.length === 0 ||
    request.messages.some((m) => (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') ||
    !Number.isInteger(request.maxTokens) ||
    request.maxTokens < 1 ||
    request.maxTokens > 64_000 ||
    (request.timeoutMs !== undefined && (request.timeoutMs < 1 || request.timeoutMs > MAX_TIMEOUT_MS)) ||
    !Array.isArray(request.people) ||
    request.people.length > MAX_PEOPLE ||
    request.people.some((p) => typeof p !== 'string' || p.length > MAX_PERSON_CHARS) ||
    (feature === 'drafting' ? !request.unit || !UUID.test(request.unit) : request.unit !== undefined);
  if (malformed) throw new Error('AiService.run: the request is malformed');
}

/** Too long to be sent: refused, not thrown, since it may be the person's text. */
function tooLarge(request: AiRunRequest) {
  const texts = [request.system ?? '', ...request.messages.map((m) => m.content)];
  return (
    texts.some((t) => t.length > MAX_MESSAGE_CHARS) || texts.reduce((n, t) => n + t.length, 0) > MAX_REQUEST_CHARS
  );
}

/** One attempt: how it ended, and what it used when the provider said. */
type Attempt = { failure: ProviderFailure | null; usage: ProviderUsage | null };

type Admitted = {
  ok: true;
  requestId: string;
  connection: ConnectionRow;
  model: string;
  prices: AiModel | undefined;
  perAttempt: number;
  people: string[];
};

/**
 * The single entry point of every AI feature
 * (docs/specs/ai-providers-and-allowances.md). `run()`:
 *
 * 1. refuses a request too large to send (`ai_request_too_large`);
 * 2. checks, in one transaction of the client's, reading its subscription
 *    afresh: that it is not suspended, the AI module and the module the
 *    feature assists, that Trustline offers the feature and has configured
 *    it, the client's own switch, the allowance, and the client's and the
 *    platform's spending limits; and records the request as under way, at
 *    the most it can cost over both attempts, so that two requests can
 *    never both take the last of an allowance or a limit;
 * 3. removes the names of the client's people, those the feature passes
 *    in and those the words around them announce, and identifiers, from
 *    every text;
 * 4. calls the provider, with a timeout, and once more after a failure
 *    worth retrying;
 * 5. puts the names back, and checks the answer's shape when the feature
 *    gave one;
 * 6. records how the request ended: its size, its cost over every attempt,
 *    its outcome;
 * 7. returns the answer, or a refusal with a code.
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
    private readonly entitlements: EntitlementsService,
  ) {}

  async run<T = unknown>(caller: AiCaller, feature: AiFeature, request: AiRunRequest<T>): Promise<AiRunResult<T>> {
    assertRequest(feature, request);
    if (tooLarge(request)) {
      return { ok: false, code: 'ai_request_too_large', feature, maxMessageChars: MAX_MESSAGE_CHARS, maxRequestChars: MAX_REQUEST_CHARS };
    }
    const tenantId = caller.tenant.id;
    const month = monthOf(new Date(), caller.tenant.timeZone);
    const admitted = await this.tenantDb.withTenant(tenantId, (tx) =>
      this.admit(tx, caller, feature, request, month),
    );
    if (!admitted.ok) return admitted;

    // Names out. The mapping lives in this object, for this request only.
    const texts = [request.system ?? '', ...request.messages.map((m) => m.content)];
    const redaction = new Redaction(new NameIndex([...admitted.people, ...request.people]));
    redaction.reserve(texts);
    redaction.learn(texts);
    const sent: ProviderRequest = {
      model: admitted.model,
      ...(request.system && { system: redaction.redact(request.system) }),
      messages: request.messages.map((m) => ({ role: m.role, content: redaction.redact(m.content) })),
      maxTokens: request.maxTokens,
      ...(request.output && { output: { schema: z.toJSONSchema(request.output) as Record<string, unknown> } }),
    };

    const attempts: Attempt[] = [];
    let result: ProviderResult | null = null;
    let data: T | undefined;
    let failure: ProviderFailure | null = null;
    try {
      const provider = this.providers.for(admitted.connection);
      result = await this.call(provider, sent, request.timeoutMs ?? DEFAULT_TIMEOUT_MS, attempts);
      if (request.output) {
        const checked = request.output.safeParse(redaction.restoreDeep(parseStructured(result.text)));
        if (!checked.success) throw new AiProviderError('invalid_output');
        data = checked.data;
      }
    } catch (e) {
      if (e instanceof RealProviderUnderTestError) throw e;
      failure = e instanceof AiProviderError ? e.failure : failureOf(e);
    }

    const usage = result?.usage ?? { inputTokens: 0, outputTokens: 0 };
    await this.finish(tenantId, admitted.requestId, {
      outcome: failure ? 'failed' : 'succeeded',
      reason: failure,
      attempts: attempts.length,
      ...usage,
      costMicroUsd: attempts.reduce(
        (sum, a) =>
          sum + (a.usage ? costOf(a.usage, admitted.prices) : a.failure && MAYBE_BILLED.has(a.failure) ? admitted.perAttempt : 0),
        0,
      ),
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
  private async call(provider: AiProvider, request: ProviderRequest, timeoutMs: number, attempts: Attempt[]) {
    for (;;) {
      try {
        const result = await withTimeout(provider, request, timeoutMs);
        attempts.push({ failure: null, usage: result.usage });
        return result;
      } catch (e) {
        if (e instanceof RealProviderUnderTestError) throw e;
        const error = e instanceof AiProviderError ? e : new AiProviderError(failureOf(e));
        attempts.push({ failure: error.failure, usage: null });
        if (attempts.length < MAX_ATTEMPTS && error.retryable) {
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
    // The subscription as it is now, not as the caller saw it.
    const entitled = await this.entitlements.of(tx, tenantId);
    if (entitled?.status === 'suspended') return { ok: false, code: 'subscription_suspended', feature };
    const modules = entitled && allows(entitled, 'ai_assistant') ? entitled.modules : [];
    const client = await readClientAi(tx, tenantId);
    const offer = offerOf(client, modules, feature);
    if (!offer.offered) return { ok: false, code: 'ai_not_offered', feature, reason: offer.reason };
    if (!client.settings!.clientEnabled) return { ok: false, code: 'ai_switched_off', feature };

    const choice = client.features[feature]!;
    const model = request.tier === 'quick' ? (choice.quickModel ?? choice.model) : choice.model;
    const prices = choice.connection.models.find((m) => m.id === model);
    const allowance = client.allowances[feature];
    const unitKey = feature === 'drafting' ? request.unit! : null;
    const base = {
      tenantId,
      feature,
      connectionId: choice.connection.id,
      model,
      userId: caller.user?.id ?? null,
      month,
      unitKey,
    };
    const refuse = async (reason: 'allowance_reached' | 'spending_limit', counted: boolean) => {
      await tx.insert(aiRequests).values({ ...base, counted, outcome: 'refused', reason, finishedAt: new Date() });
    };

    // Allowance: one request at a time per client and feature, from here
    // to the end of the transaction, so that the count is right.
    await lock(tx, `trustline.ai.allowance.${tenantId}.${feature}`);
    const counted = await this.counts(tx, month, unitKey);
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
    // client's this month in UTC, with this one at its most over both
    // attempts.
    const perAttempt = attemptReservation(request, prices);
    const reserved = perAttempt * MAX_ATTEMPTS;
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
      const { rows } = await tx.execute<{ spent: string }>(sql`select public.ai_platform_spend_this_month() as spent`);
      if (Number(rows[0].spent) + reserved > platform.limit) {
        await this.reportSpending(tx, tenantId, 'platform', utcMonthStart(new Date()).toISOString().slice(0, 7));
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
    return { ok: true, requestId: row.id, connection: choice.connection, model, prices, perAttempt, people };
  }

  /**
   * Whether this request opens a unit of the allowance. A suggestion and
   * an assistant message: every request. A draft (security review 13, M4):
   * the first request of its conversation in the month, and the first
   * after every REQUESTS_PER_DRAFT requests of it in the month, whatever
   * they were (questions, the draft, revisions: the server cannot tell
   * them apart, and does not take the feature's word for it). A draft that
   * carries on into another month is counted again there; one whose
   * opening failed opens again.
   */
  private async counts(tx: Transaction, month: string, unitKey: string | null) {
    if (unitKey === null) return true;
    const inDraft = and(
      eq(aiRequests.feature, 'drafting'),
      eq(aiRequests.unitKey, unitKey),
      eq(aiRequests.month, month),
      live,
    );
    const [opened] = await tx
      .select({ createdAt: aiRequests.createdAt })
      .from(aiRequests)
      .where(and(inDraft, eq(aiRequests.counted, true)))
      .orderBy(desc(aiRequests.createdAt))
      .limit(1);
    if (!opened) return true;
    const [{ since }] = await tx
      .select({ since: count() })
      .from(aiRequests)
      .where(and(inDraft, gte(aiRequests.createdAt, opened.createdAt)));
    return since >= REQUESTS_PER_DRAFT;
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
    await tx.execute(sql`select public.ai_report_spending_limit(${tenantId}::uuid, ${scope}, ${month})`);
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
