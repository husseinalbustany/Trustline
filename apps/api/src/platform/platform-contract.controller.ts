import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database, Transaction } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import { clientDeletions, dataExports, platformAdmins, subscriptions, tenants } from '../database/schema.js';
import { line, optionalText, text } from '../i18n/text.js';
import { dayOf } from '../i18n/time-zones.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { exitWindowOf } from '../subscriptions/entitlements.service.js';
import { ForModule } from '../subscriptions/module.decorator.js';
import { PlatformAuthGuard, type PlatformRequest } from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';

const day = z.iso.date();

const contractSchema = z
  .strictObject({ endsOn: day.nullable(), exitUntil: day.nullable(), retainUntil: day.nullable() })
  .partial()
  .refine((v) => Object.keys(v).length > 0);

/** A contract contact's written request, as staff record it. */
const writtenRequest = z.strictObject({
  receivedOn: day,
  from: line(1, 200),
  reference: line(1, 200),
  note: optionalText(1000),
});

const approvalSchema = z.strictObject({ writtenRequest });
const deletionSchema = z.strictObject({ reason: text(1, 1000), writtenInstruction: writtenRequest.optional() });

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException();
  return parsed.data;
}

/** What `data_export_second_approval()` answers, as HTTP. */
const SECOND_APPROVAL: Record<string, () => Error> = {
  not_found: () => new NotFoundException(),
  not_requested: () => new ConflictException({ code: 'stale_export' }),
  lapsed: () => new ConflictException({ code: 'lapsed' }),
  not_alone: () => new ConflictException({ code: 'not_alone' }),
};

/**
 * The end of a client's contract, for Trustline's staff
 * (docs/specs/data-export.md, "At the end of a contract" and "What
 * Trustline staff can and cannot do"):
 *
 * - **Dates:** the contract's end, the exit window's last day and the
 *   retention date. None changes a status by itself. Each change is in the
 *   platform log (`contract_end_set`, `exit_window_set`, `retention_set`)
 *   and in the client's own (`contract_end_set`), in one transaction.
 * - **The exports' status:** status, reason, times, size and downloads,
 *   never who asked (names are the client's), through the columns the
 *   platform role is granted.
 * - **The second approval** of an export, for a client whose only holder
 *   of `data.export` asked (decision 3), on its contract contact's written
 *   request, which is recorded. It releases nothing to Trustline: only the
 *   person who asked may download.
 * - **Deletion:** asked for by one member of staff after the retention
 *   date, approved by another; carried out from the command line
 *   (`platform:delete-client`), which writes the signed certificate.
 */
@Controller('platform/tenants/:id')
@UseGuards(PlatformAuthGuard)
@ForModule('core')
export class PlatformContractController {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly auth: PlatformAuthService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Get('contract')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.db.transaction((tx) => this.view(tx, id));
  }

  /** Sets the contract's dates: each nullable, the retention on or after the exit window's end. */
  @Put('contract')
  set(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const input = parse(contractSchema, body);
    const admin = req.platformAdmin;
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ endsOn: subscriptions.endsOn, exitUntil: subscriptions.exitUntil, retainUntil: subscriptions.retainUntil })
        .from(subscriptions)
        .where(eq(subscriptions.tenantId, id))
        .for('update');
      if (!current) throw new NotFoundException();
      const next = { ...current, ...input };
      if (next.retainUntil && next.exitUntil && next.retainUntil < next.exitUntil) {
        throw new BadRequestException({ code: 'invalid_dates' });
      }
      const changed = (['endsOn', 'exitUntil', 'retainUntil'] as const).filter((k) => input[k] !== undefined && input[k] !== current[k]);
      if (changed.length > 0) {
        await tx
          .update(subscriptions)
          .set({ ...Object.fromEntries(changed.map((k) => [k, next[k]])), updatedAt: new Date() })
          .where(eq(subscriptions.tenantId, id));
        const action = { endsOn: 'contract_end_set', exitUntil: 'exit_window_set', retainUntil: 'retention_set' } as const;
        for (const k of changed) {
          await this.auth.audit(admin.id, action[k], id, { from: current[k], to: next[k] }, tx);
        }
        await this.auditContract(tx, id, {
          ...Object.fromEntries(changed.map((k) => [k, { from: current[k], to: next[k] }])),
          platformAdminId: admin.id,
          platformAdminName: admin.name,
        });
      }
      return this.view(tx, id);
    });
  }

  /**
   * Records Trustline's second approval of an export (decision 3): only for
   * a request waiting for its approval, within its 7 days, of a client with
   * no other holder of `data.export` for the whole organization (409
   * `not_alone`: the other holder approves). Done by the database
   * (`data_export_second_approval`), which alone may read who holds what.
   */
  @Post('exports/:exportId/approve')
  @HttpCode(200)
  approve(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('exportId', ParseUUIDPipe) exportId: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const { writtenRequest: request } = parse(approvalSchema, body);
    const admin = req.platformAdmin;
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ result: string }>(sql`
        select data_export_second_approval(${id}::uuid, ${exportId}::uuid, ${admin.id}::uuid, ${admin.name}, ${JSON.stringify(request)}::jsonb) as result`);
      const result = rows[0]?.result;
      if (result !== 'ok') throw (SECOND_APPROVAL[result] ?? (() => new ConflictException({ code: 'stale_export' })))();
      await this.auth.audit(admin.id, 'second_approval_recorded', id, { exportId, writtenRequest: request }, tx);
      return this.view(tx, id);
    });
  }

  /** Asks for the client's data to be deleted: after the retention date, by one member of staff. */
  @Post('deletion')
  @HttpCode(201)
  request(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown, @Req() req: PlatformRequest) {
    const input = parse(deletionSchema, body);
    const admin = req.platformAdmin;
    return this.db.transaction(async (tx) => {
      const state = await this.contract(tx, id, true);
      const refusal = refusalOf(state, !!input.writtenInstruction);
      if (refusal) throw new ConflictException({ code: refusal });
      const [made] = await tx
        .insert(clientDeletions)
        .values({ targetTenantId: id, requestedBy: admin.id, reason: input.reason, writtenInstruction: input.writtenInstruction ?? null })
        .onConflictDoNothing()
        .returning({ id: clientDeletions.id });
      if (!made) throw new ConflictException({ code: 'deletion_in_progress' });
      await this.auth.audit(admin.id, 'client_deletion_requested', id, {
        deletionId: made.id,
        reason: input.reason,
        writtenInstruction: input.writtenInstruction ?? null,
      }, tx);
      return this.view(tx, id);
    });
  }

  /** The second member of staff's approval. The deletion itself is the command line's. */
  @Post('deletion/:deletionId/approve')
  @HttpCode(200)
  approveDeletion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deletionId', ParseUUIDPipe) deletionId: string,
    @Req() req: PlatformRequest,
  ) {
    const admin = req.platformAdmin;
    return this.db.transaction(async (tx) => {
      const deletion = await this.deletionOf(tx, id, deletionId);
      if (deletion.requestedBy === admin.id) throw new ForbiddenException({ code: 'same_person' });
      if (deletion.status !== 'requested') throw new ConflictException({ code: 'stale_deletion' });
      const refusal = refusalOf(await this.contract(tx, id, true), !!deletion.writtenInstruction);
      if (refusal) throw new ConflictException({ code: refusal });
      await tx
        .update(clientDeletions)
        .set({ status: 'approved', approvedBy: admin.id, approvedAt: new Date() })
        .where(eq(clientDeletions.id, deletionId));
      await this.auth.audit(admin.id, 'client_deletion_approved', id, { deletionId }, tx);
      return this.view(tx, id);
    });
  }

  @Post('deletion/:deletionId/cancel')
  @HttpCode(200)
  cancelDeletion(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('deletionId', ParseUUIDPipe) deletionId: string,
    @Req() req: PlatformRequest,
  ) {
    const admin = req.platformAdmin;
    return this.db.transaction(async (tx) => {
      const deletion = await this.deletionOf(tx, id, deletionId);
      if (deletion.status !== 'requested' && deletion.status !== 'approved') throw new ConflictException({ code: 'stale_deletion' });
      await tx.update(clientDeletions).set({ status: 'cancelled', cancelledAt: new Date() }).where(eq(clientDeletions.id, deletionId));
      await this.auth.audit(admin.id, 'client_deletion_cancelled', id, { deletionId }, tx);
      return this.view(tx, id);
    });
  }

  private async deletionOf(tx: Transaction, tenantId: string, deletionId: string) {
    const [row] = await tx
      .select()
      .from(clientDeletions)
      .where(and(eq(clientDeletions.id, deletionId), eq(clientDeletions.targetTenantId, tenantId)))
      .for('update');
    if (!row) throw new NotFoundException();
    return row;
  }

  /** What the end of the contract stands at, for one client. */
  private async contract(tx: Transaction, tenantId: string, lock = false) {
    const query = tx
      .select({
        status: tenants.status,
        timeZone: tenants.timeZone,
        subscription: subscriptions.status,
        endsOn: subscriptions.endsOn,
        exitUntil: subscriptions.exitUntil,
        retainUntil: subscriptions.retainUntil,
      })
      .from(tenants)
      .innerJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .where(eq(tenants.id, tenantId));
    const [row] = lock ? await query.for('update', { of: subscriptions }) : await query;
    if (!row) throw new NotFoundException();
    const { rows: downloaded } = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from ${dataExports} where ${dataExports.tenantId} = ${tenantId} and ${dataExports.downloads} > 0`,
    );
    return { ...row, today: dayOf(new Date(), row.timeZone), downloaded: downloaded[0].n > 0 };
  }

  private async view(tx: Transaction, tenantId: string) {
    const state = await this.contract(tx, tenantId);
    const exports = await tx
      .select({
        id: dataExports.id,
        status: dataExports.status,
        reason: dataExports.reason,
        requestedAt: dataExports.requestedAt,
        approvedAt: dataExports.approvedAt,
        trustlineApprovedAt: dataExports.trustlineApprovedAt,
        refusedAt: dataExports.refusedAt,
        cancelledAt: dataExports.cancelledAt,
        readyAt: dataExports.readyAt,
        expiresAt: dataExports.expiresAt,
        expiredAt: dataExports.expiredAt,
        sizeBytes: dataExports.sizeBytes,
        downloads: dataExports.downloads,
        lastDownloadedAt: dataExports.lastDownloadedAt,
      })
      .from(dataExports)
      .where(eq(dataExports.tenantId, tenantId))
      .orderBy(desc(dataExports.requestedAt))
      .limit(50);
    const [deletion] = await tx
      .select()
      .from(clientDeletions)
      .where(eq(clientDeletions.targetTenantId, tenantId))
      .orderBy(desc(clientDeletions.requestedAt))
      .limit(1);
    const staff = deletion
      ? await tx
          .select({ id: platformAdmins.id, name: platformAdmins.name })
          .from(platformAdmins)
          .where(inArray(platformAdmins.id, [deletion.requestedBy, deletion.approvedBy].filter((x): x is string => !!x)))
      : [];
    const nameOf = (staffId: string | null) => (staffId ? { id: staffId, name: staff.find((s) => s.id === staffId)?.name ?? null } : null);
    return {
      tenantId,
      clientStatus: state.status,
      subscriptionStatus: state.subscription,
      endsOn: state.endsOn,
      exitUntil: state.exitUntil,
      retainUntil: state.retainUntil,
      exitWindowOpen: !!exitWindowOf({ status: state.subscription, exitUntil: state.exitUntil }, state.today),
      exportDownloaded: state.downloaded,
      deletable: refusalOf(state, false),
      exports,
      deletion: deletion
        ? {
            id: deletion.id,
            status: deletion.status,
            reason: deletion.reason,
            writtenInstruction: deletion.writtenInstruction,
            requestedBy: nameOf(deletion.requestedBy),
            requestedAt: deletion.requestedAt,
            approvedBy: nameOf(deletion.approvedBy),
            approvedAt: deletion.approvedAt,
            cancelledAt: deletion.cancelledAt,
            executedAt: deletion.executedAt,
            certificate: deletion.certificate,
            certificateSha256: deletion.certificateSha256,
            signature: deletion.signature,
          }
        : null,
    };
  }

  /** The client's own log: what Trustline's staff set of its contract's end. */
  private async auditContract(tx: Transaction, tenantId: string, changes: Record<string, unknown>) {
    await tx.execute(sql`
      insert into audit_log (tenant_id, action, entity_type, entity_id, changes)
      values (${tenantId}, 'contract_end_set', 'tenant', ${tenantId}, ${JSON.stringify(changes)}::jsonb)`);
  }
}

/**
 * Why a client's data may not be deleted yet, or null (spec, "After the
 * exit window"): only a cancelled client, after its retention date (the
 * end of the exit window unless staff set a later one), and only once an
 * export was downloaded, unless the client's written instruction is
 * recorded.
 */
export function refusalOf(
  state: { status: string; subscription: string; exitUntil: string | null; retainUntil: string | null; today: string; downloaded: boolean },
  instructed: boolean,
): string | null {
  if (state.status === 'deleted') return 'already_deleted';
  if (state.subscription !== 'cancelled') return 'not_cancelled';
  const until = state.retainUntil ?? state.exitUntil;
  if (!until) return 'no_retention_date';
  if (state.today <= until) return 'before_retention';
  if (!state.downloaded && !instructed) return 'no_export_downloaded';
  return null;
}
