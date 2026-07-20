import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse } from '@jetlisans/shared';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, type Database } from '../db/db.module';
import { REDIS } from '../redis/redis.module';

@Injectable()
export class HealthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthResponse> {
    const [db, redis] = await Promise.all([this.pingDb(), this.pingRedis()]);

    const allOk = db && redis;
    return {
      status: allOk ? 'ok' : 'degraded',
      version: process.env.npm_package_version ?? '0.0.0',
      time: new Date().toISOString(),
      checks: { db, redis },
    };
  }

  private async pingDb(): Promise<boolean> {
    try {
      await this.db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  }

  private async pingRedis(): Promise<boolean> {
    try {
      const pong = await this.redis.ping();
      return pong === 'PONG';
    } catch {
      return false;
    }
  }
}
