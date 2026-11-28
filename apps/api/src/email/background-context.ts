import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { Database } from '../database/client.js';
import { DATABASE } from '../database/database.constants.js';
import { tenants, users } from '../database/schema.js';
import { TenantDb } from '../database/tenant-db.service.js';
import { AuthService, type AuthContext } from '../identity/auth.service.js';

/**
 * What a person may see and do now, as if they were signed in, for the one
 * piece of work done on their behalf in the background: the email digest,
 * where what waits for them is what their screens would show them.
 *
 * A provider of EmailModule's own (security review 8), declared there and
 * exported to nothing: no other module can build a context without a
 * session. Never for answering a request: a request has a session.
 */
@Injectable()
export class BackgroundContext {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly tenantDb: TenantDb,
    private readonly auth: AuthService,
  ) {}

  /**
   * Null unless the client is active, its subscription not cancelled, and
   * the person active.
   */
  async of(tenantId: string, userId: string): Promise<AuthContext | null> {
    const [tenant] = await this.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (!tenant || tenant.status !== 'active') return null;
    return this.tenantDb.withTenant(tenant.id, async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user || user.status !== 'active') return null;
      return this.auth.contextIn(tx, tenant, user, '', null);
    });
  }
}
