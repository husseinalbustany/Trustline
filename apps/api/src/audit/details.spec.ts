import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import ts from 'typescript';
import { createDatabase } from '../database/client.js';
import { requireEnv } from '../env.js';
import { AUDIT_ACTIONS, isAuditAction, storedKeysOf, type AuditAction } from './actions.js';

const API = resolve(import.meta.dirname, '../..');

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(resolve(dir, entry.name)) : [resolve(dir, entry.name)],
  );
}

const registered = (action: string) =>
  new Set<string>(isAuditAction(action) ? AUDIT_ACTIONS[action].details : []);

/**
 * The keys an object literal holds, those of the objects spread into it
 * when they are literals too (`...(moved && { orgUnitId })`). A spread of a
 * variable cannot be read here: `null`, and the database check below sees
 * what it wrote.
 */
function keysOf(node: ts.Expression): string[] | null {
  if (ts.isParenthesizedExpression(node)) return keysOf(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return keysOf(node.right);
  }
  if (ts.isConditionalExpression(node)) {
    const a = keysOf(node.whenTrue);
    const b = keysOf(node.whenFalse);
    return a && b ? [...a, ...b] : null;
  }
  if (!ts.isObjectLiteralExpression(node)) return null;
  const keys: string[] = [];
  for (const p of node.properties) {
    if (ts.isSpreadAssignment(p)) {
      const inner = keysOf(p.expression);
      if (inner) keys.push(...inner);
    } else if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
      keys.push(p.name.text);
    }
  }
  return keys;
}

/** The keys of a `jsonb_build_object(…)` at the top of a SQL expression. */
function jsonbKeys(expression: string): string[] {
  const at = expression.indexOf('jsonb_build_object(');
  if (at < 0) return [];
  let depth = 0;
  let quote = false;
  let part = '';
  const parts: string[] = [];
  for (const c of expression.slice(at + 'jsonb_build_object('.length)) {
    if (quote) {
      part += c;
      if (c === "'") quote = false;
      continue;
    }
    if (c === "'") quote = true;
    if (c === '(') depth++;
    if (c === ')') {
      if (depth === 0) break;
      depth--;
    }
    if (c === ',' && depth === 0) {
      parts.push(part.trim());
      part = '';
      continue;
    }
    part += c;
  }
  parts.push(part.trim());
  return parts.filter((_, i) => i % 2 === 0).flatMap((p) => /^'([A-Za-z]+)'$/.exec(p)?.[1] ?? []);
}

describe('the details of audit entries', () => {
  it('written by the code are registered for their action', () => {
    const unregistered: string[] = [];
    let read = 0;
    for (const file of filesIn(resolve(API, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'audit' &&
          node.arguments.length >= 4 &&
          ts.isStringLiteral(node.arguments[3]) &&
          isAuditAction(node.arguments[3].text)
        ) {
          const action = node.arguments[3].text;
          const changes = node.arguments[6];
          const keys = changes ? keysOf(changes) : [];
          if (keys) {
            read++;
            for (const key of keys) {
              if (!registered(action).has(key)) unregistered.push(`${action}.${key} (${file.split('/src/')[1]})`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(read).toBeGreaterThan(40);
    expect(unregistered).toEqual([]);
  });

  it('written by a migration are registered for their action', () => {
    const unregistered: string[] = [];
    const folder = resolve(API, 'drizzle');
    for (const name of readdirSync(folder).filter((f) => f.endsWith('.sql')).sort()) {
      for (const statement of readFileSync(resolve(folder, name), 'utf8').split('--> statement-breakpoint')) {
        const code = statement.replace(/--.*$/gm, '');
        const insert = code.search(/insert\s+into\s+"?audit_log"?\s*\(/i);
        if (insert < 0) continue;
        const after = code.slice(insert);
        const action = /'([a-z]+(?:_[a-z]+)+)'/.exec(after.slice(after.search(/select|values/i)))?.[1];
        if (!action || !isAuditAction(action)) continue;
        for (const key of jsonbKeys(after)) {
          if (!registered(action).has(key)) unregistered.push(`${action}.${key} (${name})`);
        }
      }
    }
    expect(unregistered).toEqual([]);
  });

  it('stored in the database are registered for their action', async () => {
    const { db, pool } = createDatabase(requireEnv('DATABASE_URL'));
    try {
      const { rows } = await db.execute<{ action: string; key: string }>(sql`
        select distinct a.action, k as key from audit_log a,
          jsonb_object_keys(case when jsonb_typeof(a.changes) = 'object' then a.changes else '{}'::jsonb end) k`);
      expect(
        rows
          .filter((r) => !isAuditAction(r.action) || !storedKeysOf(r.action as AuditAction).includes(r.key))
          .map((r) => `${r.action}.${r.key}`),
      ).toEqual([]);
    } finally {
      await pool.end();
    }
  });
});
