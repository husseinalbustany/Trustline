import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZipWriter } from './zip.js';

/** Info-ZIP's unzip, which every Linux has: what a client's system opens. */
const unzip = (...args: string[]) => execFileSync('unzip', args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

describe('the ZIP writer', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zip-spec-'));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it.each([false, true])('writes an archive unzip checks and opens as written (ZIP64: %s)', async (forceZip64) => {
    const big = randomBytes(300_000);
    const source = join(dir, `big-${forceZip64}.bin`);
    await writeFile(source, big);
    const path = join(dir, `a-${forceZip64}.zip`);
    const zip = await ZipWriter.create(path, new Date('2026-11-28T10:00:00Z'), { forceZip64 });
    await zip.addBuffer('README.ar.txt', Buffer.from('تصدير كامل للبيانات\n', 'utf8'));
    await zip.addFile('documents/DOC-1/v1/big.bin', source);
    await zip.addBuffer('empty.txt', Buffer.alloc(0));
    await zip.close();
    expect(unzip('-tq', path).toString()).toContain('No errors detected');
    expect(unzip('-p', path, 'README.ar.txt').toString('utf8')).toBe('تصدير كامل للبيانات\n');
    expect(unzip('-p', path, 'documents/DOC-1/v1/big.bin').equals(big)).toBe(true);
    expect(unzip('-Z1', path).toString().trim().split('\n')).toEqual(['README.ar.txt', 'documents/DOC-1/v1/big.bin', 'empty.txt']);
  });

  it('refuses a name that would leave the archive', async () => {
    const zip = await ZipWriter.create(join(dir, 'bad.zip'), new Date());
    await expect(zip.addBuffer('../x', Buffer.from('x'))).rejects.toThrow('bad entry name');
    await expect(zip.addBuffer('/etc/x', Buffer.from('x'))).rejects.toThrow('bad entry name');
    await zip.abort();
  });
});
