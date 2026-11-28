import { DrizzleQueryError } from 'drizzle-orm/errors';
import pg from 'pg';
import { kindOf } from './email-worker.service.js';

describe('how the email worker names a failure', () => {
  it('gives the code, never the message', () => {
    const lost = Object.assign(new Error('to person@hospital.example'), { code: 'ECONNRESET' });
    expect(kindOf(lost)).toBe('Error (ECONNRESET)');
    expect(kindOf(new Error('to person@hospital.example'))).toBe('Error (no code)');
    expect(kindOf('a string')).toBe('unknown error (no code)');
    // A code found on what caused it.
    expect(kindOf(new Error('wrapped', { cause: lost }))).toBe('Error (ECONNRESET)');
  });

  it('gives a database error its SQLSTATE, table and constraint', () => {
    const db = Object.assign(new pg.DatabaseError('insert or update on table violates key', 0, 'error'), {
      code: '23503',
      table: 'email_queue',
      constraint: 'email_queue_user_fk',
    });
    const query = new DrizzleQueryError('insert into "email_queue" values ($1)', ['person@hospital.example'], db);
    const said = kindOf(query);
    expect(said).toBe('DrizzleQueryError (23503; email_queue, email_queue_user_fk)');
    expect(said).not.toContain('person@');
  });
});
