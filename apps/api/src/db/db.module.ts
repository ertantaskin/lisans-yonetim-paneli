import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_CLIENT = Symbol('PG_CLIENT');

export type Database = PostgresJsDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.getOrThrow<string>('DATABASE_URL');
        // max: API stateless çoğaltıldığı için havuz mütevazı tutulur (§1).
        return postgres(url, { max: 10 });
      },
    },
    {
      provide: DB,
      inject: [PG_CLIENT],
      useFactory: (client: ReturnType<typeof postgres>) => drizzle(client, { schema }),
    },
  ],
  exports: [DB, PG_CLIENT],
})
export class DbModule implements OnModuleDestroy {
  constructor() {}

  async onModuleDestroy(): Promise<void> {
    // Bağlantı kapatma enableShutdownHooks üzerinden PG_CLIENT provider'ında
    // ele alınır; postgres-js süreç kapanışında sonlandırılır.
  }
}
