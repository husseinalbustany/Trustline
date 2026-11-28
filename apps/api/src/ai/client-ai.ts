import { and, eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../database/client.js';
import {
  aiClientFeatures,
  aiClientSettings,
  aiProviderConnections,
  aiRequests,
  plans,
  subscriptions,
  type AiModel,
} from '../database/schema.js';
import { addMonths, dayOf } from '../i18n/time-zones.js';
import type { ModuleCode } from '../subscriptions/modules.js';
import {
  AI_FEATURES,
  effectiveAllowances,
  FEATURE_MODULES,
  PENDING_STALE_MINUTES,
  type AiAllowances,
  type AiFeature,
} from './features.js';
import type { AiProviderKind, InferenceType } from './provider.js';

/**
 * A client's AI configuration as both the application and the admin portal
 * read it: what Trustline set, the client's switch, and the allowances in
 * force. Read with the caller's connection (the application's, inside the
 * client's transaction, or the platform's), which may each read these
 * columns.
 */
export type ClientAi = {
  settings: {
    offered: boolean;
    allowanceOverrides: Partial<AiAllowances>;
    medicalOptionAllowed: boolean;
    monthlySpendingLimitMicroUsd: number | null;
    clientEnabled: boolean;
    clientSwitchedBy: string | null;
    clientSwitchedAt: Date | null;
    updatedAt: Date;
  } | null;
  features: Record<AiFeature, FeatureChoice | null>;
  planAllowances: AiAllowances;
  allowances: AiAllowances;
};

export type ConnectionRow = {
  id: string;
  name: string;
  kind: AiProviderKind;
  region: string;
  inferenceType: InferenceType;
  models: AiModel[];
  credentialEnv: string;
  active: boolean;
};

export type FeatureChoice = {
  connection: ConnectionRow;
  model: string;
  quickModel: string | null;
};

export const connectionColumns = {
  id: aiProviderConnections.id,
  name: aiProviderConnections.name,
  kind: aiProviderConnections.kind,
  region: aiProviderConnections.region,
  inferenceType: aiProviderConnections.inferenceType,
  models: aiProviderConnections.models,
  credentialEnv: aiProviderConnections.credentialEnv,
  active: aiProviderConnections.active,
};

export async function readClientAi(db: Database | Transaction, tenantId: string): Promise<ClientAi> {
  const [settings] = await db
    .select({
      offered: aiClientSettings.offered,
      allowanceOverrides: aiClientSettings.allowanceOverrides,
      medicalOptionAllowed: aiClientSettings.medicalOptionAllowed,
      monthlySpendingLimitMicroUsd: aiClientSettings.monthlySpendingLimitMicroUsd,
      clientEnabled: aiClientSettings.clientEnabled,
      clientSwitchedBy: aiClientSettings.clientSwitchedBy,
      clientSwitchedAt: aiClientSettings.clientSwitchedAt,
      updatedAt: aiClientSettings.updatedAt,
    })
    .from(aiClientSettings)
    .where(eq(aiClientSettings.tenantId, tenantId));
  const rows = await db
    .select({
      feature: aiClientFeatures.feature,
      model: aiClientFeatures.model,
      quickModel: aiClientFeatures.quickModel,
      connection: connectionColumns,
    })
    .from(aiClientFeatures)
    .innerJoin(aiProviderConnections, eq(aiProviderConnections.id, aiClientFeatures.connectionId))
    .where(eq(aiClientFeatures.tenantId, tenantId));
  const [plan] = await db
    .select({ aiAllowances: plans.aiAllowances })
    .from(subscriptions)
    .innerJoin(plans, eq(plans.id, subscriptions.planId))
    .where(eq(subscriptions.tenantId, tenantId));
  const features = Object.fromEntries(AI_FEATURES.map((f) => [f, null])) as ClientAi['features'];
  for (const row of rows) {
    features[row.feature] = { connection: row.connection, model: row.model, quickModel: row.quickModel };
  }
  const planAllowances = effectiveAllowances(plan?.aiAllowances, null);
  return {
    settings: settings ?? null,
    features,
    planAllowances,
    allowances: effectiveAllowances(plan?.aiAllowances, settings?.allowanceOverrides),
  };
}

/** Why a feature cannot be used, before the client's switch is asked. */
export type NotOfferedReason =
  /** The client's subscription has not the AI module, or not what it assists. */
  | 'module'
  /** Trustline does not offer the client AI. */
  | 'not_offered'
  /** Trustline has not chosen a connection and model for this feature. */
  | 'not_configured'
  /** The connection chosen was deactivated. */
  | 'connection_inactive'
  /** The plan includes none of it (an allowance of zero). */
  | 'plan';

/** Whether Trustline offers this feature to the client, as things stand. */
export function offerOf(
  client: ClientAi,
  modules: readonly ModuleCode[],
  feature: AiFeature,
): { offered: true } | { offered: false; reason: NotOfferedReason } {
  const assists = FEATURE_MODULES[feature];
  if (!modules.includes('ai_assistant') || (assists.length > 0 && !assists.some((m) => modules.includes(m)))) {
    return { offered: false, reason: 'module' };
  }
  if (!client.settings?.offered) return { offered: false, reason: 'not_offered' };
  const choice = client.features[feature];
  if (!choice) return { offered: false, reason: 'not_configured' };
  if (!choice.connection.active) return { offered: false, reason: 'connection_inactive' };
  if (client.allowances[feature] === 0) return { offered: false, reason: 'plan' };
  return { offered: true };
}

/** The month a moment falls in on the client's calendar: `YYYY-MM`. */
export const monthOf = (moment: Date, timeZone: string) => dayOf(moment, timeZone).slice(0, 7);

/** The first day of the month after this one: when an allowance starts again. */
export const nextMonthStarts = (month: string) => addMonths(`${month}-01`, 1);

/** The first moment of the UTC month, for the platform-wide limit. */
export function utcMonthStart(moment: Date) {
  return new Date(Date.UTC(moment.getUTCFullYear(), moment.getUTCMonth(), 1));
}

/**
 * A request that counts against an allowance: answered; answered in a shape
 * the feature could not use (`invalid_output`, which cost as much, and is
 * not a way around the allowance: security review 13, M3); or under way and
 * not given up for dead.
 */
export const live = sql`(${aiRequests.outcome} = 'succeeded' or (${aiRequests.outcome} = 'failed' and ${aiRequests.reason} = 'invalid_output') or (${aiRequests.outcome} = 'pending' and ${aiRequests.createdAt} > now() - make_interval(mins => ${PENDING_STALE_MINUTES})))`;

/** A request whose cost counts: answered, failed, or under way. */
export const costs = sql`(${aiRequests.outcome} in ('succeeded', 'failed') or (${aiRequests.outcome} = 'pending' and ${aiRequests.createdAt} > now() - make_interval(mins => ${PENDING_STALE_MINUTES})))`;

/**
 * What a client has used in a month: per feature, the units counted
 * against the allowance (drafts, suggestions, messages); and what its
 * requests cost, in millionths of a dollar.
 */
export async function usageOf(db: Database | Transaction, tenantId: string, month: string) {
  const rows = await db
    .select({
      feature: aiRequests.feature,
      used: sql<number>`(count(*) filter (where ${aiRequests.counted} and ${live}))::int`,
      requests: sql<number>`(count(*) filter (where ${aiRequests.outcome} <> 'refused'))::int`,
      costMicroUsd: sql<number>`coalesce(sum(${aiRequests.costMicroUsd}) filter (where ${costs}), 0)::bigint`,
    })
    .from(aiRequests)
    .where(and(eq(aiRequests.tenantId, tenantId), eq(aiRequests.month, month)))
    .groupBy(aiRequests.feature);
  const byFeature = Object.fromEntries(
    AI_FEATURES.map((f) => [f, { used: 0, requests: 0, costMicroUsd: 0 }]),
  ) as Record<AiFeature, { used: number; requests: number; costMicroUsd: number }>;
  for (const row of rows) {
    byFeature[row.feature] = { used: row.used, requests: row.requests, costMicroUsd: Number(row.costMicroUsd) };
  }
  const costMicroUsd = Object.values(byFeature).reduce((sum, f) => sum + f.costMicroUsd, 0);
  return { byFeature, costMicroUsd };
}

/** Where a connection processes requests, as the client is told. */
export const whereOf = (connection: Pick<ConnectionRow, 'kind' | 'region' | 'inferenceType'>) => ({
  kind: connection.kind,
  region: connection.region,
  inferenceType: connection.inferenceType,
});

/** Millionths of a dollar as dollars, for what is shown. */
export const usd = (micro: number | null) => (micro === null ? null : micro / 1_000_000);
/** Dollars as millionths, for what is stored. */
export const microUsd = (dollars: number | null) => (dollars === null ? null : Math.round(dollars * 1_000_000));
