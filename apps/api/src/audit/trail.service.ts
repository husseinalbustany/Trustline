import { Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { ApprovalEngine } from '../approvals/approval-engine.service.js';
import type { Transaction } from '../database/client.js';
import { documents, incidents } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { pickText, type Locale, type Localized } from '../i18n/locales.js';
import { dayOf, momentIn, shiftDay, startOfDay } from '../i18n/time-zones.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { covers } from '../identity/scope.js';
import { reporterToldTo, visibleTo } from '../incidents/visibility.js';
import { csv, csvFileName } from '../policies/csv.js';
import { viewerOf, visible as documentVisible } from '../policies/visibility.js';
import {
  AUDIT_ACTIONS,
  moduleOfAction,
  type AuditAction,
  type AuditActor,
  type AuditArea,
  type AuditEntityType,
} from './actions.js';
import { AuditKeys } from './audit-keys.js';
import { bodyOf } from './chain.js';
import { AUDIT_WORDING } from './wording/index.js';

/** What the trail is filtered by, on screen and exported. */
export type TrailFilters = {
  from?: string;
  to?: string;
  actorId?: string;
  actions?: AuditAction[];
  area?: AuditArea;
  entityType?: AuditEntityType;
  entityId?: string;
  reference?: string;
};

/** No count runs over more than this: "more than 10,000". */
export const TOTAL_CAP = 10_000;
/** The most rows a CSV of the trail holds, as every other export. */
export const EXPORT_CAP = 50_000;
/** Entries read per statement, for the chain file. */
const CHAIN_BATCH = 5_000;

const ACTIONS = Object.keys(AUDIT_ACTIONS) as AuditAction[];
/** The actions whose actor may be an incident's reporter (spec, "Masking"). */
const MASKABLE = ACTIONS.filter((a) => 'maskActor' in AUDIT_ACTIONS[a]);
const BY_PLATFORM = ACTIONS.filter((a) => AUDIT_ACTIONS[a].by === 'platform');

const list = (values: string[]) =>
  values.length > 0
    ? sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`
    : sql`'{}'::text[]`;

export type Actor =
  | { kind: 'person'; id: string; name: Localized | null }
  | { kind: Exclude<AuditActor, 'trustline_staff'> }
  | { kind: 'trustline_staff'; name: string | null };

type Row = {
  id: string;
  at: string;
  at_sort: string;
  occurred_at: string;
  actor_id: string | null;
  actor_name: Localized | null;
  action: AuditAction;
  entity_type: AuditEntityType | null;
  entity_id: string | null;
  changes: Record<string, unknown> | null;
  ip_address: string | null;
  seq: string | null;
  sealed_late: boolean | null;
  masked: boolean;
  told: boolean;
  label_text: string | null;
  label_name: Localized | null;
  can_open: boolean;
};

/**
 * When the client's trail was sealed, and how many entries were there
 * before: from the first sealed `audit_chain_started` entry, which the
 * chain itself covers (security review 12, L1), not from a seal's own
 * column. A client made since was sealed from its start.
 */
export async function sealedBeforeIn(tx: Transaction) {
  const { rows } = await tx.execute<{ changes: { sealedOn?: string; sealedBefore?: number } | null }>(sql`
    select a.changes from audit_log a
    join audit_chain c on c.tenant_id = a.tenant_id and c.entry_id = a.id
    where a.action = 'audit_chain_started'
    order by c.seq
    limit 1`);
  const changes = rows[0]?.changes ?? null;
  return {
    sealedOn: typeof changes?.sealedOn === 'string' ? changes.sealedOn : null,
    sealedBefore: typeof changes?.sealedBefore === 'number' ? changes.sealedBefore : 0,
  };
}

/** A cursor: the time and id of the last entry of a page. */
const cursorOf = (row: { at_sort: string; id: string }) =>
  Buffer.from(`${row.at_sort}|${row.id}`, 'utf8').toString('base64url');
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/;
export const readCursor = (cursor: string) => {
  const m = CURSOR.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return m ? { at: m[1], id: m[2] } : null;
};

/**
 * The client's audit trail as the viewer and its files show it
 * (docs/specs/audit-trail.md, "The viewer" and "How anyone can check it
 * themselves"). Read-only. For holders of `audit.view` for the whole
 * organization (the routes check it), within the client's transaction.
 *
 * - **Modules:** an entry of a module the client does not have is not
 *   shown, nor counted; it stays in the chain file as a seal only.
 * - **Masking:** whoever reported an incident, and whether the report was
 *   anonymous, is shown only to those told the reporter
 *   (`reporterToldTo`, the rule of the incident screens). Everyone else
 *   sees "The reporter", and a person filter does not match those entries.
 * - **Details:** every entry's, as recorded (`audit.view` is a deliberate
 *   permission for auditors), less what masking hides. Links open only
 *   what the caller may open (`canOpen`).
 */
@Injectable()
export class TrailService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly engine: ApprovalEngine,
    private readonly provisioning: ProvisioningService,
    private readonly keys: AuditKeys,
  ) {}

  /** The actions shown to this client: those of the modules it has. */
  private shownActions(auth: AuthContext) {
    return ACTIONS.filter((a) => {
      const module = moduleOfAction(a);
      return module === 'core' || (auth.tenant.modules as string[]).includes(module);
    });
  }

  /** Whether an entry is masked for the caller, as SQL over the row. */
  private maskedSql(auth: AuthContext): SQL {
    return sql`(a.action = any(${list(MASKABLE)}) and a.entity_type = 'incident' and not coalesce(${reporterToldTo(auth)}, false) and (
      a.action = 'incident_reported'
      or (a.action = 'incident_commented' and coalesce((a.changes ->> 'byReporter')::boolean, false))
      or (a.actor_id is not null and a.actor_id = ${incidents.reportedBy})))`;
  }

  /** The filters, as SQL over `audit_log a`; null when nothing can match. */
  private async whereOf(tx: Transaction, auth: AuthContext, filters: TrailFilters): Promise<SQL | null> {
    const shown = this.shownActions(auth);
    let actions = shown;
    if (filters.area) actions = actions.filter((a) => AUDIT_ACTIONS[a].area === filters.area);
    if (filters.actions) actions = actions.filter((a) => filters.actions!.includes(a));
    if (actions.length === 0) return null;
    const parts: SQL[] = [sql`a.action = any(${list(actions)})`];
    const zone = auth.tenant.timeZone;
    if (filters.from) parts.push(sql`a.occurred_at >= ${startOfDay(filters.from, zone)}`);
    if (filters.to) parts.push(sql`a.occurred_at < ${startOfDay(shiftDay(filters.to, 1), zone)}`);
    if (filters.actorId) {
      // Never an entry whose actor the caller may not see.
      parts.push(sql`a.actor_id = ${filters.actorId}::uuid and not ${this.maskedSql(auth)}`);
    }
    if (filters.reference) {
      // An incident's reference or a document's number, as written.
      const { rows } = await tx.execute<{ type: string; id: string }>(sql`
        select 'incident' as type, id from incidents where reference = ${filters.reference}
        union all
        select 'document', id from documents where number = ${filters.reference}`);
      if (rows.length === 0) return null;
      parts.push(
        sql`(${sql.join(rows.map((r) => sql`(a.entity_type = ${r.type} and a.entity_id = ${r.id}::uuid)`), sql` or `)})`,
      );
    } else if (filters.entityType) {
      parts.push(sql`a.entity_type = ${filters.entityType}`);
      if (filters.entityId) parts.push(sql`a.entity_id = ${filters.entityId}::uuid`);
    }
    return sql.join(parts, sql` and `);
  }

  /** The entries' rows: with their seal, their actor, their record. */
  private async rows(
    tx: Transaction,
    auth: AuthContext,
    where: SQL,
    page: { before?: { at: string; id: string }; limit: number },
  ) {
    const has = (m: string) => (auth.tenant.modules as string[]).includes(m);
    const seesIncident = has('incidents') ? sql`coalesce(${visibleTo(auth)}, false)` : sql`false`;
    const seesDocument = has('policies')
      ? sql`coalesce(${documentVisible(await viewerOf(tx, auth, this.engine), this.engine)}, false)`
      : sql`false`;
    const may = (p: Parameters<typeof covers>[1]) => (covers(auth, p, null) ? sql`true` : sql`false`);
    const { rows } = await tx.execute<Row>(sql`
      select a.id,
             to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
             to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_sort,
             a.occurred_at::text as occurred_at,
             a.actor_id, u.name as actor_name, a.action, a.entity_type, a.entity_id, a.changes,
             a.ip_address, c.seq::text as seq, c.sealed_late,
             ${this.maskedSql(auth)} as masked,
             coalesce(${reporterToldTo(auth)}, false) as told,
             case a.entity_type
               when 'incident' then ${incidents.reference}
               when 'document' then ${documents.number}
             end as label_text,
             case a.entity_type
               when 'user' then eu.name
               when 'role' then r.name
               when 'org_unit' then ou.name
               when 'document_type' then dt.name
               when 'document_category' then dc.name
               when 'approval_route' then to_jsonb(ar.name)
             end as label_name,
             case a.entity_type
               when 'incident' then ${incidents.id} is not null and ${seesIncident}
               when 'document' then ${documents.id} is not null and ${seesDocument}
               when 'user' then eu.id is not null and ${may('users.manage')}
               when 'role' then r.id is not null and ${may('roles.manage')}
               when 'org_unit' then ou.id is not null and ${may('organization.manage')}
               else false
             end as can_open
      from audit_log a
      left join audit_chain c on c.tenant_id = a.tenant_id and c.entry_id = a.id
      left join users u on u.id = a.actor_id
      left join ${incidents} on a.entity_type = 'incident' and ${incidents.id} = a.entity_id
      left join ${documents} on a.entity_type = 'document' and ${documents.id} = a.entity_id
      left join users eu on a.entity_type = 'user' and eu.id = a.entity_id
      left join roles r on a.entity_type = 'role' and r.id = a.entity_id
      left join org_units ou on a.entity_type = 'org_unit' and ou.id = a.entity_id
      left join document_types dt on a.entity_type = 'document_type' and dt.id = a.entity_id
      left join document_categories dc on a.entity_type = 'document_category' and dc.id = a.entity_id
      left join approval_routes ar on a.entity_type = 'approval_route' and ar.id = a.entity_id
      where ${where}
        ${page.before ? sql`and (a.occurred_at, a.id) < (${page.before.at}::timestamptz, ${page.before.id}::uuid)` : sql``}
      order by a.occurred_at desc, a.id desc
      limit ${page.limit}`);
    return rows;
  }

  /** One entry as the viewer shows it. `sealedBefore`: see `sealedBeforeIn`. */
  private shown(row: Row, sealedBefore: number) {
    const info = AUDIT_ACTIONS[row.action];
    const details = row.changes ? { ...row.changes } : null;
    if (row.masked && details) {
      delete details.anonymous;
      delete details.byReporter;
    }
    let actor: Actor;
    if (row.masked) actor = { kind: 'reporter' };
    else if (row.actor_id) actor = { kind: 'person', id: row.actor_id, name: row.actor_name };
    else if ((BY_PLATFORM as string[]).includes(row.action)) {
      const name = row.changes?.platformAdminName;
      actor = { kind: 'trustline_staff', name: typeof name === 'string' ? name : null };
    } else if (
      row.entity_type === 'incident' &&
      row.told &&
      (row.action === 'incident_reported' || row.changes?.byReporter === true)
    ) {
      actor = { kind: 'anonymous' };
    } else actor = { kind: 'system' };
    return {
      id: row.id,
      seq: row.seq === null ? null : Number(row.seq),
      at: row.at,
      actor,
      action: row.action,
      area: info.area,
      entity: row.entity_type
        ? {
            type: row.entity_type,
            id: row.entity_id,
            label: row.label_text ?? row.label_name,
            canOpen: row.can_open,
          }
        : null,
      details,
      // The address, for sign-in entries only, while it is kept.
      ip: info.area === 'sign_in' && !row.masked ? row.ip_address : null,
      // Recorded before the trail was sealed: by its number, which the
      // chain covers, never by the seal's own column.
      sealedLate: row.seq !== null && Number(row.seq) <= sealedBefore,
    };
  }

  /** A page of entries, newest first, by key, with a total capped at 10,000. */
  entries(auth: AuthContext, input: TrailFilters & { before?: string; pageSize: number }) {
    const { before, pageSize, ...filters } = input;
    const cursor = before ? readCursor(before) : null;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const where = await this.whereOf(tx, auth, filters);
      if (!where) return { items: [], more: false, next: null, total: 0, totalCapped: false };
      const rows = await this.rows(tx, auth, where, { before: cursor ?? undefined, limit: pageSize + 1 });
      const { rows: counted } = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from (
          select 1 from audit_log a
          left join ${incidents} on a.entity_type = 'incident' and ${incidents.id} = a.entity_id
          where ${where} limit ${TOTAL_CAP + 1}) t`);
      const { sealedBefore } = await sealedBeforeIn(tx);
      const page = rows.slice(0, pageSize);
      const more = rows.length > pageSize;
      return {
        items: page.map((r) => this.shown(r, sealedBefore)),
        more,
        next: more ? cursorOf(page.at(-1)!) : null,
        total: Math.min(counted[0].n, TOTAL_CAP),
        totalCapped: counted[0].n > TOTAL_CAP,
      };
    });
  }

  /**
   * The filtered trail as a CSV file, in the caller's language, at most
   * 50,000 rows, newest first. Audited, with its filters.
   */
  exportEntries(auth: AuthContext, filters: TrailFilters, locale: Locale) {
    const zone = auth.tenant.timeZone;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const words = AUDIT_WORDING[locale];
      const where = await this.whereOf(tx, auth, filters);
      const rows = where ? await this.rows(tx, auth, where, { limit: EXPORT_CAP }) : [];
      const { sealedBefore } = await sealedBeforeIn(tx);
      const name = (value: Localized | string | null | undefined) =>
        value == null ? null : typeof value === 'string' ? value : pickText(value, locale, auth.tenant.defaultLocale);
      const who = (actor: Actor) =>
        actor.kind === 'person'
          ? name(actor.name)
          : actor.kind === 'trustline_staff'
            ? actor.name
              ? `${words.actors.trustline_staff} (${actor.name})`
              : words.actors.trustline_staff
            : words.actors[actor.kind];
      const body = csv(
        [
          words.csv.seq,
          words.csv.at,
          words.csv.who,
          words.csv.area,
          words.csv.action,
          words.csv.recordType,
          words.csv.record,
          words.csv.details,
          words.csv.address,
          words.csv.sealedLate,
        ],
        rows.map((row) => {
          const e = this.shown(row, sealedBefore);
          return [
            e.seq,
            momentIn(new Date(row.occurred_at), zone),
            who(e.actor),
            words.areas[e.area],
            words.actions[e.action],
            e.entity ? words.entities[e.entity.type] : null,
            e.entity ? name(e.entity.label) : null,
            e.details ? JSON.stringify(e.details) : null,
            e.ip,
            e.sealedLate ? words.csv.yes : words.csv.no,
          ];
        }),
      );
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'audit_entries_exported', 'tenant', auth.tenant.id, {
        filters: { ...filters },
        locale,
        rows: rows.length,
      });
      return { body, fileName: csvFileName('audit-trail', dayOf(new Date(), zone)) };
    });
  }

  /**
   * The chain file of a range of entries (docs/specs/audit-trail.md,
   * "The chain file format"), written line by line to `write` as it is
   * read, by number, with no cap. Audited.
   */
  chainFile(
    auth: AuthContext,
    range: { fromSeq?: number; toSeq?: number },
    write: (line: string) => void,
  ) {
    const shown = this.shownActions(auth);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { rows: heads } = await tx.execute<{ seq: string | null }>(sql`select seq::text as seq from audit_chain_heads`);
      const head = Number(heads[0]?.seq ?? 0);
      const first = Math.max(1, range.fromSeq ?? 1);
      const last = Math.min(head, range.toSeq ?? head);
      const { rows: before } = await tx.execute<{ hash: string }>(
        sql`select hash from audit_chain where seq = ${first - 1}`,
      );
      const { rows: checkpoints } = await tx.execute<{
        seq: string; hash: string; at: Date; key_id: string | null; signature: string | null;
      }>(sql`
        select seq::text as seq, hash, at, key_id, signature from audit_chain_checkpoints
        where seq <= ${last} and (seq >= ${first} or seq = (select max(seq) from audit_chain_checkpoints where seq <= ${first}))
        order by seq, at`);
      write(
        JSON.stringify({
          type: 'header',
          format: 'trustline-audit-chain',
          version: 1,
          tenant: auth.tenant.id,
          organization: auth.tenant.slug,
          firstSeq: first,
          lastSeq: last,
          previousHash: first === 1 ? '0'.repeat(64) : (before[0]?.hash ?? null),
          madeAt: new Date().toISOString(),
          publicKeys: this.keys.published,
        }),
      );
      const { sealedBefore } = await sealedBeforeIn(tx);
      let entries = 0;
      let withheld = 0;
      for (let from = first; from <= last; from += CHAIN_BATCH) {
        const { rows } = await tx.execute<{
          seq: string; entry_id: string; prev_hash: string; body_hash: string; hash: string;
          ip_commitment: string | null; sealed_late: boolean; id: string | null; tenant_id: string | null;
          occurred_at: string | null; actor_id: string | null; action: string | null;
          entity_type: string | null; entity_id: string | null; changes: string | null;
          ip_address: string | null; ip_salt: string | null; masked: boolean | null;
        }>(sql`
          select c.seq::text as seq, c.entry_id, c.prev_hash, c.body_hash, c.hash, c.ip_commitment, c.sealed_late,
                 a.id, a.tenant_id::text as tenant_id,
                 to_char(a.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
                 a.actor_id::text as actor_id, a.action, a.entity_type, a.entity_id::text as entity_id,
                 a.changes::text as changes, a.ip_address, a.ip_salt,
                 ${this.maskedSql(auth)} as masked
          from audit_chain c
          left join audit_log a on a.id = c.entry_id and a.tenant_id = c.tenant_id
          left join ${incidents} on a.entity_type = 'incident' and ${incidents.id} = a.entity_id
          where c.seq between ${from} and ${Math.min(from + CHAIN_BATCH - 1, last)}
          order by c.seq`);
        for (const r of rows) {
          entries++;
          const line: Record<string, unknown> = {
            type: 'entry',
            seq: Number(r.seq),
            entryId: r.entry_id,
            prevHash: r.prev_hash,
            bodyHash: r.body_hash,
            hash: r.hash,
            sealedLate: Number(r.seq) <= sealedBefore,
          };
          // In full only what the caller may see in full: not a masked
          // entry, nor one of a module that is off, nor one gone.
          const full = r.id !== null && !r.masked && (shown as string[]).includes(r.action!);
          if (full) {
            line.body = bodyOf(
              {
                id: r.id!,
                tenantId: r.tenant_id!,
                occurredAt: r.occurred_at!,
                actorId: r.actor_id,
                action: r.action!,
                entityType: r.entity_type,
                entityId: r.entity_id,
                changes: r.changes,
              },
              Number(r.seq),
              r.ip_commitment,
            );
            // While kept, the address and its salt, to check against the
            // commitment the body holds.
            if (r.ip_address !== null) {
              line.ip = r.ip_address;
              line.ipSalt = r.ip_salt;
            }
          } else withheld++;
          write(JSON.stringify(line));
        }
      }
      for (const cp of checkpoints) {
        write(
          JSON.stringify({
            type: 'checkpoint',
            tenant: auth.tenant.id,
            seq: Number(cp.seq),
            hash: cp.hash,
            at: new Date(cp.at).toISOString(),
            keyId: cp.key_id,
            signature: cp.signature,
          }),
        );
      }
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'audit_chain_exported', 'tenant', auth.tenant.id, {
        fromSeq: first,
        toSeq: last,
        entries,
        withheld,
      });
      return { fileName: `audit-chain-${auth.tenant.slug.replace(/[^A-Za-z0-9-]/g, '-')}-${first}-${last}.jsonl` };
    });
  }

  /** The signed checkpoints, between two days, as a JSON file. Audited. */
  checkpoints(auth: AuthContext, range: { from?: string; to?: string }) {
    const zone = auth.tenant.timeZone;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const { rows } = await tx.execute<{
        seq: string; hash: string; at: Date; key_id: string | null; signature: string | null;
      }>(sql`
        select seq::text as seq, hash, at, key_id, signature from audit_chain_checkpoints
        where true
          ${range.from ? sql`and at >= ${startOfDay(range.from, zone)}` : sql``}
          ${range.to ? sql`and at < ${startOfDay(shiftDay(range.to, 1), zone)}` : sql``}
        order by seq, at`);
      await this.provisioning.audit(tx, auth.tenant.id, auth.user.id, 'audit_checkpoints_exported', 'tenant', auth.tenant.id, {
        from: range.from ?? null,
        to: range.to ?? null,
        checkpoints: rows.length,
      });
      return {
        file: {
          format: 'trustline-audit-checkpoints',
          version: 1,
          tenant: auth.tenant.id,
          organization: auth.tenant.slug,
          madeAt: new Date().toISOString(),
          publicKeys: this.keys.published,
          checkpoints: rows.map((cp) => ({
            tenant: auth.tenant.id,
            seq: Number(cp.seq),
            hash: cp.hash,
            at: new Date(cp.at).toISOString(),
            keyId: cp.key_id,
            signature: cp.signature,
          })),
        },
        fileName: `audit-checkpoints-${auth.tenant.slug.replace(/[^A-Za-z0-9-]/g, '-')}-${dayOf(new Date(), zone)}.json`,
      };
    });
  }
}
