import { Injectable, Logger } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Writable } from 'node:stream';

/** Where archives are kept: a volume of this deployment's own (decision 4). */
export const STORAGE_DIR_VARIABLE = 'EXPORT_STORAGE_DIR';
/** The key that wraps each archive's own key: 32 bytes, in base64. */
export const STORAGE_KEY_VARIABLE = 'EXPORT_STORAGE_KEY';

const MAGIC = Buffer.from('TLX1');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Where a finished archive waits to be downloaded
 * (docs/specs/data-export.md, "Kept until downloaded"), encrypted with a
 * key of its own (AES-256-GCM). That key is kept beside the export's
 * record only wrapped by the storage key, which is in the environment, and
 * which only the API processes hold. A file is named by client and export,
 * never by anything a caller sends, so one client's download cannot name
 * another's file. Deleted when the export expires; never in a backup of
 * the database.
 *
 * Today the volume is a directory (`EXPORT_STORAGE_DIR`), as for
 * single-tenant and on-premises deployments. Object storage in the
 * client's region and a key service (decision 4) take its place behind the
 * same three calls: `put`, `open`, `remove`.
 */
@Injectable()
export class ExportStorage {
  private readonly logger = new Logger(ExportStorage.name);
  readonly root: string;
  /** Whether the root was named for this deployment, and exists. */
  readonly configured: boolean;
  private readonly storageKey: Buffer;
  readonly problem: string | null;

  constructor() {
    const named = process.env[STORAGE_DIR_VARIABLE]?.trim();
    this.root = resolve(named || join(tmpdir(), 'trustline-exports'));
    this.configured = !!named && existsSync(this.root);
    const value = process.env[STORAGE_KEY_VARIABLE]?.trim();
    const key = value ? Buffer.from(value, 'base64') : null;
    if (key && key.length === 32) {
      this.storageKey = key;
      this.problem = null;
    } else {
      // Outside production only (main.ts refuses to start otherwise): a key
      // of this process, so an archive is downloadable from the process
      // that made it, until it restarts.
      this.storageKey = randomBytes(32);
      this.problem = `${STORAGE_KEY_VARIABLE} is not 32 bytes in base64: archives can be read only by the process that made them`;
    }
  }

  /** The root, made private to this process's user (security review 19, L5). */
  private async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }

  /**
   * A working directory for one attempt at an export, emptied first: each
   * attempt its own, so that a run that lost its claim never touches the
   * files of the run that took it over (security review 19, M2).
   */
  async workDir(tenantId: string, exportId: string, attempt: number) {
    await this.ensureRoot();
    const dir = this.pathOf(`work/${tenantId}/${exportId}/${attempt}`);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** Encrypts a finished archive into storage, under its attempt: its storage key and wrapped key. */
  async put(tenantId: string, exportId: string, attempt: number, file: string) {
    await this.ensureRoot();
    const storageKey = `${tenantId}/${exportId}/${attempt}.zip.enc`;
    const target = this.pathOf(storageKey);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const out = createWriteStream(target, { mode: 0o600 });
    out.write(Buffer.concat([MAGIC, iv]));
    await pipeline(createReadStream(file), cipher, out, { end: false });
    await new Promise<void>((done, fail) => out.end(cipher.getAuthTag(), (e?: Error | null) => (e ? fail(e) : done())));
    return { storageKey, wrappedKey: this.wrap(key) };
  }

  /**
   * Writes a stored archive, decrypted, to `into`. Its tag is checked at
   * the end: a file changed in storage fails there, and `into` is
   * destroyed rather than ended, so no download completes.
   */
  async open(storageKey: string, wrappedKey: string, into: Writable) {
    const path = this.pathOf(storageKey);
    const { size } = await stat(path);
    if (size < MAGIC.length + IV_BYTES + TAG_BYTES) throw new Error('archive too short');
    const handle = await open(path, 'r');
    const head = Buffer.alloc(MAGIC.length + IV_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    try {
      await handle.read(head, 0, head.length, 0);
      await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
    } finally {
      await handle.close();
    }
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an archive');
    const decipher = createDecipheriv('aes-256-gcm', this.unwrap(wrappedKey), head.subarray(MAGIC.length));
    decipher.setAuthTag(tag);
    const body = createReadStream(path, { start: head.length, end: size - TAG_BYTES - 1 });
    await pipeline(body, decipher, into);
  }

  /**
   * Checks a stored archive whole before a byte of it is sent (security
   * review 19, L4): its key unwraps, and its tag holds over all of it.
   */
  async verify(storageKey: string, wrappedKey: string) {
    const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
    await this.open(storageKey, wrappedKey, sink);
  }

  /** Deletes one attempt's working files. */
  async removeAttempt(tenantId: string, exportId: string, attempt: number) {
    await rm(this.pathOf(`work/${tenantId}/${exportId}/${attempt}`), { recursive: true, force: true });
  }

  /** Deletes a stored archive file. */
  async removeFile(storageKey: string | null) {
    if (storageKey) await rm(this.pathOf(storageKey), { force: true });
  }

  /** Deletes everything kept of one export: every attempt's archive and working files. */
  async removeExport(tenantId: string, exportId: string) {
    await rm(this.pathOf(`${tenantId}/${exportId}`), { recursive: true, force: true });
    await rm(this.pathOf(`work/${tenantId}/${exportId}`), { recursive: true, force: true });
  }

  /** Deletes everything kept of a client (its deletion; the tests' clean-up): how many archive files went. */
  async removeClient(tenantId: string) {
    const dir = this.pathOf(tenantId);
    let files = 0;
    if (existsSync(dir)) {
      for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) if (entry.isFile()) files++;
    }
    await rm(dir, { recursive: true, force: true });
    await rm(this.pathOf(`work/${tenantId}`), { recursive: true, force: true });
    return files;
  }

  /** A path inside the root, from ids and attempt numbers only. */
  private pathOf(relative: string) {
    const parts = relative.replace(/\.zip\.enc$/, '').split('/');
    if (!parts.every((p, i) => (p === 'work' && i === 0) || UUID.test(p) || (i > 0 && /^\d{1,4}$/.test(p)))) {
      throw new Error('not a storage key');
    }
    const path = resolve(this.root, relative);
    if (!path.startsWith(this.root + sep)) throw new Error('not a storage key');
    return path;
  }

  private wrap(key: Buffer) {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.storageKey, iv);
    const body = Buffer.concat([cipher.update(key), cipher.final()]);
    return Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
  }

  private unwrap(wrapped: string) {
    const raw = Buffer.from(wrapped, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.storageKey, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
  }

  /** Said once at start, as the other checks say what they lack. */
  warn() {
    if (this.problem) this.logger.warn(this.problem);
  }
}
