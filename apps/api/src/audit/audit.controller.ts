import { BadRequestException, Controller, Get, HttpException, HttpStatus, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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
import { SUPPORTED_LOCALES, type Locale } from '../i18n/locales.js';
import { CSV_CONTENT_TYPE } from '../policies/csv.js';
import { AuditKeys } from './audit-keys.js';
import { ExportKeys } from '../exports/export-keys.js';
import { checkpointsQuery, chainQuery, entriesExportQuery, entriesQuery } from './input.js';
import { readCursor, sealedBeforeIn, TrailService } from './trail.service.js';

/** The query, or 400. */
function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, query: unknown): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

/**
 * The language a file is written in: the one asked for, if the client
 * works in it (400 \`language_mismatch\` otherwise); else the client's own.
 */
function fileLocale(req: AuthedRequest, asked: Locale | undefined): Locale {
  const ours = (l: string | undefined): l is Locale =>
    !!l && req.auth.tenant.locales.includes(l) && (SUPPORTED_LOCALES as readonly string[]).includes(l);
  if (asked) {
    if (!ours(asked)) throw new BadRequestException({ code: 'language_mismatch' });
    return asked;
  }
  return ours(req.auth.tenant.defaultLocale) ? req.auth.tenant.defaultLocale : 'en';
}

const download = (res: Response, type: string, fileName: string) => {
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
};

const noQuery = z.strictObject({});

/** The clients whose chain file is being written now, in this process. */
const chainExports = new Set<string>();

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
    private readonly trail: TrailService,
  ) {}

  /**
   * The trail, newest first, 50 a page (at most 200), by key: \`before\` is
   * the \`next\` of the page before. Filtered by record (its type and id,
   * or an incident's reference or a document's number), person, actions,
   * area and days on the organization's calendar. Not audited, except for
   * an external reviewer, whose every read is.
   */
  @Get('entries')
  entries(@Query() query: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'audit.view');
    const input = parse(entriesQuery, query);
    if (input.before && !readCursor(input.before)) throw new BadRequestException();
    return this.trail.entries(req.auth, { ...input, locale: fileLocale(req, input.locale) });
  }

  /** The filtered trail as a CSV file, worded in the client's language. */
  @Get('exports/entries')
  async exportEntries(@Query() query: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    requireEverywhere(req, 'audit.view');
    const { locale, ...filters } = parse(entriesExportQuery, query);
    const file = await this.trail.exportEntries(req.auth, filters, fileLocale(req, locale));
    download(res, CSV_CONTENT_TYPE, file.fileName);
    return file.body;
  }

  /**
   * The chain file of a range of entries, JSON Lines, streamed by number
   * (docs/specs/audit-trail.md, "The chain file format").
   */
  @Get('exports/chain')
  async exportChain(@Query() query: unknown, @Req() req: AuthedRequest, @Res() res: Response) {
    requireEverywhere(req, 'audit.view');
    const range = parse(chainQuery, query);
    // One at a time per client, waiting for the reader (security review
    // 14, L3): a slow download holds no more than a little of the file.
    const tenantId = req.auth.tenant.id;
    if (chainExports.has(tenantId)) {
      throw new HttpException({ code: 'export_in_progress' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    chainExports.add(tenantId);
    let started = false;
    const start = (fileName: string) => {
      if (started) return;
      res.status(200);
      download(res, 'application/jsonl; charset=utf-8', fileName);
      started = true;
    };
    try {
      await this.trail.chainFile(req.auth, range, async (line) => {
        start(`audit-chain-${req.auth.tenant.slug.replace(/[^A-Za-z0-9-]/g, '-')}.jsonl`);
        if (!res.write(`${line}\n`)) {
          await new Promise<void>((resolve, reject) => {
            res.once('drain', resolve);
            res.once('close', () => reject(new Error('closed')));
          });
        }
      });
      res.end();
    } catch (error) {
      // Once begun, a file cut short is not a file: the connection is
      // closed, so that nobody takes it for a whole one.
      if (started) {
        res.destroy();
        return;
      }
      throw error;
    } finally {
      chainExports.delete(tenantId);
    }
  }

  /** The signed checkpoints, between two days, as a JSON file. */
  @Get('checkpoints')
  async checkpoints(@Query() query: unknown, @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response) {
    requireEverywhere(req, 'audit.view');
    const range = parse(checkpointsQuery, query);
    const { file, fileName } = await this.trail.checkpoints(req.auth, range);
    download(res, 'application/json; charset=utf-8', fileName);
    return file;
  }

  @Get('status')
  status(@Query() query: unknown, @Req() req: AuthedRequest) {
    requireEverywhere(req, 'audit.view');
    if (!noQuery.safeParse(query).success) throw new BadRequestException();
    return this.tenantDb.withTenant(req.auth.tenant.id, async (tx) => {
      // The head's time is its entry's, which is sealed, not the seal's own
      // (security review 12, L1).
      const [head] = await tx
        .select({ seq: auditChainHeads.seq, at: auditLog.occurredAt })
        .from(auditChainHeads)
        .leftJoin(
          auditChain,
          and(eq(auditChain.tenantId, auditChainHeads.tenantId), eq(auditChain.seq, auditChainHeads.seq)),
        )
        .leftJoin(auditLog, eq(auditLog.id, auditChain.entryId));
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
        signature: auditChainCheckpoints.signature,
        cpSeq: auditChainCheckpoints.seq,
        cpHash: auditChainCheckpoints.hash,
        cpAt: auditChainCheckpoints.at,
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
        .where(and(eq(auditChainVerifications.result, 'failed'), eq(auditChainVerifications.confirmed, true)))
        .orderBy(asc(auditChainVerifications.runAt))
        .limit(1);
      const sealed = await sealedBeforeIn(tx);
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
              // Signed only when the signature holds under a key this API
              // knows (security review 12, L5).
              signed:
                row.cpSeq !== null &&
                this.keys.check({
                  tenantId: req.auth.tenant.id,
                  seq: row.cpSeq,
                  hash: row.cpHash!,
                  at: row.cpAt!,
                  keyId: row.keyId,
                  signature: row.signature,
                }) === 'valid',
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
        sealedOn: sealed.sealedOn,
        sealedBefore: sealed.sealedBefore,
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
  constructor(
    private readonly keys: AuditKeys,
    private readonly exportKeys: ExportKeys,
  ) {}

  /**
   * `keys`: the audit checkpoints' keys, which the chain verifier reads.
   * `exportKeys`: the keys of full data exports' manifests
   * (docs/specs/data-export.md), kept apart so that neither key's
   * signature is taken for the other's.
   */
  @Get()
  list() {
    return { keys: this.keys.published, exportKeys: this.exportKeys.published };
  }
}
