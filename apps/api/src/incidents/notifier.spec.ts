import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Transaction } from '../database/client.js';
import type { AccessService, Holders } from '../identity/access.service.js';
import {
  inChunks,
  Notifier,
  ROWS_PER_STATEMENT,
  type Announcement,
} from './notifier.js';

/** What the driver can number in one statement: 16 bits' worth. */
const MOST_PARAMETERS = 65_535;
/** What one notification is written with: tenant, user, kind, incident, data. */
const VALUES_PER_NOTIFICATION = 5;

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

/**
 * A notifier over a database that is not there: every user asked about is
 * active, and every statement is noted with the number of rows or ids it
 * carried instead of being sent.
 */
function notifierWith(triagers: string[]) {
  const inserts: { userId: string; incidentId: string }[][] = [];
  const lookups: number[] = [];
  const holders: Holders = {
    of: () => new Set(triagers),
    everywhere: () => new Set(triagers),
  };
  const access = {
    holders: () => Promise.resolve(holders),
  } as unknown as AccessService;
  // Stands in for the transaction: one statement that reads the users named
  // (answering that all of them are active), and one kind that writes.
  const tx = {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => {
          // The ids asked about are among the values the statement would
          // be sent with.
          const { params } = new PgDialect().sqlToQuery(condition);
          const asked = params.filter(
            (value): value is string =>
              typeof value === 'string' && value.startsWith('00000000-'),
          );
          lookups.push(asked.length);
          return Promise.resolve(asked.map((userId) => ({ id: userId })));
        },
      }),
    }),
    insert: () => ({
      values: (rows: { userId: string; incidentId: string }[]) => {
        inserts.push(rows);
        return Promise.resolve();
      },
    }),
  } as unknown as Transaction;
  return { notifier: new Notifier(access), tx, inserts, lookups };
}

const overdue = (incidentId: string): Announcement => ({
  incident: {
    id: incidentId,
    reference: 'INC-2026-00001',
    orgUnitId: id(1),
    ownerUnitId: null,
    assignedTo: null,
    reportedBy: null,
    harmLevel: 'none',
    isSentinel: false,
  },
  actorId: null,
  drafts: (who) => [
    { kind: 'overdue', internal: true, to: who.mayTriage([id(1)]) },
  ],
});

describe('writing notifications', () => {
  it('cuts a list into pieces of a size, in order, with nothing lost', () => {
    expect(inChunks([], 3)).toEqual([]);
    expect(inChunks([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
    expect(inChunks([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
    const many = Array.from(
      { length: 2 * ROWS_PER_STATEMENT + 1 },
      (_, i) => i,
    );
    const pieces = inChunks(many);
    expect(pieces.map((p) => p.length)).toEqual([
      ROWS_PER_STATEMENT,
      ROWS_PER_STATEMENT,
      1,
    ]);
    expect(pieces.flat()).toEqual(many);
    // A piece is small enough to be sent whatever it holds.
    expect(ROWS_PER_STATEMENT * VALUES_PER_NOTIFICATION).toBeLessThan(
      MOST_PARAMETERS,
    );
  });

  it('writes a batch too large for one statement in several, every row once', async () => {
    // What the deadline check can meet: a hundred overdue incidents in a
    // hospital where 140 people may triage. Fourteen thousand notifications,
    // seventy thousand values: more than one statement can carry.
    const triagers = Array.from({ length: 140 }, (_, n) => id(1000 + n));
    const incidents = Array.from({ length: 100 }, (_, n) => id(50_000 + n));
    const { notifier, tx, inserts } = notifierWith(triagers);

    const told = await notifier.sendAll(tx, id(9), incidents.map(overdue));

    expect(told).toBe(14_000);
    expect(told * VALUES_PER_NOTIFICATION).toBeGreaterThan(MOST_PARAMETERS);
    expect(inserts.length).toBeGreaterThan(1);
    for (const rows of inserts) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length * VALUES_PER_NOTIFICATION).toBeLessThan(
        MOST_PARAMETERS,
      );
    }
    // Everybody told about every incident, once, in the order worked out.
    const written = inserts.flat();
    expect(written).toHaveLength(14_000);
    expect(
      new Set(written.map((r) => `${r.incidentId} ${r.userId}`)).size,
    ).toBe(14_000);
    expect(written.slice(0, 140).map((r) => r.userId)).toEqual(triagers);
    expect(new Set(written.map((r) => r.incidentId)).size).toBe(100);
  });

  it('asks which of very many people are active in several statements too', async () => {
    const triagers = Array.from({ length: 2500 }, (_, n) => id(1000 + n));
    const { notifier, tx, inserts, lookups } = notifierWith(triagers);

    const told = await notifier.sendAll(tx, id(9), [overdue(id(50_000))]);

    expect(told).toBe(2500);
    expect(lookups).toEqual([ROWS_PER_STATEMENT, ROWS_PER_STATEMENT, 500]);
    expect(inserts.map((rows) => rows.length)).toEqual([
      ROWS_PER_STATEMENT,
      ROWS_PER_STATEMENT,
      500,
    ]);
  });

  it('writes nothing, and asks nothing more, when there is nobody to tell', async () => {
    const { notifier, tx, inserts, lookups } = notifierWith([]);
    expect(await notifier.sendAll(tx, id(9), [overdue(id(50_000))])).toBe(0);
    expect(await notifier.sendAll(tx, id(9), [])).toBe(0);
    expect(inserts).toEqual([]);
    expect(lookups).toEqual([]);
  });
});
