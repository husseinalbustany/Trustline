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

## Web app structure

Every signed-in screen sits inside one shell: a sidebar, a top bar with the
"Report an incident" button, and the page.

| Path under `apps/web/src` | What it holds |
| --- | --- |
| `config/navigation.ts` | The sidebar: groups, order, routes, icons, delivery phase. |
| `app/[lang]/(app)/` | One folder per area: `dashboard`, `incidents`, `investigations`, `actions`, `policies`, `risks`, `training`, `reports`, `admin/*`. |
| `components/shell/` | Sidebar, top bar, language switcher. |
| `components/ui/` | Shared building blocks: page header, panel, badge, button. |
| `i18n/dictionaries/` | All text, in `en.json` and `ar.json`. No text is written in components. |

Areas that are not built yet render `components/module-page.tsx`, which lists
what the area will cover. To build an area, replace its `page.tsx`. To add
one, add a folder, a `navigation.ts` entry, and its text in both dictionaries.

Layout uses logical properties (`start`/`end`, not left/right), so Arabic
mirrors without separate styles.

## Admin portal

Trustline's own staff manage every client at `/en/platform` (or `/ar/platform`):
add a hospital, edit its settings, suspend or reactivate it. It has its own
sign-in, separate from the hospitals' users.

- **Accounts** are created from the command line, never from the portal or
  the API:

  ```bash
  PLATFORM_ADMIN_EMAIL=you@example.com PLATFORM_ADMIN_NAME="Your Name" \
    PLATFORM_ADMIN_PASSWORD='at least 12 characters' pnpm platform:create-admin
  ```

  Running it again for the same email resets the password and clears a lock.
- **Sign-in** uses a session cookie that scripts cannot read. Five wrong
  passwords lock the account for 15 minutes. Sessions last 8 hours.
- **Database access** goes through a third role, `trustline_platform`
  (`PLATFORM_DATABASE_URL`). It can manage client records but has no access to
  hospital data, and it can add to the audit log but not change it.
- **Every change** is recorded in `platform_audit_log` and shown on the
  client's page.

Not built yet: a second sign-in factor for admins, and enforcing a suspended
client at hospital sign-in (hospital sign-in itself is not built).

## API

The API is served under `/api/v1`. The web app forwards `/api/*` to it, so the
browser only ever talks to one origin. The version in the path is there so
that a future mobile app on an older release keeps working.

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
http://localhost:3001/api/v1/health. To use the admin portal, create an
admin as described above.

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

- For hospital data, the API connects as `trustline_app` (`APP_DATABASE_URL`), a role that owns
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
