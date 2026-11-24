import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { requireEnv } from '../env.js';
import { createDatabase } from './client.js';
import {
  DATABASE,
  DATABASE_POOLS,
  PLATFORM_DATABASE,
} from './database.constants.js';
import { TenantDb } from './tenant-db.service.js';

type Connections = Record<
  'app' | 'platform',
  ReturnType<typeof createDatabase>
>;
const CONNECTIONS = Symbol('CONNECTIONS');

@Global()
@Module({
  providers: [
    {
      provide: CONNECTIONS,
      useFactory: (): Connections => ({
        app: createDatabase(requireEnv('APP_DATABASE_URL')),
        platform: createDatabase(requireEnv('PLATFORM_DATABASE_URL')),
      }),
    },
    {
      provide: DATABASE,
      useFactory: (c: Connections) => c.app.db,
      inject: [CONNECTIONS],
    },
    {
      provide: PLATFORM_DATABASE,
      useFactory: (c: Connections) => c.platform.db,
      inject: [CONNECTIONS],
    },
    {
      provide: DATABASE_POOLS,
      useFactory: (c: Connections) => [c.app.pool, c.platform.pool],
      inject: [CONNECTIONS],
    },
    TenantDb,
  ],
  exports: [DATABASE, PLATFORM_DATABASE, TenantDb],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(DATABASE_POOLS) private readonly pools: Pool[]) {}

  async onModuleDestroy() {
    await Promise.all(this.pools.map((pool) => pool.end()));
  }
}
