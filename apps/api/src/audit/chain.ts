import { createHash } from 'node:crypto';

/**
 * The audit chain's format (docs/specs/audit-trail.md, "The chain"),
 * rebuilt outside the database: the daily check uses these, not the
 * database's own functions (migration 0058), so that a changed function
 * does not check itself. Both must give the same text, byte for byte.
 */

/** The hash before the first entry. */
export const GENESIS_HASH = '0'.repeat(64);

export const sha256 = (text: string) =>
  createHash('sha256').update(text, 'utf8').digest('hex');

/** An entry as the database renders it for hashing. */
export type EntryText = {
  id: string;
  tenantId: string;
  /** UTC, with microseconds: `2026-11-28T07:15:08.420807Z`. */
  occurredAt: string;
  actorId: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  /** `changes::text`, the database's own text of the JSON. */
  changes: string | null;
};

/** The fixed text of an entry that is hashed. */
export function bodyOf(entry: EntryText, seq: number, ipCommitment: string | null) {
  return [
    'trustline-audit-entry-v1',
    `id: ${entry.id}`,
    `tenant: ${entry.tenantId}`,
    `seq: ${seq}`,
    `occurredAt: ${entry.occurredAt}`,
    `actor: ${entry.actorId ?? ''}`,
    `action: ${entry.action}`,
    `entityType: ${entry.entityType ?? ''}`,
    `entityId: ${entry.entityId ?? ''}`,
    `changes: ${entry.changes ?? ''}`,
    `ip: ${ipCommitment ?? ''}`,
  ].join('\n');
}

/** An entry's hash: its number, the hash before it, and its body's hash. */
export const linkHash = (seq: number, prevHash: string, bodyHash: string) =>
  sha256(`trustline-audit-v1\n${seq}\n${prevHash}\n${bodyHash}`);

/** The commitment to an address the body holds instead of it. */
export const ipCommitmentOf = (salt: string | null, address: string) =>
  sha256(`${salt ?? ''}${address}`);

/** What a checkpoint signs. */
export const checkpointMessage = (cp: { tenantId: string; seq: number; hash: string; at: Date }) =>
  `trustline-audit-checkpoint-v1\n${cp.tenantId}\n${cp.seq}\n${cp.hash}\n${cp.at.toISOString()}`;
