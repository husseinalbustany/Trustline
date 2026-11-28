import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { constants, crc32, createDeflateRaw } from 'node:zlib';

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
/** An entry this large may compress past 4 GiB: given ZIP64 sizes from the start. */
const LARGE = 0xf0000000;

type Entry = { name: Buffer; crc: number; size: number; compressed: number; offset: number; zip64: boolean };

/** A day and time as DOS writes them, for every entry: the moment of the data. */
function dosTime(at: Date) {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * A ZIP archive written to a file entry by entry (docs/specs/data-export.md,
 * "Formats"): deflated, names in UTF-8, ZIP64 where a size, an offset or the
 * number of entries needs it, so that every system opens it without extra
 * software. Each entry is read twice from its file (its CRC, then its
 * compressed bytes), and never held whole in memory.
 */
export class ZipWriter {
  private file!: FileHandle;
  private offset = 0;
  private readonly entries: Entry[] = [];
  private readonly stamp: { time: number; date: number };

  private constructor(
    private readonly path: string,
    at: Date,
    private readonly forceZip64: boolean,
  ) {
    this.stamp = dosTime(at);
  }

  static async create(path: string, at: Date, options: { forceZip64?: boolean } = {}) {
    const zip = new ZipWriter(path, at, options.forceZip64 ?? false);
    zip.file = await open(path, 'w', 0o600);
    return zip;
  }

  private async write(data: Buffer, position = this.offset) {
    await this.file.write(data, 0, data.length, position);
    if (position === this.offset) this.offset += data.length;
  }

  /** Adds a file from disk, under a name in the archive (`a/b.jsonl`). */
  async addFile(name: string, source: string) {
    let crc = 0;
    let size = 0;
    for await (const chunk of createReadStream(source)) {
      crc = crc32(chunk as Buffer, crc);
      size += (chunk as Buffer).length;
    }
    await this.add(name, crc, size, () => createReadStream(source));
  }

  /** Adds bytes, under a name in the archive. */
  async addBuffer(name: string, data: Buffer) {
    await this.add(name, crc32(data), data.length, () => Readable.from([data]));
  }

  private async add(name: string, crc: number, size: number, read: () => Readable) {
    if (!/^[^/\\][^\\]*$/.test(name) || name.split('/').includes('..')) throw new Error('bad entry name');
    const nameBytes = Buffer.from(name, 'utf8');
    const zip64 = this.forceZip64 || size >= LARGE;
    const headerAt = this.offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(zip64 ? 45 : 20, 4);
    header.writeUInt16LE(0x0800, 6); // names in UTF-8
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt16LE(this.stamp.time, 10);
    header.writeUInt16LE(this.stamp.date, 12);
    header.writeUInt32LE(crc >>> 0, 14);
    header.writeUInt32LE(zip64 ? MAX32 : 0, 18); // compressed size, set after
    header.writeUInt32LE(zip64 ? MAX32 : size, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    const extra = zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
    if (zip64) {
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(size), 4);
    }
    header.writeUInt16LE(extra.length, 28);
    await this.write(Buffer.concat([header, nameBytes, extra]));
    const start = this.offset;
    for await (const chunk of read().pipe(createDeflateRaw({ level: constants.Z_DEFAULT_COMPRESSION }))) {
      await this.write(chunk as Buffer);
    }
    const compressed = this.offset - start;
    if (!zip64 && compressed >= MAX32) throw new Error('entry too large');
    // The compressed size, now known, into the header written before.
    if (zip64) {
      const field = Buffer.alloc(8);
      field.writeBigUInt64LE(BigInt(compressed));
      await this.write(field, headerAt + 30 + nameBytes.length + 12);
    } else {
      const field = Buffer.alloc(4);
      field.writeUInt32LE(compressed);
      await this.write(field, headerAt + 18);
    }
    this.entries.push({ name: nameBytes, crc, size, compressed, offset: headerAt, zip64: zip64 || headerAt >= MAX32 });
  }

  /** The central directory and its end: the archive is complete. Its size in bytes. */
  async close() {
    const directoryAt = this.offset;
    for (const e of this.entries) {
      const big = e.zip64 || this.forceZip64;
      const head = Buffer.alloc(46);
      head.writeUInt32LE(0x02014b50, 0);
      head.writeUInt16LE((3 << 8) | (big ? 45 : 20), 4); // made by Unix
      head.writeUInt16LE(big ? 45 : 20, 6);
      head.writeUInt16LE(0x0800, 8);
      head.writeUInt16LE(8, 10);
      head.writeUInt16LE(this.stamp.time, 12);
      head.writeUInt16LE(this.stamp.date, 14);
      head.writeUInt32LE(e.crc >>> 0, 16);
      head.writeUInt32LE(big ? MAX32 : e.compressed, 20);
      head.writeUInt32LE(big ? MAX32 : e.size, 24);
      head.writeUInt16LE(e.name.length, 28);
      const extra = big ? Buffer.alloc(28) : Buffer.alloc(0);
      if (big) {
        extra.writeUInt16LE(0x0001, 0);
        extra.writeUInt16LE(24, 2);
        extra.writeBigUInt64LE(BigInt(e.size), 4);
        extra.writeBigUInt64LE(BigInt(e.compressed), 12);
        extra.writeBigUInt64LE(BigInt(e.offset), 20);
      }
      head.writeUInt16LE(extra.length, 30);
      head.writeUInt32LE((0o100644 << 16) >>> 0, 38); // a regular file, rw-r--r--
      head.writeUInt32LE(big ? MAX32 : e.offset, 42);
      await this.write(Buffer.concat([head, e.name, extra]));
    }
    const directorySize = this.offset - directoryAt;
    const count = this.entries.length;
    const big = this.forceZip64 || count >= MAX16 || directoryAt >= MAX32 || directorySize >= MAX32;
    if (big) {
      const record = Buffer.alloc(56);
      const recordAt = this.offset;
      record.writeUInt32LE(0x06064b50, 0);
      record.writeBigUInt64LE(44n, 4);
      record.writeUInt16LE((3 << 8) | 45, 12);
      record.writeUInt16LE(45, 14);
      record.writeBigUInt64LE(BigInt(count), 24);
      record.writeBigUInt64LE(BigInt(count), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40);
      record.writeBigUInt64LE(BigInt(directoryAt), 48);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(recordAt), 8);
      locator.writeUInt32LE(1, 16);
      await this.write(Buffer.concat([record, locator]));
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(big ? MAX16 : count, 8);
    end.writeUInt16LE(big ? MAX16 : count, 10);
    end.writeUInt32LE(big ? MAX32 : directorySize, 12);
    end.writeUInt32LE(big ? MAX32 : directoryAt, 16);
    await this.write(end);
    await this.file.close();
    return this.offset;
  }

  /** Closes the file without finishing the archive (a failure). */
  async abort() {
    await this.file?.close().catch(() => undefined);
  }

  get name() {
    return this.path;
  }
}
