# Trustline

Quality, risk and incident management for hospitals. One codebase, many
client hospitals (tenants). Read `README.md` for how the pieces fit.

## Commands

Run from the repository root. The database must be running (`docker compose up -d`).

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`: all four must pass before a change is done.
- `pnpm db:migrate`, `pnpm db:seed`: apply migrations, load the two demo hospitals.
- `pnpm --filter api db:generate --name <name>`: generate a migration from `schema.ts`.
- `pnpm dev`: web on :3000, API on :3001.

## Rules that are easy to break

- **Tenant isolation.** Every table holding hospital data has `tenant_id` and
  the `tenantIsolation()` policy, and is read or written only inside
  `TenantDb.withTenant()`. A new table also needs its grants for
  `trustline_app` in a migration. `tenant-isolation.spec.ts` fails otherwise.
- **Permissions are checked in the API** with `requirePermission(req, ...)`.
  Hiding a menu item is not protection.
- **Every change to an account, role or record is audited** through
  `ProvisioningService.audit()` in the same transaction.
- **No text in components.** All wording lives in
  `apps/web/src/i18n/dictionaries/en.json` and `ar.json`, and both must have
  the same keys.
- **Layout uses logical properties** (`ms-`, `pe-`, `start-`, `text-start`),
  never left/right, so Arabic mirrors.
- **No secrets, real patient data or real hospital names** in code, tests or
  seed data.

## Framework versions

NestJS and Next.js here are newer than most training data. Before using an
API you are not sure of, read `apps/api/AGENTS.md` and `apps/web/AGENTS.md`,
and the Next.js docs in `apps/web/node_modules/next/dist/docs/`.

## Agents

`.claude/agents/` holds a roster of specialists. Use the engineer for the
layer being changed, then `security-reviewer` for anything touching sign-in,
permissions, tenant data or the database, and `bilingual-reviewer` for any
screen or wording change.
