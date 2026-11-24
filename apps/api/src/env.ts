import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Loads the repo-root .env when it exists. Variables already set in the
// environment win, so CI and production configure the process directly.
const envFile = resolve(import.meta.dirname, '../../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}
