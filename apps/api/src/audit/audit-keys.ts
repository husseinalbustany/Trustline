import { Injectable } from '@nestjs/common';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { checkpointMessage } from './chain.js';

/** The variable holding Trustline's private key for checkpoints. */
export const SIGNING_KEY_VARIABLE = 'AUDIT_SIGNING_KEY';
/** The variable holding the public keys of keys replaced since. */
export const PREVIOUS_KEYS_VARIABLE = 'AUDIT_PREVIOUS_PUBLIC_KEYS';
/**
 * Key ids no longer known, deliberately: a checkpoint signed by one is
 * passed over. Any other unknown key id is a break (security review 12, M2).
 */
export const RETIRED_KEYS_VARIABLE = 'AUDIT_RETIRED_KEY_IDS';

/** A key's id: derived from the public key, so that nothing names it twice. */
const keyIdOf = (publicKey: KeyObject) =>
  `ed25519-${createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')
    .slice(0, 16)}`;

/** A key from a variable: a PEM, or the DER in base64 on one line. */
function readKey(value: string, kind: 'private' | 'public'): KeyObject {
  const text = value.trim().replaceAll('\\n', '\n');
  const pem = text.includes('-----BEGIN');
  const key =
    kind === 'private'
      ? createPrivateKey(pem ? text : { key: Buffer.from(text, 'base64'), format: 'der', type: 'pkcs8' })
      : createPublicKey(pem ? text : { key: Buffer.from(text, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
  return key;
}

export type PublishedKey = { keyId: string; algorithm: 'Ed25519'; publicKey: string; current: boolean };

/**
 * Trustline's keys for the audit chain's checkpoints (Ed25519), from the
 * environment, never from a table (docs/specs/audit-trail.md, "Signed
 * checkpoints"): `AUDIT_SIGNING_KEY` signs, and `AUDIT_PREVIOUS_PUBLIC_KEYS`
 * still checks what keys replaced since signed. Without a signing key the
 * API runs all the same: the checks report "unsigned", and `problem` names
 * the variable, never its value.
 */
@Injectable()
export class AuditKeys {
  readonly signer: { keyId: string; key: KeyObject } | null;
  readonly verifiers = new Map<string, KeyObject>();
  readonly retired = new Set<string>();
  readonly published: PublishedKey[] = [];
  readonly problem: string | null;

  constructor() {
    const problems: string[] = [];
    let signer: AuditKeys['signer'] = null;
    const value = process.env[SIGNING_KEY_VARIABLE]?.trim();
    if (!value) {
      problems.push(`${SIGNING_KEY_VARIABLE} is not set: audit checkpoints are not signed`);
    } else {
      try {
        const key = readKey(value, 'private');
        const publicKey = createPublicKey(key);
        signer = { keyId: keyIdOf(publicKey), key };
        this.add(publicKey, true);
      } catch {
        problems.push(`${SIGNING_KEY_VARIABLE} is not an Ed25519 private key: audit checkpoints are not signed`);
      }
    }
    for (const [i, item] of (process.env[PREVIOUS_KEYS_VARIABLE] ?? '').split(',').entries()) {
      if (!item.trim()) continue;
      try {
        this.add(readKey(item, 'public'), false);
      } catch {
        problems.push(`${PREVIOUS_KEYS_VARIABLE}: key ${i + 1} is not an Ed25519 public key, and is left out`);
      }
    }
    for (const id of (process.env[RETIRED_KEYS_VARIABLE] ?? '').split(',')) {
      if (id.trim()) this.retired.add(id.trim());
    }
    this.signer = signer;
    this.problem = problems.length > 0 ? problems.join('; ') : null;
  }

  private add(publicKey: KeyObject, current: boolean) {
    const keyId = keyIdOf(publicKey);
    if (this.verifiers.has(keyId)) return;
    this.verifiers.set(keyId, publicKey);
    this.published.push({
      keyId,
      algorithm: 'Ed25519',
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      current,
    });
  }

  /** Signs a checkpoint, or says it cannot (no key). */
  sign(cp: Parameters<typeof checkpointMessage>[0]) {
    if (!this.signer) return { keyId: null, signature: null };
    return {
      keyId: this.signer.keyId,
      signature: sign(null, Buffer.from(checkpointMessage(cp), 'utf8'), this.signer.key).toString('base64'),
    };
  }

  /**
   * Whether a checkpoint's signature holds: `retired` for a key listed as
   * retired, `unknown` for any other key this API does not know (a break),
   * `unsigned` for none.
   */
  check(
    cp: Parameters<typeof checkpointMessage>[0] & { keyId: string | null; signature: string | null },
  ): 'valid' | 'invalid' | 'retired' | 'unknown' | 'unsigned' {
    if (!cp.keyId || !cp.signature) return 'unsigned';
    const key = this.verifiers.get(cp.keyId);
    if (!key) return this.retired.has(cp.keyId) ? 'retired' : 'unknown';
    try {
      return verify(null, Buffer.from(checkpointMessage(cp), 'utf8'), key, Buffer.from(cp.signature, 'base64'))
        ? 'valid'
        : 'invalid';
    } catch {
      return 'invalid';
    }
  }
}
