import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { dataExports, notifications, roleAssignments, roles, users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { DataExportChange } from '../email/kinds.js';
import type { Locale, Localized } from '../i18n/locales.js';
import { dayOf } from '../i18n/time-zones.js';
import { AuthService, type AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { ExportStorage } from './storage.js';

/** Days a request waits for its approval, then lapses. */
export const APPROVAL_DAYS = 7;
/** Days a made archive can be downloaded (decision 8). */
export const DOWNLOAD_DAYS = 7;
/** Downloads of one archive (decision 8). */
export const MAX_DOWNLOADS = 5;

type Row = typeof dataExports.$inferSelect;

/** Days an approver's account and grant must have stood (security review 19, M3). */
export const INDEPENDENT_DAYS = 7;

/**
 * Whether an approver is a second person in fact, not one the requester
 * made (security review 19, M3): their account, and a grant of theirs
 * that gives `data.export` for the whole organization, each at least 7 days
 * old and not made by the requester. Why not, or null.
 */
export async function dependenceOf(tx: Transaction, approverId: string, requesterId: string) {
  const { rows: account } = await tx.execute<{ recent: boolean; by_requester: boolean }>(sql`
    select u.created_at > now() - make_interval(days => ${INDEPENDENT_DAYS}) as recent,
      exists (select from audit_log a where a.action = 'user_created' and a.entity_id = u.id and a.actor_id = ${requesterId}::uuid) as by_requester
    from users u where u.id = ${approverId}`);
  if (!account[0]) return 'account_new';
  if (account[0].by_requester) return 'account_by_requester';
  if (account[0].recent) return 'account_new';
  const grants = await tx
    .select({ grantedBy: roleAssignments.grantedBy, grantedAt: roleAssignments.grantedAt })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(
      and(
        eq(roleAssignments.userId, approverId),
        isNull(roleAssignments.orgUnitId),
        sql`'data.export' = any(${roles.permissions})`,
      ),
    );
  const old = Date.now() - INDEPENDENT_DAYS * 86_400_000;
  if (grants.some((g) => g.grantedBy !== requesterId && g.grantedAt.getTime() <= old)) return null;
  return grants.some((g) => g.grantedBy === requesterId) ? 'grant_by_requester' : 'grant_new';
}

/** The holders of authority over exports, told of each change: `data.export` or `settings.manage`, for the whole organization. */
export async function authorityOf(tx: Transaction) {
  const rows = await tx
    .selectDistinct({ id: users.id })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(
      and(
        eq(users.status, 'active'),
        eq(users.kind, 'staff'),
        isNull(roleAssignments.orgUnitId),
        sql`(${roles.permissions} && array['data.export', 'settings.manage']::text[])`,
      ),
    );
  return rows.map((r) => r.id);
}

/**
 * Tells of a change to an export (`data_export_changed`), in the app and by
 * email at once (email/kinds.ts). Names nobody: who did it is in Trustline.
 */
export async function tellOfExport(
  tx: Transaction,
  tenantId: string,
  exportId: string,
  change: DataExportChange,
  to: string[],
) {
  const rows = [...new Set(to)].map((userId) => ({
    tenantId,
    userId,
    kind: 'data_export_changed' as const,
    data: { change, exportId, serious: false },
  }));
  for (let i = 0; i < rows.length; i += 1000) await tx.insert(notifications).values(rows.slice(i, i + 1000));
}

/**
 * Full data exports (docs/specs/data-export.md, "Who may ask, and
 * two-person approval"): for holders of `data.export` for the whole
 * organization (the routes check it), within the client's transaction.
 *
 * - **Ask:** with a reason, the language, and the password again, checked
 *   as for a signature. Nothing is made yet. One asked for or in the making
 *   at a time (409 `export_in_progress`).
 * - **Approve or refuse:** another holder, never the one who asked (403
 *   `same_person`); approving with the password again, within 7 days, else
 *   it lapses (409 `lapsed`).
 * - **Cancel:** the one who asked, until it is being made.
 * - **Download:** the one who asked or the approver, with the password
 *   again, at most 5 times within 7 days of it being ready.
 *
 * Every change is audited in its transaction, and told to every holder of
 * `data.export` or `settings.manage` for the whole organization.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly auth: AuthService,
    private readonly storage: ExportStorage,
  ) {}

  /** An export as its holders see it: never its storage, key or failure's message. */
  private async view(tx: Transaction, auth: AuthContext, rows: Row[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy, r.refusedBy].filter((x): x is string => !!x)))];
    const people = ids.length
      ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
      : [];
    const names = new Map<string, Localized>(people.map((p) => [p.id, p.name]));
    const person = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null);
    const now = Date.now();
    return rows.map((r) => {
      const mine = r.requestedBy === auth.user.id;
      const downloadable = r.status === 'ready' && !!r.expiresAt && r.expiresAt.getTime() > now && r.downloads < MAX_DOWNLOADS;
      return {
        id: r.id,
        status: r.status,
        reason: r.reason,
        note: r.note,
        locale: r.locale,
        includePdfs: r.includePdfs,
        pdfsIncluded: false,
        requestedBy: person(r.requestedBy),
        requestedAt: r.requestedAt,
        lapsesAt: r.status === 'requested' ? r.lapsesAt : null,
        approvedBy: person(r.approvedBy),
        approvedAt: r.approvedAt,
        // Trustline's approval, for a client with one holder (decision 3).
        approvedByTrustline: r.trustlineApprovedAt ? { at: r.trustlineApprovedAt, writtenRequest: r.writtenRequest } : null,
        refusedBy: person(r.refusedBy),
        refusedAt: r.refusedAt,
        refusedReason: r.refusedReason,
        cancelledAt: r.cancelledAt,
        phase: r.status === 'making' ? r.phase : null,
        failure: r.status === 'failed' ? r.errorKind : null,
        snapshotAt: r.snapshotAt,
        sizeBytes: r.sizeBytes,
        archiveSha256: r.archiveSha256,
        readyAt: r.readyAt,
        expiresAt: r.expiresAt,
        expiredAt: r.expiredAt,
        downloads: r.downloads,
        downloadsLeft: r.status === 'ready' ? Math.max(0, MAX_DOWNLOADS - r.downloads) : 0,
        revision: r.revision,
        may: {
          approve: r.status === 'requested' && !mine && r.lapsesAt.getTime() > now,
          refuse: r.status === 'requested' && !mine,
          cancel: mine && (r.status === 'requested' || r.status === 'approved'),
          download: downloadable && (mine || r.approvedBy === auth.user.id),
        },
      };
    });
  }

  /** The exports, newest first. */
  list(auth: AuthContext, query: { page?: number; pageSize?: number }) {
    const pageSize = query.pageSize ?? 20;
    const page = query.page ?? 1;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const rows = await tx
        .select()
        .from(dataExports)
        .orderBy(desc(dataExports.requestedAt), desc(dataExports.id))
        .limit(pageSize + 1)
        .offset((page - 1) * pageSize);
      return { items: await this.view(tx, auth, rows.slice(0, pageSize)), more: rows.length > pageSize, page };
    });
  }

  private async one(tx: Transaction, id: string) {
    const [row] = await tx.select().from(dataExports).where(eq(dataExports.id, id)).for('update');
    if (!row) throw new NotFoundException();
    return row;
  }

  /** Asks for an export. Nothing is made until another holder approves. */
  async request(
    auth: AuthContext,
    input: { reason: 'contract_end' | 'on_request'; note: string | null; locale?: Locale; includePdfs?: boolean; password: string },
    ip: string | null,
  ) {
    const locale = input.locale ?? auth.tenant.defaultLocale;
    if (!auth.tenant.locales.includes(locale)) throw new BadRequestException({ code: 'language_mismatch', field: 'locale' });
    await this.auth.confirmPassword(auth, input.password, 'data_export', ip);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [made] = await tx
        .insert(dataExports)
        .values({
          tenantId: auth.tenant.id,
          reason: input.reason,
          note: input.note,
          locale,
          includePdfs: input.includePdfs ?? false,
          requestedBy: auth.user.id,
          lapsesAt: sql`now() + make_interval(days => ${APPROVAL_DAYS})`,
        })
        .onConflictDoNothing()
        .returning();
      if (!made) throw new ConflictException({ code: 'export_in_progress' });
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'data_export_requested', 'tenant', auth.tenant.id, {
        exportId: made.id,
        reason: made.reason,
        note: made.note,
        locale: made.locale,
        includePdfs: made.includePdfs,
      }, ip);
      await tellOfExport(tx, auth.tenant.id, made.id, 'requested', (await authorityOf(tx)).filter((u) => u !== auth.user.id));
      return (await this.view(tx, auth, [made]))[0];
    });
  }

  /** The second person's approval: the worker makes it next. */
  async approve(auth: AuthContext, id: string, input: { password: string; revision: number }, ip: string | null) {
    // Who asked is checked before the password, so that the one who asked
    // is told so rather than asked for a password that would not do.
    await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [row] = await tx.select({ requestedBy: dataExports.requestedBy }).from(dataExports).where(eq(dataExports.id, id));
      if (!row) throw new NotFoundException();
      if (row.requestedBy === auth.user.id) throw new ForbiddenException({ code: 'same_person' });
      const dependence = await dependenceOf(tx, auth.user.id, row.requestedBy);
      if (dependence) throw new ForbiddenException({ code: 'approver_not_independent', reason: dependence });
    });
    await this.auth.confirmPassword(auth, input.password, 'data_export', ip);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const row = await this.one(tx, id);
      if (row.requestedBy === auth.user.id) throw new ForbiddenException({ code: 'same_person' });
      const dependence = await dependenceOf(tx, auth.user.id, row.requestedBy);
      if (dependence) throw new ForbiddenException({ code: 'approver_not_independent', reason: dependence });
      if (row.status === 'lapsed' || (row.status === 'requested' && row.lapsesAt.getTime() <= Date.now())) {
        throw new ConflictException({ code: 'lapsed' });
      }
      if (row.status !== 'requested' || row.revision !== input.revision) throw new ConflictException({ code: 'stale_export' });
      const [done] = await tx
        .update(dataExports)
        .set({ status: 'approved', approvedBy: auth.user.id, approvedAt: sql`now()`, revision: row.revision + 1, updatedAt: sql`now()` })
        .where(eq(dataExports.id, id))
        .returning();
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'data_export_approved', 'tenant', auth.tenant.id, { exportId: id }, ip);
      await tellOfExport(tx, auth.tenant.id, id, 'approved', (await authorityOf(tx)).filter((u) => u !== auth.user.id));
      return (await this.view(tx, auth, [done]))[0];
    });
  }

  /** Refused by another holder, with the reason. */
  refuse(auth: AuthContext, id: string, input: { reason: string; revision: number }, ip: string | null) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const row = await this.one(tx, id);
      if (row.requestedBy === auth.user.id) throw new ForbiddenException({ code: 'same_person' });
      if (row.status !== 'requested' || row.revision !== input.revision) throw new ConflictException({ code: 'stale_export' });
      const [done] = await tx
        .update(dataExports)
        .set({
          status: 'refused',
          refusedBy: auth.user.id,
          refusedAt: sql`now()`,
          refusedReason: input.reason,
          revision: row.revision + 1,
          updatedAt: sql`now()`,
        })
        .where(eq(dataExports.id, id))
        .returning();
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'data_export_refused', 'tenant', auth.tenant.id, {
        exportId: id,
        reason: input.reason,
      }, ip);
      await tellOfExport(tx, auth.tenant.id, id, 'refused', [...(await authorityOf(tx)), row.requestedBy].filter((u) => u !== auth.user.id));
      return (await this.view(tx, auth, [done]))[0];
    });
  }

  /** Cancelled by the one who asked, until it is being made. */
  cancel(auth: AuthContext, id: string, input: { revision: number }, ip: string | null) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const row = await this.one(tx, id);
      if (row.requestedBy !== auth.user.id) throw new ForbiddenException({ code: 'not_requester' });
      if (!['requested', 'approved'].includes(row.status) || row.revision !== input.revision) {
        throw new ConflictException({ code: 'stale_export' });
      }
      const [done] = await tx
        .update(dataExports)
        .set({ status: 'cancelled', cancelledAt: sql`now()`, revision: row.revision + 1, updatedAt: sql`now()` })
        .where(eq(dataExports.id, id))
        .returning();
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'data_export_cancelled', 'tenant', auth.tenant.id, { exportId: id }, ip);
      await tellOfExport(tx, auth.tenant.id, id, 'cancelled', (await authorityOf(tx)).filter((u) => u !== auth.user.id));
      return (await this.view(tx, auth, [done]))[0];
    });
  }

  /**
   * A download, counted and audited before a byte is sent: what the caller
   * gets to send it with. The person who asked or the approver only.
   */
  async download(auth: AuthContext, id: string, input: { password: string }, ip: string | null) {
    await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [row] = await tx.select({ requestedBy: dataExports.requestedBy, approvedBy: dataExports.approvedBy }).from(dataExports).where(eq(dataExports.id, id));
      if (!row) throw new NotFoundException();
      if (row.requestedBy !== auth.user.id && row.approvedBy !== auth.user.id) throw new ForbiddenException({ code: 'not_yours' });
    });
    await this.auth.confirmPassword(auth, input.password, 'data_export', ip);
    // The archive checked whole before a download is counted: one that
    // cannot be opened is never recorded as downloaded (security review
    // 19, L4).
    const [stored] = await this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx.select({ storageKey: dataExports.storageKey, wrappedKey: dataExports.wrappedKey, status: dataExports.status }).from(dataExports).where(eq(dataExports.id, id)),
    );
    if (stored?.status === 'ready' && stored.storageKey && stored.wrappedKey) {
      try {
        await this.storage.verify(stored.storageKey, stored.wrappedKey);
      } catch {
        throw new ConflictException({ code: 'archive_unavailable' });
      }
    }
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const row = await this.one(tx, id);
      if (row.requestedBy !== auth.user.id && row.approvedBy !== auth.user.id) throw new ForbiddenException({ code: 'not_yours' });
      if (row.status === 'expired' || (row.status === 'ready' && row.expiresAt && row.expiresAt.getTime() <= Date.now())) {
        throw new GoneException({ code: 'expired' });
      }
      if (row.status !== 'ready' || !row.storageKey || !row.wrappedKey) throw new ConflictException({ code: 'not_ready' });
      if (row.downloads >= MAX_DOWNLOADS) throw new ConflictException({ code: 'download_limit' });
      const download = row.downloads + 1;
      await tx
        .update(dataExports)
        .set({ downloads: download, lastDownloadedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(dataExports.id, id));
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'data_export_downloaded', 'tenant', auth.tenant.id, {
        exportId: id,
        archiveSha256: row.archiveSha256,
        download,
      }, ip);
      await tellOfExport(tx, auth.tenant.id, id, 'downloaded', (await authorityOf(tx)).filter((u) => u !== auth.user.id));
      return {
        storageKey: row.storageKey,
        wrappedKey: row.wrappedKey,
        sizeBytes: row.sizeBytes,
        sha256: row.archiveSha256,
        fileName: `trustline-export-${auth.tenant.slug.replace(/[^A-Za-z0-9-]/g, '-')}-${dayOf(row.snapshotAt ?? new Date(), auth.tenant.timeZone)}.zip`,
      };
    });
  }
}

