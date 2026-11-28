import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../database/client.js';
import { PLATFORM_DATABASE } from '../database/database.constants.js';
import {
  platformAdmins,
  platformAuditLog,
  tenants,
} from '../database/schema.js';
import {
  PlatformAuthGuard,
  type PlatformRequest,
} from './platform-auth.guard.js';
import { PlatformAuthService } from './platform-auth.service.js';
import { fitsLanguages, localeSchema, localizedText } from '../i18n/locales.js';
import { line } from '../i18n/text.js';
import { canonicalTimeZone } from '../i18n/time-zones.js';
import { pgErrorCode } from '../database/errors.js';
import { roleAssignments, roles, users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import { SubscriptionsService } from '../subscriptions/subscriptions.service.js';
import { plans, subscriptions } from '../database/schema.js';
import { ForModule } from '../subscriptions/module.decorator.js';

const settings = {
  name: localizedText(200),
  // The languages the client works in, and the one its text must exist in.
  locales: z
    .array(localeSchema)
    .min(1)
    .transform((list) => [...new Set(list)]),
  accreditationStandard: z.enum(['JCI', 'CBAHI']),
  defaultLocale: localeSchema,
  signInMethod: z.enum(['password', 'sso', 'both']),
  // One line, free of control characters, or nothing.
  dataRegion: line(0, 100)
    .nullable()
    .transform((v) => v || null),
};

// The hospital's own clock, as an IANA name ("Asia/Beirut"). Whether the
// runtime knows the name is checked apart from the shape, so that a name it
// does not know is answered with its own code.
const timeZone = z.string().max(64);

const createSchema = z.strictObject({
  // Lowercase letters, digits and hyphens. Fixed once created.
  slug: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/),
  ...settings,
  // Left out, the client starts on UTC.
  timeZone: timeZone.optional(),
  // The plan its subscription starts on, active from today. Left out, the
  // plan every client had until plans existed (PLAN_WHEN_NONE_NAMED).
  planId: z.uuid().optional(),
});

const updateSchema = z
  .strictObject({
    ...settings,
    timeZone,
    status: z.enum(['active', 'suspended']),
  })
  .partial();

const idSchema = z.uuid();

/**
 * What the portal is shown of a client: its settings and status, by name.
 * Not when its access was last reset, which only the API uses.
 */
const client = {
  id: tenants.id,
  slug: tenants.slug,
  name: tenants.name,
  locales: tenants.locales,
  accreditationStandard: tenants.accreditationStandard,
  defaultLocale: tenants.defaultLocale,
  dataRegion: tenants.dataRegion,
  status: tenants.status,
  signInMethod: tenants.signInMethod,
  publicReporting: tenants.publicReporting,
  timeZone: tenants.timeZone,
  createdAt: tenants.createdAt,
};

const administratorSchema = z.strictObject({
  name: localizedText(200),
  email: z.email().max(320),
});

const isUniqueViolation = (e: unknown) => pgErrorCode(e) === '23505';

/** A client's subscription as the list of clients shows it. */
const summary = (s: {
  status: string | null;
  planId: string | null;
  planCode: string | null;
  planName: unknown;
}) =>
  s.status && s.planId
    ? {
        status: s.status,
        plan: { id: s.planId, code: s.planCode, name: s.planName },
      }
    : null;

@Controller('platform/tenants')
@UseGuards(PlatformAuthGuard)
@ForModule('core')
export class PlatformTenantsController {
  constructor(
    @Inject(PLATFORM_DATABASE) private readonly db: Database,
    private readonly auth: PlatformAuthService,
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /** Each client with its subscription's status and plan. */
  @Get()
  async list() {
    const rows = await this.db
      .select({
        tenant: client,
        status: subscriptions.status,
        planId: plans.id,
        planCode: plans.code,
        planName: plans.name,
      })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.id, subscriptions.planId))
      .orderBy(asc(tenants.slug));
    return rows.map(({ tenant, ...s }) => ({
      ...tenant,
      subscription: summary(s),
    }));
  }

  @Post()
  async create(@Body() body: unknown, @Req() req: PlatformRequest) {
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    this.assertLanguages(parsed.data);
    const { planId, ...values } = this.withTimeZone(parsed.data);
    try {
      // The client, its subscription and its audit entry are saved together
      // or not at all.
      const tenant = await this.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(tenants)
          .values(values)
          .returning(client);
        const plan = await this.subscriptions.start(tx, created, planId);
        await this.auth.audit(
          req.platformAdmin.id,
          'client_created',
          created.id,
          { slug: created.slug, plan: plan.code },
          tx,
        );
        // And in the client's own log, its first entry.
        await this.provisioning.auditClientCreated(tx, created.id, {
          slug: created.slug,
          plan: plan.code,
          platformAdminId: req.platformAdmin.id,
          platformAdminName: req.platformAdmin.name,
        });
        return created;
      });
      // Safe to repeat: creating an administrator runs it again.
      await this.tenantDb.withTenant(tenant.id, async (tx) => {
        await this.provisioning.ensureSystemRoles(tx, tenant.id);
        await this.provisioning.ensureIncidentCategories(tx, tenant.id);
        await this.provisioning.ensureResponseRules(tx, tenant.id);
        await this.provisioning.ensurePolicyDefaults(tx, tenant.id);
      });
      return tenant;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException({ code: 'slug_taken' });
      }
      throw e;
    }
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const [row] = await this.db
      .select({
        tenant: client,
        status: subscriptions.status,
        planId: plans.id,
        planCode: plans.code,
        planName: plans.name,
      })
      .from(tenants)
      .leftJoin(subscriptions, eq(subscriptions.tenantId, tenants.id))
      .leftJoin(plans, eq(plans.id, subscriptions.planId))
      .where(eq(tenants.id, this.parseId(id)));
    if (!row) throw new NotFoundException();
    const { tenant, ...s } = row;

    const activity = await this.db
      .select({
        id: platformAuditLog.id,
        action: platformAuditLog.action,
        details: platformAuditLog.details,
        createdAt: platformAuditLog.createdAt,
        adminName: platformAdmins.name,
      })
      .from(platformAuditLog)
      .leftJoin(platformAdmins, eq(platformAdmins.id, platformAuditLog.adminId))
      .where(eq(platformAuditLog.targetTenantId, tenant.id))
      .orderBy(desc(platformAuditLog.createdAt))
      .limit(20);

    return { ...tenant, subscription: summary(s), activity };
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success || Object.keys(parsed.data).length === 0) {
      throw new BadRequestException();
    }
    const values = this.withTimeZone(parsed.data);
    const tenantId = this.parseId(id);
    // Suspending ends every session and every one-time link of the client,
    // as the application role, which alone may write them. Its transaction
    // is opened around the platform's and written before the platform's
    // commits, so a change that fails revokes nothing and a revocation that
    // fails changes nothing. Neither is what keeps them ended: a session or
    // link issued before the client last went to or from suspended is
    // refused whenever it is used (AuthService), so a client made active
    // again brings none of them back.
    return this.tenantDb.withTenant(tenantId, (appTx) =>
      this.db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(tenants)
          .where(eq(tenants.id, tenantId))
          .for('update');
        if (!before) throw new NotFoundException();
        this.assertLanguages({ ...before, ...values });
        // Going to or from suspended voids every session and link issued
        // until now: by the database's clock, as a session's own time is,
        // and taken under the row's lock, after any change before this one
        // was committed.
        const resets =
          values.status !== undefined &&
          (before.status === 'suspended') !== (values.status === 'suspended');
        const [after] = await tx
          .update(tenants)
          .set({
            ...values,
            ...(resets && { accessResetAt: sql`clock_timestamp()` }),
          })
          .where(eq(tenants.id, tenantId))
          .returning(client);
        // What changed, with the old and new value of each field.
        const changes = Object.fromEntries(
          (Object.keys(values) as (keyof typeof values)[])
            .filter(
              (key) =>
                JSON.stringify(before[key]) !== JSON.stringify(after[key]),
            )
            .map((key) => [key, { from: before[key], to: after[key] }]),
        );
        await this.auth.audit(
          req.platformAdmin.id,
          'client_updated',
          tenantId,
          { changes },
          tx,
        );
        // And in the client's own log, which it can read.
        if (Object.keys(changes).length > 0) {
          await this.provisioning.auditClientSettingsChanged(tx, tenantId, {
            changes,
            platformAdminId: req.platformAdmin.id,
            platformAdminName: req.platformAdmin.name,
          });
        }
        if (after.status === 'suspended' && before.status !== 'suspended') {
          await this.provisioning.endAllAccess(appTx);
        }
        return after;
      }),
    );
  }

  /**
   * Creates a hospital's first administrator and returns a one-time link for
   * them to set a password. This is the only hospital data the portal writes,
   * and it is refused once the hospital has an administrator: from then on
   * the hospital adds its own, and the portal cannot let itself in.
   */
  @Post(':id/administrators')
  async createAdministrator(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: PlatformRequest,
  ) {
    const parsed = administratorSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException();
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, this.parseId(id)));
    if (!tenant) throw new NotFoundException();
    if (tenant.status !== 'active') {
      throw new ConflictException({ code: 'client_suspended' });
    }
    // Nobody could sign in with it.
    const subscription = await this.subscriptions.read(tenant.id);
    if (subscription.status === 'cancelled') {
      throw new ConflictException({ code: 'subscription_cancelled' });
    }
    // The link sets a password, which a single sign-on only client cannot use.
    if (tenant.signInMethod === 'sso') {
      throw new ConflictException({ code: 'password_sign_in_disabled' });
    }
    if (!fitsLanguages(parsed.data.name, tenant)) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }

    try {
      const result = await this.tenantDb.withTenant(tenant.id, async (tx) => {
        await this.provisioning.ensureSystemRoles(tx, tenant.id);
        await this.provisioning.ensureIncidentCategories(tx, tenant.id);
        await this.provisioning.ensureResponseRules(tx, tenant.id);
        await this.provisioning.ensurePolicyDefaults(tx, tenant.id);
        const [administrator] = await tx
          .select({ id: roles.id })
          .from(roles)
          .where(eq(roles.code, 'administrator'));
        const [existing] = await tx
          .select({ id: users.id })
          .from(roleAssignments)
          .innerJoin(users, eq(users.id, roleAssignments.userId))
          .where(
            and(
              eq(roleAssignments.roleId, administrator.id),
              ne(users.status, 'disabled'),
            ),
          )
          .limit(1);
        if (existing) {
          throw new ConflictException({ code: 'administrator_exists' });
        }
        // Recorded first, on the portal's side, so the account can never
        // exist without a record of which staff member created it. By the
        // account's id, never its email address (audit-trail.md, "Personal
        // data in the trail").
        const userId = randomUUID();
        await this.auth.audit(
          req.platformAdmin.id,
          'client_administrator_created',
          tenant.id,
          { userId },
        );
        const user = await this.provisioning.createUser(
          tx,
          tenant.id,
          { ...parsed.data, id: userId },
          [{ roleId: administrator.id, orgUnitId: null }],
          null,
        );
        const invite = await this.provisioning.createInvite(
          tx,
          tenant.id,
          user.id,
          'invitation',
        );
        // The hospital's own log says the account came from Trustline staff.
        await this.provisioning.audit(
          tx,
          tenant.id,
          null,
          'administrator_created_by_platform',
          'user',
          user.id,
          {
            platformAdminId: req.platformAdmin.id,
            platformAdminName: req.platformAdmin.name,
          },
        );
        return {
          user: { id: user.id, email: user.email, name: user.name },
          invite: { ...invite, org: tenant.slug },
        };
      });
      return result;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException({ code: 'email_taken' });
      }
      throw e;
    }
  }

  /**
   * A client's default language is one of its languages, and its name is
   * written in the default language and in no language it does not use.
   */
  private assertLanguages(settings: {
    name: Parameters<typeof fitsLanguages>[0];
    locales: string[];
    defaultLocale: string;
  }) {
    if (
      !settings.locales.includes(settings.defaultLocale) ||
      !fitsLanguages(settings.name, settings)
    ) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
  }

  /**
   * A time zone, when one is sent, is a name the runtime knows: every day
   * the API works out for the client is counted on that clock, so a name it
   * could not count with must never be stored.
   */
  /**
   * The same values with the time zone, if one was sent, under the name it
   * is stored by: in the letter case IANA writes it, whatever was typed.
   * 400 `unknown_time_zone` if it is not a zone a hospital can have.
   */
  private withTimeZone<T extends { timeZone?: string }>(values: T): T {
    if (values.timeZone === undefined) return values;
    const timeZone = canonicalTimeZone(values.timeZone);
    if (!timeZone) throw new BadRequestException({ code: 'unknown_time_zone' });
    return { ...values, timeZone };
  }

  private parseId(id: string) {
    const parsed = idSchema.safeParse(id);
    if (!parsed.success) throw new NotFoundException();
    return parsed.data;
  }
}
