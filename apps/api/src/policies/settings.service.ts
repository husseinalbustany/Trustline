import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import { pgErrorCode } from '../database/errors.js';
import {
  approvalRoutes,
  approvalRouteSteps,
  documentCategories,
  documentSettings,
  documentTypes,
  documentVersions,
  roleAssignments,
  roles,
  users,
  type DocumentSection,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { fitsLanguages, type Localized } from '../i18n/locales.js';
import {
  assertReviewPeriod,
  documentSettingsOf,
} from './document-settings.js';
import type { StepInput } from './input.js';
import { importWindowOf, importWindowView } from './import-window.js';
import { authoritativeLocale } from './languages.js';
import { APPROVE_PERMISSION } from './visibility.js';

const typeFields = {
  id: documentTypes.id,
  code: documentTypes.code,
  name: documentTypes.name,
  numberPrefix: documentTypes.numberPrefix,
  sections: documentTypes.sections,
  defaultReviewMonths: documentTypes.defaultReviewMonths,
  active: documentTypes.active,
  position: documentTypes.position,
  revision: documentTypes.revision,
};

const categoryFields = {
  id: documentCategories.id,
  code: documentCategories.code,
  name: documentCategories.name,
  parentId: documentCategories.parentId,
  active: documentCategories.active,
  position: documentCategories.position,
  revision: documentCategories.revision,
};

/** What changed between two records, field by field, for the audit log. */
function changesOf(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, to] of Object.entries(after)) {
    if (to === undefined) continue;
    if (JSON.stringify(to) === JSON.stringify(before[field])) continue;
    changes[field] = { from: before[field], to };
  }
  return changes;
}

const isUnique = (e: unknown) => pgErrorCode(e) === '23505';

/**
 * The settings of the policies module, which belong to the whole
 * organization: document types (their sections, prefix and review period),
 * categories, and approval routes with their steps. Read by anyone who may
 * use the module, changed by those who manage documents for the whole
 * organization (the controller checks), each change audited. Nothing here
 * is deleted: a type, a category or a route is switched off.
 */
@Injectable()
export class PolicySettingsService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
  ) {}

  private assertLanguages(auth: AuthContext, ...texts: (Localized | undefined)[]) {
    for (const text of texts) {
      if (text && !fitsLanguages(text, auth.tenant)) {
        throw new BadRequestException({ code: 'language_mismatch' });
      }
    }
  }

  private assertSections(auth: AuthContext, sections?: DocumentSection[]) {
    for (const s of sections ?? []) this.assertLanguages(auth, s.name);
  }

  // Types.

  types(auth: AuthContext, includeInactive: boolean) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select(typeFields)
        .from(documentTypes)
        .where(includeInactive ? undefined : eq(documentTypes.active, true))
        .orderBy(asc(documentTypes.position), asc(documentTypes.code)),
    );
  }

  async createType(
    auth: AuthContext,
    input: {
      code: string;
      name: Localized;
      numberPrefix: string;
      sections: DocumentSection[];
      defaultReviewMonths: number;
      position: number;
    },
  ) {
    this.assertLanguages(auth, input.name);
    this.assertSections(auth, input.sections);
    try {
      return await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
        await assertReviewPeriod(tx, input.defaultReviewMonths, true);
        const [created] = await tx
          .insert(documentTypes)
          .values({ ...input, tenantId: auth.tenant.id })
          .returning(typeFields);
        await this.provisioning.audit(
          tx,
          auth.tenant.id,
          auth.user.id,
          'document_type_created',
          'document_type',
          created.id,
          input,
        );
        return created;
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'code_taken' });
      throw e;
    }
  }

  /**
   * Changes a type, given the revision the caller read (409 `stale_type`
   * otherwise). Its review period stays within the client's maximum, and a
   * type is not switched back on with a longer one (400
   * `review_period_too_long`, with the `max`).
   */
  updateType(
    auth: AuthContext,
    id: string,
    input: Partial<{
      name: Localized;
      numberPrefix: string;
      sections: DocumentSection[];
      defaultReviewMonths: number;
      active: boolean;
      position: number;
    }> & { revision: number },
  ) {
    this.assertLanguages(auth, input.name);
    this.assertSections(auth, input.sections);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [before] = await tx
        .select(typeFields)
        .from(documentTypes)
        .where(eq(documentTypes.id, id))
        .for('update');
      if (!before) throw new NotFoundException();
      if (before.revision !== input.revision) {
        throw new ConflictException({ code: 'stale_type' });
      }
      const { revision: _revision, ...fields } = input;
      const changes = changesOf(before, fields);
      if (Object.keys(changes).length === 0) return before;
      // A type switched back on must be within today's maximum as well,
      // which may have been lowered while it was off (security review).
      const reactivated = changes.active !== undefined && fields.active === true;
      if (changes.defaultReviewMonths || reactivated) {
        await assertReviewPeriod(
          tx,
          fields.defaultReviewMonths ?? before.defaultReviewMonths,
          true,
        );
      }
      const [after] = await tx
        .update(documentTypes)
        .set({
          ...fields,
          revision: sql`${documentTypes.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(documentTypes.id, id))
        .returning(typeFields);
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'document_type_updated',
        'document_type',
        id,
        changes,
      );
      return after;
    });
  }

  // Categories.

  categories(auth: AuthContext, includeInactive: boolean) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select(categoryFields)
        .from(documentCategories)
        .where(
          includeInactive ? undefined : eq(documentCategories.active, true),
        )
        .orderBy(asc(documentCategories.position), asc(documentCategories.code)),
    );
  }

  /**
   * A parent must exist, be switched on, and not be the category itself or
   * one beneath it: the tree has no loops.
   */
  private async assertParent(
    tx: Transaction,
    parentId: string | null,
    self: string | null,
  ) {
    if (!parentId) return;
    if (parentId === self) {
      throw new BadRequestException({ code: 'invalid_parent' });
    }
    const [parent] = await tx
      .select({ id: documentCategories.id })
      .from(documentCategories)
      .where(
        and(
          eq(documentCategories.id, parentId),
          eq(documentCategories.active, true),
        ),
      )
      .for('share');
    if (!parent) throw new BadRequestException({ code: 'invalid_parent' });
    if (!self) return;
    const { rows } = await tx.execute<{ loops: boolean }>(sql`
      with recursive up (id, parent_id) as (
        select c.id, c.parent_id from ${documentCategories} c where c.id = ${parentId}
        union
        select c.id, c.parent_id from ${documentCategories} c join up on c.id = up.parent_id
      ) select exists (select from up where id = ${self}) as loops`);
    if (rows[0]?.loops) throw new BadRequestException({ code: 'invalid_parent' });
  }

  async createCategory(
    auth: AuthContext,
    input: { code: string; name: Localized; parentId: string | null; position: number },
  ) {
    this.assertLanguages(auth, input.name);
    try {
      return await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
        await this.assertParent(tx, input.parentId, null);
        const [created] = await tx
          .insert(documentCategories)
          .values({ ...input, tenantId: auth.tenant.id })
          .returning(categoryFields);
        await this.provisioning.audit(
          tx,
          auth.tenant.id,
          auth.user.id,
          'document_category_created',
          'document_category',
          created.id,
          input,
        );
        return created;
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'code_taken' });
      throw e;
    }
  }

  /** Changes a category, given the revision the caller read (409 `stale_category`). */
  updateCategory(
    auth: AuthContext,
    id: string,
    input: Partial<{
      name: Localized;
      parentId: string | null;
      active: boolean;
      position: number;
    }> & { revision: number },
  ) {
    this.assertLanguages(auth, input.name);
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const [before] = await tx
        .select(categoryFields)
        .from(documentCategories)
        .where(eq(documentCategories.id, id))
        .for('update');
      if (!before) throw new NotFoundException();
      if (before.revision !== input.revision) {
        throw new ConflictException({ code: 'stale_category' });
      }
      const { revision: _revision, ...fields } = input;
      if (fields.parentId !== undefined) {
        await this.assertParent(tx, fields.parentId, id);
      }
      const changes = changesOf(before, fields);
      if (Object.keys(changes).length === 0) return before;
      const [after] = await tx
        .update(documentCategories)
        .set({
          ...fields,
          revision: sql`${documentCategories.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(documentCategories.id, id))
        .returning(categoryFields);
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'document_category_updated',
        'document_category',
        id,
        changes,
      );
      return after;
    });
  }

  // Approval routes.

  routes(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const list = await tx
        .select({
          id: approvalRoutes.id,
          name: approvalRoutes.name,
          subject: approvalRoutes.subject,
          documentTypeId: approvalRoutes.documentTypeId,
          active: approvalRoutes.active,
          revision: approvalRoutes.revision,
        })
        .from(approvalRoutes)
        .orderBy(asc(approvalRoutes.createdAt), asc(approvalRoutes.id));
      return this.withSteps(tx, list);
    });
  }

  private async withSteps<T extends { id: string }>(tx: Transaction, list: T[]) {
    if (list.length === 0) return [];
    const steps = await tx
      .select({
        routeId: approvalRouteSteps.routeId,
        position: approvalRouteSteps.position,
        kind: approvalRouteSteps.kind,
        userId: approvalRouteSteps.assigneeUserId,
        roleId: approvalRouteSteps.assigneeRoleId,
        dueInDays: approvalRouteSteps.dueInDays,
        userName: users.name,
        roleName: roles.name,
      })
      .from(approvalRouteSteps)
      .leftJoin(users, eq(users.id, approvalRouteSteps.assigneeUserId))
      .leftJoin(roles, eq(roles.id, approvalRouteSteps.assigneeRoleId))
      .where(
        inArray(
          approvalRouteSteps.routeId,
          list.map((r) => r.id),
        ),
      )
      .orderBy(asc(approvalRouteSteps.position));
    return list.map((route) => ({
      ...route,
      steps: steps
        .filter((s) => s.routeId === route.id)
        .map((s) => ({
          position: s.position,
          kind: s.kind,
          assignee: s.userId
            ? { type: 'user' as const, user: { id: s.userId, name: s.userName } }
            : { type: 'role' as const, role: { id: s.roleId!, name: s.roleName } },
          dueInDays: s.dueInDays,
        })),
    }));
  }

  /**
   * Steps a route may have: the last one an approval; no person named for
   * two steps (400 `same_person_in_two_steps`, with the `userId` and the
   * `positions`); a role named only if
   * it includes `policies.approve` (400 `role_cannot_approve`); a person
   * named only if they are active and hold it somewhere (400
   * `user_cannot_approve`).
   */
  private async assertSteps(tx: Transaction, steps: StepInput[]) {
    if (steps[steps.length - 1].kind !== 'approve') {
      throw new BadRequestException({ code: 'last_step_must_approve' });
    }
    // Each step of a run is decided by a different person, so a route that
    // names one person for two steps could never be completed.
    const named = new Map<string, number[]>();
    steps.forEach((s, i) => {
      if (s.userId) named.set(s.userId, [...(named.get(s.userId) ?? []), i + 1]);
    });
    for (const [userId, positions] of named) {
      if (positions.length > 1) {
        throw new BadRequestException({
          code: 'same_person_in_two_steps',
          userId,
          positions,
        });
      }
    }
    const roleIds = [...new Set(steps.map((s) => s.roleId).filter((x) => !!x))] as string[];
    if (roleIds.length > 0) {
      const found = await tx
        .select({ id: roles.id, permissions: roles.permissions })
        .from(roles)
        .where(inArray(roles.id, roleIds))
        .for('share');
      for (const id of roleIds) {
        const role = found.find((r) => r.id === id);
        if (!role) throw new BadRequestException({ code: 'unknown_role' });
        if (!role.permissions.includes(APPROVE_PERMISSION)) {
          throw new BadRequestException({ code: 'role_cannot_approve', roleId: id });
        }
      }
    }
    const userIds = [...new Set(steps.map((s) => s.userId).filter((x) => !!x))] as string[];
    for (const id of userIds) {
      const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.id, id),
            eq(users.status, 'active'),
            sql`exists (select from ${roleAssignments} ra join ${roles} r on r.id = ra.role_id where ra.user_id = ${users.id} and ${APPROVE_PERMISSION} = any(r.permissions))`,
          ),
        );
      if (!user) {
        throw new BadRequestException({ code: 'user_cannot_approve', userId: id });
      }
    }
  }

  private async assertType(tx: Transaction, typeId: string | null) {
    if (!typeId) return;
    const [type] = await tx
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(eq(documentTypes.id, typeId));
    if (!type) throw new BadRequestException({ code: 'unknown_type' });
  }

  private async writeSteps(
    tx: Transaction,
    tenantId: string,
    routeId: string,
    steps: StepInput[],
  ) {
    await tx
      .delete(approvalRouteSteps)
      .where(eq(approvalRouteSteps.routeId, routeId));
    await tx.insert(approvalRouteSteps).values(
      steps.map((s, i) => ({
        tenantId,
        routeId,
        position: i + 1,
        kind: s.kind,
        assigneeUserId: s.userId ?? null,
        assigneeRoleId: s.roleId ?? null,
        dueInDays: s.dueInDays,
      })),
    );
  }

  async createRoute(
    auth: AuthContext,
    input: {
      name: Localized;
      documentTypeId: string | null;
      active: boolean;
      steps: StepInput[];
    },
  ) {
    this.assertLanguages(auth, input.name);
    try {
      return await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
        await this.assertType(tx, input.documentTypeId);
        await this.assertSteps(tx, input.steps);
        const [route] = await tx
          .insert(approvalRoutes)
          .values({
            tenantId: auth.tenant.id,
            name: input.name,
            subject: 'document',
            documentTypeId: input.documentTypeId,
            active: input.active,
          })
          .returning({ id: approvalRoutes.id });
        await this.writeSteps(tx, auth.tenant.id, route.id, input.steps);
        await this.provisioning.audit(
          tx,
          auth.tenant.id,
          auth.user.id,
          'approval_route_created',
          'approval_route',
          route.id,
          input,
        );
        return this.route(tx, route.id);
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'route_exists' });
      throw e;
    }
  }

  private async route(tx: Transaction, id: string) {
    const list = await tx
      .select({
        id: approvalRoutes.id,
        name: approvalRoutes.name,
        subject: approvalRoutes.subject,
        documentTypeId: approvalRoutes.documentTypeId,
        active: approvalRoutes.active,
        revision: approvalRoutes.revision,
      })
      .from(approvalRoutes)
      .where(eq(approvalRoutes.id, id));
    return (await this.withSteps(tx, list))[0];
  }

  /**
   * Changes a route. Runs in progress keep the steps they copied when they
   * started; the change counts for versions sent for review from now on.
   */
  async updateRoute(
    auth: AuthContext,
    id: string,
    input: {
      name?: Localized;
      documentTypeId?: string | null;
      active?: boolean;
      steps?: StepInput[];
      revision: number;
    },
  ) {
    this.assertLanguages(auth, input.name);
    try {
      return await this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
        const [before] = await tx
          .select({
            name: approvalRoutes.name,
            documentTypeId: approvalRoutes.documentTypeId,
            active: approvalRoutes.active,
            revision: approvalRoutes.revision,
          })
          .from(approvalRoutes)
          .where(eq(approvalRoutes.id, id))
          .for('update');
        if (!before) throw new NotFoundException();
        if (before.revision !== input.revision) {
          throw new ConflictException({ code: 'stale_route' });
        }
        const { steps, revision: _revision, ...fields } = input;
        if (fields.documentTypeId !== undefined) {
          await this.assertType(tx, fields.documentTypeId);
        }
        const changes: Record<string, unknown> = changesOf(before, fields);
        if (steps) {
          await this.assertSteps(tx, steps);
          const old = (await this.route(tx, id)).steps;
          await this.writeSteps(tx, auth.tenant.id, id, steps);
          changes.steps = { from: old, to: steps };
        }
        if (Object.keys(changes).length > 0) {
          await tx
            .update(approvalRoutes)
            .set({
              ...fields,
              revision: sql`${approvalRoutes.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(eq(approvalRoutes.id, id));
          await this.provisioning.audit(
            tx,
            auth.tenant.id,
            auth.user.id,
            'approval_route_updated',
            'approval_route',
            id,
            changes,
          );
        }
        return this.route(tx, id);
      });
    } catch (e) {
      if (isUnique(e)) throw new ConflictException({ code: 'route_exists' });
      throw e;
    }
  }

  // The module's own settings.

  /**
   * The client's settings of the module, its defaults until it sets them:
   * the longest review period, and the authoritative language for
   * documents, as set (`authoritativeLocale`, null: the main language) and
   * as it stands now (`authoritative`).
   */
  settings(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) =>
      this.settingsView(tx, auth, await documentSettingsOf(tx)),
    );
  }

  /**
   * With the window in which existing documents may be imported
   * (`importWindow`: the day the module was first switched on, the last
   * day imports are accepted, the latest approval day accepted, and
   * whether it is open), which Trustline's staff set.
   */
  private async settingsView(
    tx: Transaction,
    auth: AuthContext,
    row: { maxReviewMonths: number; authoritativeLocale: string | null; revision: number },
  ) {
    return {
      maxReviewMonths: row.maxReviewMonths,
      authoritativeLocale: row.authoritativeLocale,
      authoritative: authoritativeLocale(auth.tenant, row),
      revision: row.revision,
      importWindow: importWindowView(await importWindowOf(tx, auth.tenant)),
    };
  }

  /**
   * Changes the client's settings, given the revision the caller read (409
   * `stale_settings`).
   *
   * The longest review period may not be set below a type's own period
   * (409 `type_exceeds_max`, with the `types`): lower those first.
   * Documents whose period is longer keep it until it is next changed,
   * which must then be within the new maximum.
   *
   * The authoritative language is one of the client's languages (400
   * `language_mismatch`), or null for its main language. Changing it
   * changes no version: what was written, sent, approved or published
   * keeps its text, and runs in progress go on. From then on every draft
   * is checked, flagged and shown against the new language, and is sent
   * for review only with its required sections and change summary written
   * in it. A version that is no longer a draft keeps the language recorded
   * on it when it was sent or imported (security review 7, finding 3), so
   * its flags and the text its readers fall back to do not change. How many versions
   * are in progress is said in the answer and kept in the audit entry, so
   * that the screen can tell whoever changed it.
   */
  updateSettings(
    auth: AuthContext,
    input: {
      maxReviewMonths?: number;
      authoritativeLocale?: string | null;
      revision: number;
    },
  ) {
    if (
      input.authoritativeLocale &&
      !auth.tenant.locales.includes(input.authoritativeLocale)
    ) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      // The row exists from the first change on; whoever makes it first
      // makes it as the defaults, and both then take turns on its lock.
      await tx
        .insert(documentSettings)
        .values({ tenantId: auth.tenant.id })
        .onConflictDoNothing();
      const before = await documentSettingsOf(tx, true);
      if (before.revision !== input.revision) {
        throw new ConflictException({ code: 'stale_settings' });
      }
      const changes: Record<string, unknown> = {};
      const set: Partial<typeof documentSettings.$inferInsert> = {};
      if (
        input.maxReviewMonths !== undefined &&
        input.maxReviewMonths !== before.maxReviewMonths
      ) {
        const over = await tx
          .select({
            id: documentTypes.id,
            code: documentTypes.code,
            defaultReviewMonths: documentTypes.defaultReviewMonths,
          })
          .from(documentTypes)
          .where(
            and(
              eq(documentTypes.active, true),
              sql`${documentTypes.defaultReviewMonths} > ${input.maxReviewMonths}`,
            ),
          )
          .orderBy(asc(documentTypes.code));
        if (over.length > 0) {
          throw new ConflictException({ code: 'type_exceeds_max', types: over });
        }
        set.maxReviewMonths = input.maxReviewMonths;
        changes.maxReviewMonths = {
          from: before.maxReviewMonths,
          to: input.maxReviewMonths,
        };
      }
      let versionsInProgress: Record<string, number> | null = null;
      if (
        input.authoritativeLocale !== undefined &&
        input.authoritativeLocale !== before.authoritativeLocale
      ) {
        set.authoritativeLocale = input.authoritativeLocale;
        changes.authoritativeLocale = {
          from: before.authoritativeLocale,
          to: input.authoritativeLocale,
        };
        const from = authoritativeLocale(auth.tenant, before);
        const to = authoritativeLocale(auth.tenant, {
          authoritativeLocale: input.authoritativeLocale,
        });
        if (from !== to) {
          changes.authoritative = { from, to };
          const counts = await tx
            .select({ status: documentVersions.status, count: count() })
            .from(documentVersions)
            .where(inArray(documentVersions.status, ['draft', 'in_review', 'approved']))
            .groupBy(documentVersions.status);
          versionsInProgress = { draft: 0, in_review: 0, approved: 0 };
          for (const row of counts) versionsInProgress[row.status] = row.count;
          changes.versionsInProgress = versionsInProgress;
        }
      }
      if (Object.keys(set).length === 0) return this.settingsView(tx, auth, before);
      const [after] = await tx
        .update(documentSettings)
        .set({
          ...set,
          revision: sql`${documentSettings.revision} + 1`,
          updatedBy: auth.user.id,
          updatedAt: new Date(),
        })
        .where(eq(documentSettings.tenantId, auth.tenant.id))
        .returning({
          maxReviewMonths: documentSettings.maxReviewMonths,
          authoritativeLocale: documentSettings.authoritativeLocale,
          revision: documentSettings.revision,
        });
      await this.provisioning.audit(
        tx,
        auth.tenant.id,
        auth.user.id,
        'document_settings_updated',
        'tenant',
        auth.tenant.id,
        changes,
      );
      return {
        ...(await this.settingsView(tx, auth, after)),
        ...(versionsInProgress && { versionsInProgress }),
      };
    });
  }

  /**
   * The client's roles, by name, for those who manage documents: to narrow
   * an audience to roles, or name a role in an approval step (`approves`:
   * whether it includes `policies.approve`, which a step needs). Names and
   * ids only: what else a role allows is for those who manage roles.
   */
  roles(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) =>
      tx
        .select({
          id: roles.id,
          code: roles.code,
          name: roles.name,
          isSystem: roles.isSystem,
          approves: sql<boolean>`${APPROVE_PERMISSION} = any(${roles.permissions})`,
        })
        .from(roles)
        .orderBy(asc(roles.code)),
    );
  }
}
