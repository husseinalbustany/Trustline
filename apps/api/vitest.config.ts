import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

// A key for the audit chain's checkpoints, made afresh for each run: no
// key is kept anywhere (docs/specs/audit-trail.md, "Signed checkpoints").
const auditKey = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64');
// Likewise for full data exports: the manifest's key, and the key that
// wraps each archive's own (docs/specs/data-export.md).
const exportKey = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'der' })
  .toString('base64');
const storageKey = randomBytes(32).toString('base64');
// Where the run's archives are kept: a directory of its own, named, as a
// deployment names its storage (security review 20, L3).
const storageDir = mkdtempSync(join(tmpdir(), 'trustline-exports-test-'));

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`. Requires Vite 8, which ships this option.
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts', 'test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // No test ever sends mail, whatever a developer's .env configures:
    // email goes to the outbox table (docs/specs/email.md). A test of the
    // SMTP sender talks to a server of its own on this machine.
    env: {
      MAIL_TRANSPORT: 'outbox',
      // A pepper for the tests' signing PINs only: no real PIN is ever made
      // with it (docs/specs/identity-signing-pin.md).
      SIGNING_PIN_PEPPER: 'test-only-pepper-for-signing-pins-0000000000',
      AUDIT_SIGNING_KEY: auditKey,
      AUDIT_PREVIOUS_PUBLIC_KEYS: '',
      EXPORT_SIGNING_KEY: exportKey,
      EXPORT_PREVIOUS_PUBLIC_KEYS: '',
      EXPORT_STORAGE_KEY: storageKey,
      EXPORT_STORAGE_DIR: storageDir,
      // No test ever calls a real AI provider: every request is answered by
      // the fake one (ai/providers.ts), which is also what a test run gets
      // whatever is set, and a real adapter built under test throws.
      AI_PROVIDERS: 'fake',
    },
  },
});
