import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { signatures } from '../database/schema.js';

export type SignatureMeaning = (typeof signatures.meaning.enumValues)[number];
export type SignedSubject = 'document_version' | 'document';

/**
 * JSON with every object's keys in order, so that the same content always
 * gives the same text, whatever order it was built in. Arrays keep their
 * order: in a document, order is meaning. `undefined` is left out, as
 * JSON.stringify does; anything else that is not JSON is refused.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: not finite');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: cannot write a ${typeof value}`);
}

/**
 * The hash a signature keeps of exactly what was signed: SHA-256, in hex,
 * of its canonical JSON. Anyone holding the same content can recompute it
 * and see that nothing was changed after it was signed.
 */
export const contentHash = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');

/**
 * Electronic signatures. Generic: a document version's approval, a
 * document's periodic review, an acknowledgement; later an investigation's.
 *
 * A signature is written only by a request in which the signer re-entered
 * their password (`AuthService.confirmPassword`, which the caller of `sign`
 * must have called first, in the same request), and the application role
 * may add and read signatures, never change or delete one.
 */
@Injectable()
export class SignatureService {
  /** Writes one, in the caller's transaction, and returns it. */
  async sign(
    tx: Transaction,
    tenantId: string,
    input: {
      userId: string;
      meaning: SignatureMeaning;
      subjectType: SignedSubject;
      subjectId: string;
      /** What was signed, as it is hashed. */
      content: unknown;
    },
  ) {
    const [signature] = await tx
      .insert(signatures)
      .values({
        tenantId,
        userId: input.userId,
        meaning: input.meaning,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        contentHash: contentHash(input.content),
        method: 'password',
      })
      .returning({
        id: signatures.id,
        userId: signatures.userId,
        meaning: signatures.meaning,
        signedAt: signatures.signedAt,
        contentHash: signatures.contentHash,
      });
    return signature;
  }

  /** The signatures on these subjects, oldest first. */
  of(tx: Transaction, subjectType: SignedSubject, subjectIds: string[]) {
    if (subjectIds.length === 0) return Promise.resolve([]);
    return tx
      .select({
        id: signatures.id,
        userId: signatures.userId,
        meaning: signatures.meaning,
        subjectId: signatures.subjectId,
        signedAt: signatures.signedAt,
        contentHash: signatures.contentHash,
        method: signatures.method,
      })
      .from(signatures)
      .where(
        and(
          eq(signatures.subjectType, subjectType),
          inArray(signatures.subjectId, subjectIds),
        ),
      )
      .orderBy(asc(signatures.signedAt), asc(signatures.id));
  }
}
