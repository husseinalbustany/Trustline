# Incident reporting API, as built

All routes are under `/api/v1` and need a signed-in session (401 without).
Call them with `api()` from `apps/web/src/lib/api.ts`. Bodies are strict: an
unknown field is 400. `Localized` is `{ en?, ar?, fr? }`; show it with
`pick()`. Times are ISO strings. Errors carry `code` where listed.

## GET /auth/me (changed)

`{ tenant, user, permissions, scope }`. `scope` is new:

```
scope: { [permission: string]: "all" | string[] }
```

One key per permission the user holds. `"all"` = the whole organization;
otherwise a list of org unit ids (the granted units and everything beneath
them). `permissions` is unchanged.

## GET /incident-categories

200: `[{ id, code, name: Localized }]`, active only, in display order.

## POST /incidents  (needs `incidents.report`)

Body: `{ type: "incident"|"near_miss"|"hazard", categoryId, orgUnitId,
occurredAt: ISO datetime with "Z" or offset, description: 1..5000 chars,
immediateAction?: ≤2000 chars | null, harmLevel: "none"|"mild"|"moderate"|"severe"|"death",
anonymous: boolean }`

201: `{ id, reference }` (also for anonymous reports).
400 (no code): validation. 400 `occurred_in_future`. 400 `unknown_category`.
400 `unknown_org_unit`. 403 `missing_permission`.

## GET /incidents?status=&mine=&page=&pageSize=

`status`: new | triaged | in_progress | closed | rejected (omit for all).
`mine`: "true" | "false". `page` ≥ 1 (default 1). `pageSize` 1..100 (default 20).
An unknown parameter or bad value is 400; an empty value is treated as absent.

200: `{ items, total }`, newest first. Item:
`{ id, reference, type, category: { id, name }, orgUnit: { id, name },
ownerUnit: { id, name } | null, occurredAt, reportedAt, harmLevel,
isSentinel, status, descriptionExcerpt }` (excerpt ≤ 140 chars).

## GET /incidents/summary

200: `{ open, awaitingTriage, closedLast30Days }` (numbers, over what the caller may see).

## GET /incidents/:id   (404 if the caller may not see it)

```
{ id, reference, type,
  category: { id, name }, orgUnit: { id, name }, ownerUnit: { id, name } | null,
  occurredAt, reportedAt, description, immediateAction: string | null,
  harmLevel, isSentinel, status,
  reporter: { id, name } | null,        // null = anonymous
  assignedTo: { id, name } | null,      // always null when access is "reporter"
  triagedAt, closedAt, closureSummary, rejectionReason,   // each null until set
  access: "full" | "reporter", canTriage: boolean,
  events: [{ id, kind, occurredAt, actor: { id, name } | null, fromStatus, toStatus, details }],
  comments: [{ id, author: { id, name }, body, visibility: "everyone"|"internal", createdAt }] }
```

Events and comments are oldest first. Event `kind`: reported | triaged |
assigned | status_changed | commented | reopened | closed | rejected.
Event `details`: reported → null; triaged → `{ harmLevel, isSentinel, ownerUnitId, categoryId? }`;
assigned → `{ ownerUnitId, assignedTo: uuid | null }`; status_changed / closed /
rejected / reopened → `{ note }` or null; commented → `{ commentId, visibility }`.
`name` fields inside `reporter`, `assignedTo`, `actor`, `author` are `Localized`.

## POST /incidents/:id/triage   (needs triage rights over the incident)

Body: `{ harmLevel, isSentinel: boolean, categoryId?: uuid, ownerUnitId: uuid, assignedTo?: uuid | null }`.
Leaving out `assignedTo` clears the assignee; leaving out `categoryId` keeps it.
200: the full incident (same shape as GET /incidents/:id).
403 `missing_permission` (holds triage nowhere). 404 (cannot see it).
403 `outside_scope` (sees it, but triage right does not cover it).
409 `invalid_transition` (status is not new or triaged).
400 `unknown_category` | `unknown_org_unit` | `unknown_assignee` (must be an active user).

To offer assignees, call `GET /incidents/assignable-users` (needs
`incidents.triage` held anywhere; 403 `missing_permission` otherwise) →
`[{ id, name: Localized, orgUnitId: string | null }]`, active users only,
ordered by email. This route is being added by the API engineer while you
work; code against this shape. Do not call `GET /users` for this.

Also being added in parallel: a user who is the incident's `assignedTo` can
see that incident with `access: "full"` (and `canTriage` only if their triage
right covers it). Nothing changes in the response shapes.

## POST /incidents/:id/status   (same rights and errors as triage)

Body: `{ to, note?: ≤2000 chars | null }`. Allowed: triaged → in_progress (note optional);
triaged | in_progress → closed (note required); new → rejected (note required);
closed | rejected → in_progress (reopen, note required).
200: the full incident. 409 `invalid_transition`. 400 `note_required`.

## POST /incidents/:id/comments

Body: `{ body: 1..2000 chars, visibility: "everyone"|"internal" }`.
201: `{ id, visibility, createdAt }`. 404 if not visible to the caller.
403 `internal_not_allowed` (a reporter-only viewer posting internal).

## Existing routes you will use

- `GET /org-units` → `[{ id, parentId, type: "facility"|"department"|"unit", code, name: Localized }]`
- `GET /users` (needs `users.manage`) → users with `status` and `name: Localized`.
