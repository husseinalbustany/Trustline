import '../src/env.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { PublicLimits } from '../src/incidents/public-limits.js';
import { testBench } from './support/hospital.js';

// Temporary: measures how long each kind of follow-up refusal takes.
describe('timing of follow-up refusals', () => {
  it('measures', async () => {
    const bench = await testBench('tm', randomBytes(4).toString('hex'));
    const lines: string[] = [];
    try {
      const a = await bench.createHospital('a');
      const b = await bench.createHospital('b');
      const gone = await bench.createHospital('gone');
      const unitA = await bench.createUnit(a, 'facility', 'MAIN', null);
      const unitB = await bench.createUnit(b, 'facility', 'MAIN', null);
      const report = async (h: typeof a, unit: string) =>
        (
          await bench
            .http()
            .post('/incidents')
            .set('Cookie', h.cookie)
            .send({
              type: 'incident',
              categoryId: h.categories.equipment,
              orgUnitId: unit,
              occurredAt: new Date(Date.now() - 3600000).toISOString(),
              description: 'x',
              harmLevel: 'none',
              anonymous: true,
            })
            .expect(201)
        ).body.followUpCode as string;
      const codeA = await report(a, unitA);
      const codeB = await report(b, unitB);
      for (let i = 0; i < 300; i++) await report(a, unitA);
      await bench
        .http()
        .patch(`/platform/tenants/${gone.id}`)
        .set('Cookie', bench.platform)
        .send({ status: 'suspended' })
        .expect(200);
      const limits = bench.app.get(PublicLimits, { strict: false });
      const paths: Record<string, [string, string, number]> = {
        'right code (200)': [a.slug, codeA, 200],
        'wrong code, real hospital': [a.slug, 'K7QM-2RXD-9FHT-WB3N', 404],
        "another hospital's code": [a.slug, codeB, 404],
        'unknown hospital': [`${bench.prefix}-nowhere`, codeA, 404],
        'suspended hospital': [gone.slug, codeA, 404],
        'text that is no identifier': ['%00', codeA, 404],
      };
      const times: Record<string, number[]> = {};
      for (let round = 0; round < 400; round++) {
        for (const [name, [slug, code, status]] of Object.entries(paths)) {
          limits.forget();
          const start = process.hrtime.bigint();
          await bench
            .http()
            .post(`/public/follow-up/${slug}`)
            .send({ code })
            .expect(status);
          const ms = Number(process.hrtime.bigint() - start) / 1e6;
          if (round >= 50) (times[name] ??= []).push(ms);
        }
      }
      for (const [name, list] of Object.entries(times)) {
        list.sort((x, y) => x - y);
        lines.push(
          `${name}: median ${list[Math.floor(list.length / 2)].toFixed(2)} ms, p90 ${list[Math.floor(list.length * 0.9)].toFixed(2)} ms`,
        );
      }
    } finally {
      writeFileSync('/tmp/claude-0/-home-user-Trustline/27e57dce-c135-50c8-8f6c-7e38b18410e5/scratchpad/edit/timing.txt', lines.join('\n'));
      await bench.close();
    }
  }, 300_000);
});
