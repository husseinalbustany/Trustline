import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';
import { DATABASE, DATABASE_POOL } from './database.constants.js';
import { TenantDb } from './tenant-db.service.js';

@Global()
@Module({
  providers: [
    {
      provide: 'DATABASE_CONNECTION',
      useFactory: () => createDatabase(requireEnv('APP_DATABASE_URL')),
    },
    {
      provide: DATABASE,
      useFactory: (c: ReturnType<typeof createDatabase>) => c.db,
      inject: ['DATABASE_CONNECTION'],
    },
    {
      provide: DATABASE_POOL,
      useFactory: (c: ReturnType<typeof createDatabase>) => c.pool,
      inject: ['DATABASE_CONNECTION'],
    },
    TenantDb,
  ],
  exports: [DATABASE, TenantDb],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onModuleDestroy() {
    await this.pool.end();
  }
}
