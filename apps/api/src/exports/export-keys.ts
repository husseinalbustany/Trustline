import { Injectable } from '@nestjs/common';
import { createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { keyIdOf, readKey, type PublishedKey } from '../audit/audit-keys.js';

/** The variable holding Trustline's private key for export manifests. */
export const EXPORT_SIGNING_KEY_VARIABLE = 'EXPORT_SIGNING_KEY';
/** The public keys of export keys replaced since, comma-separated. */
export const EXPORT_PREVIOUS_KEYS_VARIABLE = 'EXPORT_PREVIOUS_PUBLIC_KEYS';

/**
 * Trustline's keys for signing an export's manifest (Ed25519,
 * docs/specs/data-export.md, "Formats"): a key of its own, apart from the
 * audit checkpoints' key, from the same infrastructure and read the same
 * way (`audit-keys.ts`): from the environment, never from a table. Its
 * public keys are published beside the audit keys (`/audit/keys`,
 * `exportKeys`), so that an archive is checked against Trustline's site,
 * never against a key inside it. Without a key the API runs all the same
 * and archives are unsigned, which their README says; `main.ts` refuses to
 * start without one in production.
 */
@Injectable()
export class ExportKeys {
  readonly signer: { keyId: string; key: KeyObject } | null;
  readonly verifiers = new Map<string, KeyObject>();
  readonly published: PublishedKey[] = [];
  readonly problem: string | null;

  constructor() {
    const problems: string[] = [];
    let signer: ExportKeys['signer'] = null;
    const value = process.env[EXPORT_SIGNING_KEY_VARIABLE]?.trim();
    if (!value) {
      problems.push(`${EXPORT_SIGNING_KEY_VARIABLE} is not set: export manifests are not signed`);
    } else {
      try {
        const key = readKey(value, 'private');
        const publicKey = createPublicKey(key);
        signer = { keyId: keyIdOf(publicKey), key };
        this.add(publicKey, true);
      } catch {
        problems.push(`${EXPORT_SIGNING_KEY_VARIABLE} is not an Ed25519 private key: export manifests are not signed`);
      }
    }
    for (const [i, item] of (process.env[EXPORT_PREVIOUS_KEYS_VARIABLE] ?? '').split(',').entries()) {
      if (!item.trim()) continue;
      try {
        this.add(readKey(item, 'public'), false);
      } catch {
        problems.push(`${EXPORT_PREVIOUS_KEYS_VARIABLE}: key ${i + 1} is not an Ed25519 public key, and is left out`);
      }
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

  /** The signature of a manifest's bytes, or none without a key. */
  sign(manifest: Buffer) {
    if (!this.signer) return null;
    return { keyId: this.signer.keyId, signature: sign(null, manifest, this.signer.key).toString('base64') };
  }

  /** Whether a manifest's signature holds, by a key this API knows. */
  check(manifest: Buffer, signed: { keyId: string; signature: string }) {
    const key = this.verifiers.get(signed.keyId);
    if (!key) return false;
    try {
      return verify(null, manifest, key, Buffer.from(signed.signature, 'base64'));
    } catch {
      return false;
    }
  }
}
