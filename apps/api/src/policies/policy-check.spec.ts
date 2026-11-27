import { Logger } from '@nestjs/common';
import { DrizzleQueryError } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import type { TenantDb } from '../database/tenant-db.service.js';
import type { EntitlementsService } from '../subscriptions/entitlements.service.js';
import type { DocumentNotifier } from './document-notifier.js';
import { PolicyCheck } from './policy-check.service.js';
import type { Publisher } from './publisher.js';

/** What a document said, as it travels in a failed statement's values. */
const WORDS = 'the confidential wording of a draft procedure';

const refused = (code: string) =>
  new DrizzleQueryError(
    'update "documents" set x = $1',
    [WORDS],
    Object.assign(new Error(`canceling statement: ${WORDS}`), { code }),
  );

function checkOver(
  clients: string[] | Error,
  each: Record<string, { published: number; assigned: number; notified: number } | Error> = {},
) {
  const db = {
    transaction: () =>
      clients instanceof Error
        ? Promise.reject(clients)
        : Promise.resolve(clients.map((id) => ({ id, timeZone: 'UTC' }))),
  } as unknown as Database;
  const check = new PolicyCheck(
    db,
    {} as TenantDb,
    {} as EntitlementsService,
    {} as Publisher,
    {} as DocumentNotifier,
  );
  const checked: string[] = [];
  vi.spyOn(check, 'checkClient').mockImplementation((client) => {
    checked.push(client.id);
    const outcome = each[client.id] ?? { published: 0, assigned: 0, notified: 0 };
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  });
  return { check, checked };
}

describe('what a run of the policy check says', () => {
  let said: Record<'log' | 'warn' | 'error', string[]>;
  beforeEach(() => {
    said = { log: [], warn: [], error: [] };
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
        said[level].push(String(message));
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('says nothing when there was nothing to do', async () => {
    const { check } = checkOver(['a', 'b']);
    expect(await check.run()).toEqual({ listed: true, clients: 2, failed: 0, published: 0, assigned: 0, notified: 0 });
    expect(said).toEqual({ log: [], warn: [], error: [] });
  });

  it('goes on past a client that fails, names it with the kind of failure, and never with what a record said', async () => {
    const { check, checked } = checkOver(['a', 'b', 'c'], {
      a: { published: 1, assigned: 2, notified: 3 },
      b: refused('57014'),
    });
    expect(await check.run()).toMatchObject({ failed: 1, published: 1, assigned: 2, notified: 3 });
    expect(checked).toEqual(['a', 'b', 'c']);
    expect(said.error).toEqual(['Policy check failed for client b: DrizzleQueryError (57014)']);
    expect(said.warn).toEqual([
      'Policy check: 1 versions published, 2 acknowledgements asked, 3 notifications written, 1 of 3 clients failed',
    ]);
    expect(JSON.stringify(said)).not.toContain(WORDS);
  });

  it('says so when it cannot list the clients at all', async () => {
    const { check, checked } = checkOver(refused('ECONNREFUSED'));
    expect(await check.run()).toMatchObject({ listed: false, clients: 0 });
    expect(checked).toEqual([]);
    expect(said.error).toEqual(['Policy check failed before any client was checked: DrizzleQueryError (ECONNREFUSED)']);
  });

  it('runs on a timer that stops with the application', async () => {
    const { check } = checkOver(['a']);
    check.start(60_000);
    expect(check.active).toBe(true);
    await check.stop();
    expect(check.active).toBe(false);
  });
});
