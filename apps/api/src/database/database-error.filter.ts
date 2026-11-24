import {
  Catch,
  HttpException,
  Logger,
  type ArgumentsHost,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { DrizzleQueryError } from 'drizzle-orm';
import type { Response } from 'express';
import pg from 'pg';

/** What may be written to the server log about a failed query. */
export type DatabaseFailure = {
  code: string | null;
  constraint: string | null;
  table: string | null;
};

const SQLSTATE = /^[0-9A-Z]{5}$/;
// A connection failure has a code of this kind instead: ECONNREFUSED.
const SYSTEM_CODE = /^E[A-Z_]{2,30}$/;
const IDENTIFIER = /^[A-Za-z0-9_]{1,63}$/;

const safe = (value: unknown, ...allowed: RegExp[]) =>
  typeof value === 'string' && allowed.some((r) => r.test(value))
    ? value
    : null;

/**
 * If the error is a failed query, the little of it that is safe to log: the
 * error class and the names of the constraint and table. Null for any other
 * error. A failed query's own message holds the statement and its
 * parameters, which for an incident are the reporter's words.
 */
export function databaseFailure(error: unknown): DatabaseFailure | null {
  let found = false;
  let details: Record<string, unknown> | null = null;
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof DrizzleQueryError) found = true;
    if (current instanceof pg.DatabaseError) {
      found = true;
      details = current as unknown as Record<string, unknown>;
    }
    if (typeof current !== 'object') break;
    if (found && !details && 'code' in current) {
      details = current as Record<string, unknown>;
    }
    current = (current as { cause?: unknown }).cause;
  }
  if (!found) return null;
  return {
    code: safe(details?.code, SQLSTATE, SYSTEM_CODE),
    constraint: safe(details?.constraint, IDENTIFIER),
    table: safe(details?.table, IDENTIFIER),
  };
}

/**
 * Answers a query the database refused with a plain 500, and logs only its
 * error class, constraint and table. Without this, the default handler
 * writes the error's message to the server log, statement parameters
 * included. Everything else is handled as before.
 */
@Catch()
export class DatabaseErrorFilter extends BaseExceptionFilter {
  private readonly log = new Logger('Database');

  catch(exception: unknown, host: ArgumentsHost) {
    const failure =
      exception instanceof HttpException ? null : databaseFailure(exception);
    if (!failure) {
      super.catch(exception, host);
      return;
    }
    this.log.error(
      `Query failed: code=${failure.code ?? 'unknown'} constraint=${failure.constraint ?? '-'} table=${failure.table ?? '-'}`,
    );
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(500)
      .json({ statusCode: 500, message: 'Internal server error' });
  }
}
