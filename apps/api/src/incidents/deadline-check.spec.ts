import { Logger } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import type { TenantDb } from '../database/tenant-db.service.js';
import {
  CHECK_STATEMENT_TIMEOUT_MS,
  DeadlineCheck,
} from './deadline-check.service.js';
import type { ProvisioningService } from '../identity/provisioning.service.js';
import type { Notifier } from './notifier.js';
import type { ResponseRulesService } from './response-rules.service.js';

/** What a reporter wrote, as it travels in a failed statement's values. */
const WORDS = 'the patient in bed 4 was given the wrong infusion';

/** A query the database gave up, as the driver and Drizzle hand it on. */
const refused = (code: string) =>
  new DrizzleQueryError(
    'insert into "notifications" values ($1, $2)',
    [WORDS, WORDS],
    Object.assign(new Error(`canceling statement: ${WORDS}`), { code }),
  );

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

/**
 * The check with no database behind it: the list of hospitals is what the
 * test says (or fails as it says), and each hospital's own check does what
 * the test says. What is under test is what a run counts and what it logs.
 */
function checkOver(
  hospitals: string[] | Error,
  each: Record<string, { notified: number; filled: number } | Error> = {},
) {
  const db = {
    transaction: () =>
      hospitals instanceof Error
        ? Promise.reject(hospitals)
        : Promise.resolve(hospitals.map((id) => ({ id, timeZone: 'UTC' }))),
  } as unknown as Database;
  const check = new DeadlineCheck(
    db,
    {} as TenantDb,
    {} as ResponseRulesService,
    {} as Notifier,
    {} as ProvisioningService,
  );
  const checked: string[] = [];
  vi.spyOn(
    check as unknown as {
      check: (hospital: { id: string }) => Promise<unknown>;
    },
    'check',
  ).mockImplementation((hospital) => {
    checked.push(hospital.id);
    const outcome = each[hospital.id] ?? { notified: 0, filled: 0 };
    return outcome instanceof Error
      ? Promise.reject(outcome)
      : Promise.resolve(outcome);
  });
  return { check, checked };
}

describe('what a run of the deadline check says', () => {
  let said: Record<'log' | 'warn' | 'error', string[]>;

  beforeEach(() => {
    said = { log: [], warn: [], error: [] };
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (message: unknown) => {
          said[level].push(String(message));
        },
      );
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('gives every statement a time limit', () => {
    const { check } = checkOver([]);
    expect(check.statementTimeoutMs).toBe(CHECK_STATEMENT_TIMEOUT_MS);
    expect(CHECK_STATEMENT_TIMEOUT_MS).toBeGreaterThan(0);
    // Well within the five minutes between two runs.
    expect(CHECK_STATEMENT_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  it('is nothing when there was nothing to do', async () => {
    const { check, checked } = checkOver([A, B]);
    expect(await check.run()).toEqual({
      listed: true,
      hospitals: 2,
      failed: 0,
      notified: 0,
      filled: 0,
    });
    expect(checked).toEqual([A, B]);
    expect(said).toEqual({ log: [], warn: [], error: [] });
  });

  it('is one line when it did something', async () => {
    const { check } = checkOver([A, B, C], {
      [A]: { notified: 4, filled: 0 },
      [C]: { notified: 3, filled: 2 },
    });
    expect(await check.run()).toEqual({
      listed: true,
      hospitals: 3,
      failed: 0,
      notified: 7,
      filled: 2,
    });
    expect(said).toEqual({
      log: [
        'Deadline check: 7 notifications written, 2 incidents given their deadlines, 0 of 3 hospitals failed',
      ],
      warn: [],
      error: [],
    });
  });

  it('names a hospital whose check failed and the kind of failure, goes on to the others, and says how it ended', async () => {
    const { check, checked } = checkOver([A, B, C], {
      // Ran out of time: one stalled statement, given up by the database.
      [A]: refused('57014'),
      [B]: { notified: 2, filled: 0 },
      [C]: new TypeError(WORDS),
    });
    expect(await check.run()).toEqual({
      listed: true,
      hospitals: 3,
      failed: 2,
      notified: 2,
      filled: 0,
    });
    // The hospital after the one that failed was checked all the same.
    expect(checked).toEqual([A, B, C]);
    expect(said.error).toEqual([
      `Deadline check failed for hospital ${A}: DrizzleQueryError (57014)`,
      `Deadline check failed for hospital ${C}: TypeError`,
    ]);
    expect(said.warn).toEqual([
      'Deadline check: 2 notifications written, 0 incidents given their deadlines, 2 of 3 hospitals failed',
    ]);
    expect(said.log).toEqual([]);
    // The class of the error and the hospital, never a word of a record.
    expect(JSON.stringify(said)).not.toContain('patient');
    expect(JSON.stringify(said)).not.toContain('notifications" values');
  });

  it('says so when it could not even read the list of hospitals', async () => {
    const { check, checked } = checkOver(refused('57014'));
    expect(await check.run()).toEqual({
      listed: false,
      hospitals: 0,
      failed: 0,
      notified: 0,
      filled: 0,
    });
    expect(checked).toEqual([]);
    expect(said.error).toEqual([
      'Deadline check failed before any hospital was checked: DrizzleQueryError (57014)',
    ]);
    expect(JSON.stringify(said)).not.toContain('patient');
    // A connection that could not be had is said the same way.
    const offline = checkOver(
      Object.assign(new Error(`connect failed: ${WORDS}`), {
        code: 'ECONNREFUSED',
      }),
    );
    await offline.check.run();
    expect(said.error.at(-1)).toBe(
      'Deadline check failed before any hospital was checked: Error (ECONNREFUSED)',
    );
    // And a code that is not one is not repeated.
    const odd = checkOver(Object.assign(new Error('x'), { code: WORDS }));
    await odd.check.run();
    expect(said.error.at(-1)).toBe(
      'Deadline check failed before any hospital was checked: Error',
    );
    expect(JSON.stringify(said)).not.toContain('patient');
  });

  it('says so when a run started by the timer fails in a way nobody foresaw, and runs again', async () => {
    const { check } = checkOver([]);
    const run = vi.spyOn(check, 'run').mockRejectedValue(new RangeError(WORDS));
    check.start(5);
    await vi.waitFor(() => expect(run.mock.calls.length).toBeGreaterThan(1), {
      timeout: 10_000,
      interval: 10,
    });
    await check.stop();
    expect(said.error.length).toBeGreaterThan(1);
    expect(new Set(said.error)).toEqual(
      new Set(['Deadline check failed: RangeError']),
    );
    expect(JSON.stringify(said)).not.toContain('patient');
  });
});
