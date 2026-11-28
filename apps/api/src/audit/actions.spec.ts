import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { createDatabase } from '../database/client.js';
import { requireEnv } from '../env.js';
import { AUDIT_ACTIONS, AUDIT_ACTORS, isAuditAction } from './actions.js';
import { AUDIT_WORDING } from './wording/index.js';

const API = resolve(import.meta.dirname, '../..');

/** Every file under a folder, recursively. */
function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesIn(resolve(dir, entry.name))
      : [resolve(dir, entry.name)],
  );
}

/** Splits on commas outside brackets and quotes. */
function topLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += c;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * The action an `insert into audit_log` statement writes: the value at the
 * `action` column's place, in `values (…)` or in `select …`. Throws for a
 * statement it cannot read, so that a new way of writing one is looked at.
 */
function actionOf(statement: string, where: string): string {
  const head = /insert\s+into\s+(?:"?audit_log"?|\$\{auditLog\})\s*\(([^)]*)\)\s*/i.exec(statement);
  if (!head) throw new Error(`${where}: an audit_log insert with no column list`);
  const columns = topLevel(head[1]).map((c) => c.replaceAll('"', '').trim());
  const at = columns.indexOf('action');
  if (at < 0) throw new Error(`${where}: an audit_log insert with no action column`);
  const rest = statement.slice(head.index + head[0].length);
  let list: string;
  const values = /^values\s*\(/i.exec(rest);
  if (values) {
    let depth = 1;
    let i = values[0].length;
    for (; i < rest.length && depth > 0; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')') depth--;
    }
    list = rest.slice(values[0].length, i - 1);
  } else {
    const select = /^select\s+/i.exec(rest);
    if (!select) throw new Error(`${where}: an audit_log insert neither VALUES nor SELECT`);
    // Up to the FROM at the top level.
    let depth = 0;
    let end = rest.length;
    for (let i = select[0].length; i < rest.length; i++) {
      if (rest[i] === '(') depth++;
      else if (rest[i] === ')') depth--;
      else if (depth === 0 && /^\sfrom\s/i.test(rest.slice(i, i + 6))) {
        end = i;
        break;
      }
    }
    list = rest.slice(select[0].length, end);
  }
  const value = topLevel(list)[at];
  const literal = /^'([a-z_]+)'$/.exec(value ?? '');
  if (!literal) throw new Error(`${where}: the action of an audit_log insert is not a literal (${value})`);
  return literal[1];
}

describe('the audit action registry', () => {
  it('is worded in every language, and nothing else is', () => {
    const actions = Object.keys(AUDIT_ACTIONS).sort();
    for (const [locale, wording] of Object.entries(AUDIT_WORDING)) {
      expect([locale, Object.keys(wording.actions).sort()]).toEqual([locale, actions]);
      expect([locale, Object.keys(wording.actors).sort()]).toEqual([locale, [...AUDIT_ACTORS].sort()]);
      for (const [key, text] of Object.entries({ ...wording.actions, ...wording.actors })) {
        expect([locale, key, text.trim().length > 0]).toEqual([locale, key, true]);
      }
    }
  });

  it('holds every action the code writes in raw SQL', () => {
    const found: string[] = [];
    for (const file of filesIn(resolve(API, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/insert\s+into\s+(?:"?audit_log"?|\$\{auditLog\})/gi)) {
        const statement = text.slice(m.index, text.indexOf('`', m.index));
        found.push(actionOf(statement, file));
      }
    }
    // The admin portal's two, at least: the reading above works.
    expect(found).toEqual(expect.arrayContaining(['subscription_changed', 'import_window_changed']));
    expect(found.filter((a) => !isAuditAction(a))).toEqual([]);
  });

  it('holds every action a migration writes', () => {
    const found: string[] = [];
    const folder = resolve(API, 'drizzle');
    for (const name of readdirSync(folder).filter((f) => f.endsWith('.sql')).sort()) {
      const text = readFileSync(resolve(folder, name), 'utf8');
      for (const statement of text.split('--> statement-breakpoint')) {
        // Without comments, which may name the table in passing.
        const code = statement.replace(/--.*$/gm, '');
        for (const m of code.matchAll(/insert\s+into\s+"?audit_log"?\s*\(/gi)) {
          found.push(actionOf(code.slice(m.index), name));
        }
      }
    }
    expect(found).toEqual(expect.arrayContaining(['built_in_roles_changed_by_system', 'audit_chain_started']));
    expect(found.filter((a) => !isAuditAction(a))).toEqual([]);
  });

  it('holds every action stored in the database', async () => {
    const { db, pool } = createDatabase(requireEnv('DATABASE_URL'));
    try {
      const { rows } = await db.execute<{ action: string }>(sql`select distinct action from audit_log`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.map((r) => r.action).filter((a) => !isAuditAction(a))).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
