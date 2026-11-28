import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client.js';
import { DATABASE } from './database.constants.js';

@Injectable()
export class TenantDb {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Runs `fn` in a transaction that can only see and write the given tenant's
   * rows. This is the only way application code should touch tenant data.
   */
  withTenant<T>(
    tenantId: string,
    fn: (tx: Transaction) => Promise<T>,
    // For a reader that must see one moment throughout (the audit chain's
    // check, security review 12, H2): `repeatable read`. The database's
    // default, read committed, otherwise.
    options: { isolationLevel?: 'read committed' | 'repeatable read' } = {},
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select set_config('app.tenant_id', ${tenantId}, true)`,
      );
      return fn(tx);
    }, options.isolationLevel ? { isolationLevel: options.isolationLevel } : undefined);
  }
}
