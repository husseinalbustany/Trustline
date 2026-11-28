import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog } from '../src/database/schema.js';
import { dayOf, shiftDay } from '../src/i18n/time-zones.js';
import { testBench, type Hospital, type Staff, type TestBench } from './support/hospital.js';

/**
 * A controlled document as a PDF (docs/specs/document-pdf.md): made by the
 * shared renderer, in one language or side by side in two, every page with
 * its header and footer, and audited.
 */
describe('a document version as a PDF', () => {
  const run = randomBytes(4).toString('hex');
  const password = `hospital-pass-${run}`;
  let bench: TestBench;
  let a: Hospital;
  let b: Hospital;
  let reporter: Staff;
  let doc: { id: string; number: string; published: { id: string } };
  let dir: string;
  const http = () => bench.http();
  const binary = (res: NodeJS.ReadableStream, done: (error: Error | null, body: Buffer) => void) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  };
  const pdf = (cookie: string, query = '', version = doc.published.id) =>
    http().get(`/policies/documents/${doc.id}/versions/${version}/pdf${query}`).set('Cookie', cookie).buffer(true).parse(binary as never);
  /** The text of each page, as a reader's tool takes it out. */
  const pagesOf = async (body: Buffer) => {
    const file = join(dir, `${randomBytes(4).toString('hex')}.pdf`);
    await writeFile(file, body);
    const count = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))![1]);
    // In content order (`-raw`), which keeps the rotated watermark, and so
    // with Arabic words in visual order; without the direction marks the
    // extraction adds around them; spaces collapsed.
    return Array.from({ length: count }, (_, i) =>
      execFileSync('pdftotext', ['-raw', '-f', String(i + 1), '-l', String(i + 1), file, '-'], { encoding: 'utf8' }).replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' '),
    );
  };
  const steps = Array.from({ length: 60 }, (_, i) => `${i + 1}. Mark the area and call the porters, step ${i + 1}.`).join('\n');
  const stepsAr = Array.from({ length: 60 }, (_, i) => `${i + 1}. اغسل يديك قبل كل عمل، الخطوة ${i + 1}.`).join('\n');

  beforeAll(async () => {
    bench = await testBench('dpdf', run);
    a = await bench.createHospital('a', { locales: ['en', 'ar'], defaultLocale: 'en' });
    b = await bench.createHospital('b');
    reporter = await bench.createStaff(a, 'reader', { role: 'reporter', orgUnitId: null });
    const quality = await bench.createStaff(a, 'quality', { role: 'quality_officer', orgUnitId: null });
    const unit = await bench.createUnit(a, 'department', 'D', null);
    const types = Object.fromEntries((await http().get('/policies/types').set('Cookie', a.cookie).expect(200)).body.map((t: { code: string; id: string }) => [t.code, t.id]));
    const categories = Object.fromEntries((await http().get('/policies/categories').set('Cookie', a.cookie).expect(200)).body.map((c: { code: string; id: string }) => [c.code, c.id]));
    const today = dayOf(new Date(), 'UTC');
    doc = (
      await http()
        .post('/policies/documents/import')
        .set('Cookie', quality.cookie)
        .send({
          password,
          typeId: types.procedure,
          categoryId: categories.SAF,
          title: { en: 'Handling a spill', ar: 'التعامل مع انسكاب' },
          ownerId: quality.id,
          ownerUnitId: unit,
          approvedOn: shiftDay(today, -300),
          approvedBy: 'Head of Operations',
          originalKeptAt: { en: 'Quality office' },
          nextReviewOn: shiftDay(today, 300),
          content: {
            en: { purpose: 'To make a **spill** safe.', steps },
            ar: { purpose: 'جعل مكان الانسكاب آمنًا.', steps: stepsAr },
          },
        })
        .expect(201)
    ).body;
    dir = await mkdtemp(join(tmpdir(), 'dpdf-'));
  }, 90_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await bench.close();
  });

  it('is refused without a session, for bad languages, and for another client', async () => {
    await http().get(`/policies/documents/${doc.id}/versions/${doc.published.id}/pdf`).expect(401);
    for (const query of ['?languages=fr', '?languages=en,ar,fr', '?languages=en,en', '?locale=fr', '?other=1']) {
      expect(`${query}: ${(await pdf(a.cookie, query)).status}`).toBe(`${query}: 400`);
    }
    expect((await pdf(b.cookie)).status).toBe(404);
  });

  it('makes the version side by side in two languages, every page with its header and footer, audited', async () => {
    const res = await pdf(reporter.cookie, '?languages=ar,en&locale=ar').expect(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=".+-v1-en-ar\.pdf"$/);
    const pages = await pagesOf(res.body as Buffer);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((text, i) => {
      expect(`page ${i + 1}: ${text.includes(doc.number)}`).toBe(`page ${i + 1}: true`);
      // "الصفحة x من y", the page's own language.
      expect(`page ${i + 1}: ${/الصفحة \d+ من \d+|\d+ من \d+ الصفحة/.test(text)}`).toBe(`page ${i + 1}: true`);
    });
    const all = pages.join('\n');
    expect(all).toContain('Mark the area and call the porters, step 60.');
    for (const word of ['اغسل', 'يديك', 'الخطوة']) expect(all).toContain(word);
    expect(all).toContain('Head of Operations');
    const [made] = await bench.owner.db
      .select({ changes: auditLog.changes, actorId: auditLog.actorId })
      .from(auditLog)
      .where(and(eq(auditLog.tenantId, a.id), eq(auditLog.action, 'document_pdf_made')));
    expect(made).toMatchObject({ actorId: reporter.id, changes: { versionId: doc.published.id, languages: ['en', 'ar'], locale: 'ar', pages: pages.length, sha256: res.headers['x-content-sha256'] } });
  }, 60_000);

  it('makes one language in one column, in its own direction', async () => {
    const pages = await pagesOf((await pdf(a.cookie, '?languages=en').expect(200)).body as Buffer);
    expect(pages[0]).toMatch(/Page 1 of \d+/);
    expect(pages.join('\n')).not.toContain('يديك');
  }, 60_000);

  it('carries a version’s standing across every page when it is not in force', async () => {
    await bench.owner.db.execute(sql`update documents set status = 'retired', retired_at = now() where id = ${doc.id}`);
    const pages = await pagesOf((await pdf(a.cookie, '?languages=en').expect(200)).body as Buffer);
    pages.forEach((text, i) => expect(`page ${i + 1}: ${text.includes('Retired, not in force')}`).toBe(`page ${i + 1}: true`));
  }, 60_000);
});
