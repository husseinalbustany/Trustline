# Trustline

Quality, risk and incident management for hospitals. One codebase, deployable
as shared SaaS, with a dedicated database, or single-tenant.

This repository is at the start of the Foundation phase: the project skeleton,
tenant isolation, and the bilingual web shell.

## Layout

| Path | What it is |
| --- | --- |
| `apps/api` | NestJS API. Postgres through Drizzle, migrations in `apps/api/drizzle`. |
| `apps/web` | Next.js web app, English and Arabic (right-to-left). |
| `docker-compose.yml` | Postgres for local development. |

## Run it locally

Needs Node 22, pnpm and Docker.

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:migrate
pnpm db:seed
pnpm dev
```

The web app is at http://localhost:3000 and the API at
http://localhost:3001/api/health.

`pnpm db:seed` creates two fictional hospitals: `demo-jci` (JCI, English by
default) and `demo-cbahi` (CBAHI, Arabic by default), each with a facility,
departments and units.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` needs the database running. It migrates and seeds it first.

## Tenant isolation

Every tenant's data lives in the same tables, separated by Postgres row-level
security:

- The API connects as `trustline_app` (`APP_DATABASE_URL`), a role that owns
  nothing and cannot bypass row-level security. Migrations and the seed run as
  the owner role (`DATABASE_URL`).
- Every table that holds tenant data has a `tenant_id` column and a
  `tenant_isolation` policy that matches it against the transaction's tenant.
- Application code reaches tenant data only through `TenantDb.withTenant()`,
  which sets that tenant for one transaction. With no tenant set, queries
  return no rows.

`apps/api/src/database/tenant-isolation.spec.ts` checks all of this, and fails
if a new table with `tenant_id` is added without a policy.

To add a table: define it in `apps/api/src/database/schema.ts` with the
`tenantIsolation()` policy, run `pnpm --filter api db:generate`, and add its
grants for `trustline_app` in a migration.

## Settings that vary by tenant

- `accreditation_standard`: `JCI` or `CBAHI`.
- `default_locale`: `en` or `ar`.
- `data_region`: where the tenant's data must be hosted. Empty until launch
  regions are decided.
