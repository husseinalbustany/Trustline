import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import type { Transaction } from '../database/client.js';
import {
  emailPreferences,
  emailSettings,
  notifications,
  roleAssignments,
  roles,
  users,
} from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import type { AuthContext } from '../identity/auth.service.js';
import { ProvisioningService } from '../identity/provisioning.service.js';
import type { Locale } from '../i18n/locales.js';
import { MAIL_SENDER, type MailSender } from './sender.js';
import type { AlwaysOn } from './kinds.js';
import type { EmailSwitch, UnsubscribeClaim } from './unsubscribe-token.js';

export type PreferenceChange = {
  immediate?: boolean;
  digest?: boolean;
  /** Null: the organization's default. */
  language?: Locale | null;
};

/** A person's switches, as stored or by default. */
export type Switches = { immediate: boolean; digest: boolean };

/**
 * Who wants what by email: each person's two switches and language, and
 * the organization's switch. Each change is audited in its transaction.
 */
@Injectable()
export class EmailPreferencesService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly provisioning: ProvisioningService,
    @Inject(MAIL_SENDER) private readonly sender: MailSender,
  ) {}

  /** In the caller's transaction: a person's switches (both on by default). */
  async switchesOf(tx: Transaction, userId: string): Promise<Switches> {
    const [row] = await tx
      .select({
        immediate: emailPreferences.immediate,
        digest: emailPreferences.digest,
      })
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, userId));
    return row ?? { immediate: true, digest: true };
  }

  /** In the caller's transaction: whether the organization sends email. */
  async organizationEnabled(tx: Transaction) {
    const [row] = await tx
      .select({ enabled: emailSettings.enabled })
      .from(emailSettings);
    return row?.enabled ?? true;
  }

  private async mine(tx: Transaction, auth: AuthContext) {
    const [mailbox] = await this.provisioning.mailboxesOf(tx, [auth.user.id]);
    const language = mailbox?.preferredLocale ?? null;
    return {
      ...(await this.switchesOf(tx, auth.user.id)),
      // Only a language the organization still works in: otherwise its
      // default is used, and so said.
      language:
        language && auth.tenant.locales.includes(language) ? language : null,
      organizationEnabled: await this.organizationEnabled(tx),
      // What the immediate emails are for in this person's work (quality
      // review 3, S3): whether they decide approval steps, or triage
      // incidents, in the modules the organization has. The screen warns
      // before such a person switches them off.
      reliedOn: reliedOnOf(auth),
      // What their own switch does not stop (business decision 4).
      alwaysOn: alwaysOnOf(auth),
    };
  }

  /**
   * Who has switched off which kind of email (quality review 3, S3), for
   * whoever manages the settings of the whole organization: each active
   * person with a switch off, by name, with what the immediate emails are
   * for in their work. Names only: no address.
   */
  optOuts(auth: AuthContext) {
    const holds = (permission: string) =>
      sql<boolean>`exists (select from ${roleAssignments} ra join ${roles} r on r.id = ra.role_id
        where ra.user_id = ${users.id} and ${permission} = any(r.permissions))`;
    const { modules } = auth.tenant;
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const rows = await tx
        .select({
          id: users.id,
          name: users.name,
          immediate: emailPreferences.immediate,
          digest: emailPreferences.digest,
          approves: holds('policies.approve'),
          triages: holds('incidents.triage'),
        })
        .from(emailPreferences)
        .innerJoin(users, eq(users.id, emailPreferences.userId))
        .where(
          and(
            eq(users.status, 'active'),
            or(eq(emailPreferences.immediate, false), eq(emailPreferences.digest, false)),
          ),
        )
        .orderBy(sql`${users.name} ->> ${auth.tenant.defaultLocale}`, asc(users.id));
      return {
        items: rows.map(({ approves, triages, ...r }) => ({
          ...r,
          reliedOn: {
            approves: approves && modules.includes('policies'),
            triages: triages && modules.includes('incidents'),
          },
        })),
        total: rows.length,
      };
    });
  }

  get(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, (tx) => this.mine(tx, auth));
  }

  /**
   * Changes the caller's own switches and language. A language must be one
   * the organization works in: 400 `language_mismatch` otherwise. What
   * changed is audited; asking for what is already so writes nothing.
   */
  update(auth: AuthContext, change: PreferenceChange) {
    if (
      change.language &&
      !auth.tenant.locales.includes(change.language)
    ) {
      throw new BadRequestException({ code: 'language_mismatch' });
    }
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const switches: Partial<Switches> = {};
      if (change.immediate !== undefined) switches.immediate = change.immediate;
      if (change.digest !== undefined) switches.digest = change.digest;
      Object.assign(changes, await this.setSwitches(tx, auth.tenant.id, auth.user.id, switches));
      if (change.language !== undefined) {
        const before = await this.provisioning.setPreferredLocale(
          tx,
          auth.user.id,
          change.language,
        );
        if ((before ?? null) !== change.language) {
          changes.language = { from: before ?? null, to: change.language };
        }
      }
      if (Object.keys(changes).length > 0) {
        await this.provisioning.audit(
          tx,
          auth.tenant.id,
          auth.user.id,
          'notification_preferences_changed',
          'user',
          auth.user.id,
          { ...changes, via: 'settings' },
        );
      }
      return this.mine(tx, auth);
    });
  }

  /**
   * Sets switches, under a lock on the person's row so that two changes at
   * once are each read after the other. Returns what changed.
   */
  private async setSwitches(
    tx: Transaction,
    tenantId: string,
    userId: string,
    switches: Partial<Switches>,
  ) {
    if (Object.keys(switches).length === 0) return {};
    await tx
      .insert(emailPreferences)
      .values({ tenantId, userId })
      .onConflictDoNothing();
    const [before] = await tx
      .select({
        immediate: emailPreferences.immediate,
        digest: emailPreferences.digest,
      })
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, userId))
      .for('update');
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    for (const key of ['immediate', 'digest'] as const) {
      const to = switches[key];
      if (to !== undefined && to !== before[key]) {
        changes[key] = { from: before[key], to };
      }
    }
    if (Object.keys(changes).length > 0) {
      const now = new Date();
      await tx
        .update(emailPreferences)
        .set({
          ...switches,
          // Switched back on: every unsubscribe link issued until now stops
          // working for it (security review 8, L2).
          ...(changes.immediate?.to === true && { immediateOnSince: now }),
          ...(changes.digest?.to === true && { digestOnSince: now }),
          updatedAt: now,
        })
        .where(eq(emailPreferences.userId, userId));
    }
    return changes;
  }

  /**
   * Whether a link still works: it names a person who is there, and was
   * issued after they last switched that kind back on (security review 8,
   * L2), so that a link from an old email cannot switch off again what the
   * person chose to have.
   */
  private async linkHolds(tx: Transaction, claim: UnsubscribeClaim) {
    const [mailbox] = await this.provisioning.mailboxesOf(tx, [claim.userId]);
    if (!mailbox) return false;
    const [row] = await tx
      .select({
        immediateOnSince: emailPreferences.immediateOnSince,
        digestOnSince: emailPreferences.digestOnSince,
      })
      .from(emailPreferences)
      .where(eq(emailPreferences.userId, claim.userId));
    const onSince =
      claim.switch === 'immediate' ? row?.immediateOnSince : row?.digestOnSince;
    return !onSince || claim.issuedAt >= onSince.getTime();
  }

  /**
   * What an unsubscribe link does: switches off one kind of email for the
   * person it names, in the organization it names, audits it as theirs,
   * and tells them in Trustline (`email_turned_off`), so that a link used by
   * someone else does not pass unseen. False if the link no longer holds
   * (`linkHolds`; a token signed for another organization's person finds
   * nobody). Already off, it writes nothing.
   */
  unsubscribe(claim: UnsubscribeClaim, ip: string | null) {
    return this.tenantDb.withTenant(claim.tenantId, async (tx) => {
      if (!(await this.linkHolds(tx, claim))) return false;
      const off: Partial<Record<EmailSwitch, boolean>> =
        claim.switch === 'immediate' ? { immediate: false } : { digest: false };
      const changes = await this.setSwitches(
        tx,
        claim.tenantId,
        claim.userId,
        off,
      );
      if (Object.keys(changes).length > 0) {
        await this.provisioning.audit(
          tx,
          claim.tenantId,
          claim.userId,
          'notification_preferences_changed',
          'user',
          claim.userId,
          { ...changes, via: 'unsubscribe_link' },
          ip,
        );
        await tx.insert(notifications).values({
          tenantId: claim.tenantId,
          userId: claim.userId,
          kind: 'email_turned_off',
          data: { switch: claim.switch, serious: false },
        });
      }
      return true;
    });
  }

  /** Whether a link still holds: for the confirmation page. */
  exists(claim: UnsubscribeClaim) {
    return this.tenantDb.withTenant(claim.tenantId, (tx) =>
      this.linkHolds(tx, claim),
    );
  }

  /** The organization's switch, and how mail is delivered. */
  organization(auth: AuthContext) {
    return this.tenantDb.withTenant(auth.tenant.id, async (tx) => ({
      enabled: await this.organizationEnabled(tx),
      delivery: this.sender.mode,
    }));
  }

  /**
   * Switches email on or off for the whole organization. Audited when it
   * changes; asking for what is already so writes nothing.
   */
  setOrganization(auth: AuthContext, enabled: boolean) {
    const { tenant, user } = auth;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      await tx
        .insert(emailSettings)
        .values({ tenantId: tenant.id })
        .onConflictDoNothing();
      // One statement reads the old value and writes the new: two switches
      // at once leave one entry each for a real change.
      const changed = await tx
        .update(emailSettings)
        .set({ enabled, updatedBy: user.id, updatedAt: new Date() })
        .where(sql`${emailSettings.enabled} <> ${enabled}`)
        .returning({ tenantId: emailSettings.tenantId });
      if (changed.length > 0) {
        await this.provisioning.audit(
          tx,
          tenant.id,
          user.id,
          'email_setting_changed',
          'tenant',
          tenant.id,
          { enabled: { from: !enabled, to: enabled } },
        );
      }
      return { enabled, delivery: this.sender.mode };
    });
  }
}

/** What the immediate emails are for in a person's work, in the modules they have. */
function reliedOnOf(auth: AuthContext) {
  const { modules } = auth.tenant;
  return {
    // Documents' approval steps, and risks' acceptance and closure steps.
    approves:
      (modules.includes('policies') && auth.permissions.includes('policies.approve')) ||
      (modules.includes('risks') && auth.permissions.includes('risks.approve')),
    triages:
      modules.includes('incidents') && auth.permissions.includes('incidents.triage'),
  };
}

/**
 * The immediate emails a person may not switch off, and why (business
 * decision 4): kinds.ts says which notifications they are.
 */
export function alwaysOnOf(auth: AuthContext): AlwaysOn[] {
  const relied = reliedOnOf(auth);
  return [
    ...(relied.triages
      ? [{ emails: 'serious_incident_alerts' as const, reason: 'triages' as const }]
      : []),
    ...(relied.approves
      ? [{ emails: 'approval_steps' as const, reason: 'decides_approval_steps' as const }]
      : []),
  ];
}

