import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  auditChain,
  auditChainCheckpoints,
  auditChainHeads,
  auditChainVerifications,
  auditLog,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { requireEverywhere, SessionGuard, type AuthedRequest } from '../identity/session.guard.js';
import { ForModule } from '../subscriptions/module.decorator.js';
import { AuditKeys } from './audit-keys.js';

const noQuery = z.strictObject({});

/**
 * The state of the client's audit trail (docs/specs/audit-trail.md, "What
 * a surveyor sees"): its head, the last check, the first break ever found
 * (which stays shown), and when it was sealed. For holders of `audit.view`
 * for the whole organization only. A read: open while suspended.
 */
@Controller('audit')
@UseGuards(SessionGuard)
@ForModule('core')
export class AuditController {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly keys: AuditKeys,
  ) {}

  @Get('status')
  status(@Query() query: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'audit.view');
    if (!noQuery.safeParse(query).success) throw new BadRequestException();
    return this.tenantDb.withTenant(req.auth.tenant.id, async (tx) => {
      const [head] = await tx
        .select({ seq: auditChainHeads.seq, at: auditChain.sealedAt })
        .from(auditChainHeads)
        .leftJoin(
          auditChain,
          and(eq(auditChain.tenantId, auditChainHeads.tenantId), eq(auditChain.seq, auditChainHeads.seq)),
        );
      const check = {
        at: auditChainVerifications.runAt,
        result: auditChainVerifications.result,
        full: auditChainVerifications.full,
        fromSeq: auditChainVerifications.fromSeq,
        toSeq: auditChainVerifications.toSeq,
        kind: auditChainVerifications.kind,
        firstBadSeq: auditChainVerifications.firstBadSeq,
        firstBadEntryId: auditChainVerifications.firstBadEntryId,
        keyId: auditChainCheckpoints.keyId,
      };
      const [last] = await tx
        .select(check)
        .from(auditChainVerifications)
        .leftJoin(auditChainCheckpoints, eq(auditChainCheckpoints.id, auditChainVerifications.checkpointId))
        .orderBy(desc(auditChainVerifications.runAt))
        .limit(1);
      const [broken] = await tx
        .select(check)
        .from(auditChainVerifications)
        .leftJoin(auditChainCheckpoints, eq(auditChainCheckpoints.id, auditChainVerifications.checkpointId))
        .where(eq(auditChainVerifications.result, 'failed'))
        .orderBy(asc(auditChainVerifications.runAt))
        .limit(1);
      const [started] = await tx
        .select({ changes: auditLog.changes })
        .from(auditLog)
        .where(and(eq(auditLog.action, 'audit_chain_started'), eq(auditLog.entityType, 'tenant')))
        .limit(1);
      const sealed = (started?.changes ?? null) as { sealedOn?: string; sealedBefore?: number } | null;
      const shown = (row: typeof last | undefined) =>
        row
          ? {
              at: row.at,
              result: row.result,
              full: row.full,
              fromSeq: row.fromSeq,
              toSeq: row.toSeq,
              kind: row.kind,
              firstBadSeq: row.firstBadSeq,
              firstBadEntryId: row.firstBadEntryId,
              signed: row.keyId !== null,
            }
          : null;
      const lastCheck = shown(last);
      const firstBreak = shown(broken);
      return {
        head: { seq: head?.seq ?? 0, at: head?.at ?? null },
        lastCheck,
        // The first break found, kept on show even if a later check passes.
        broken: firstBreak && {
          at: firstBreak.at,
          kind: firstBreak.kind,
          firstBadSeq: firstBreak.firstBadSeq,
          firstBadEntryId: firstBreak.firstBadEntryId,
        },
        // Entries 1 to `sealedBefore` were recorded before the trail was
        // sealed, on `sealedOn`: the chain shows they have not changed
        // since, not before. A client made since is sealed from its start.
        sealedOn: sealed?.sealedOn ?? null,
        sealedBefore: sealed?.sealedBefore ?? 0,
        // Whether this API signs its checkpoints (it has a key).
        signing: this.keys.signer ? ('signed' as const) : ('unsigned' as const),
      };
    });
  }
}

/**
 * Trustline's public keys for the audit chain's checkpoints, the current
 * one and those replaced since: published, so that anyone can check a
 * checkpoint without trusting Trustline's servers. No sign-in.
 */
@Controller('audit/keys')
@ForModule('core')
export class AuditKeysController {
  constructor(private readonly keys: AuditKeys) {}

  @Get()
  list() {
    return { keys: this.keys.published };
  }
}
