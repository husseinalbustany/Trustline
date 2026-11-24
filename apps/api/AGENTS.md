# AGENTS.md

This app's version of NestJS is likely newer than what you know. https://docs.nestjs.com/llms.txt indexes its documentation, with a markdown page per chapter.

Nest's packages are ESM only, and this project is ESM too: relative imports end in `.js`, `__dirname` doesn't exist (use `import.meta.dirname`), and tests run on Vitest, so mocks are `vi.fn()`, not `jest.fn()`.

Tenant data is isolated by Postgres row-level security. Every table that holds tenant data has a `tenant_id` column and a `tenant_isolation` policy, and is only read or written through `TenantDb.withTenant()`. `src/database/tenant-isolation.spec.ts` fails if a table with `tenant_id` has no policy.
