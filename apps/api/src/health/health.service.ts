import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inject, Injectable } from '@nestjs/common';
import type { HealthResponse } from '@lisans/shared';
import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, type Database } from '../db/db.module';
import { REDIS } from '../redis/redis.module';

/**
 * Uygulama sürümü — package.json'dan okunur (BULGU 3). Üretimde servis `node dist/main.js` ile
 * çalıştığından `npm_package_version` SET DEĞİLDİR (yalnız `npm run …` altında dolar) → eski kod
 * her zaman '0.0.0' dönüyordu. package.json tek doğruluk kaynağı: sürüm yükseltilince yansır.
 * __dirname hem `src/health/` hem `dist/health/` altında aynı derinlikte → `../../package.json`
 * = apps/api/package.json (runtime imajında dist yanında mevcut). `import` yerine dosya okuması:
 * JSON rootDir (src) dışı olduğundan derlemeye dahil edilmez. Okunamazsa güvenli fallback.
 */
const APP_VERSION: string = (() => {
  try {
    const raw = readFileSync(join(__dirname, '../../package.json'), 'utf8');
    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
  } catch {
    return process.env.npm_package_version ?? '0.0.0';
  }
})();

/**
 * Sağlık probu bağımlılık kontrol tavanı (ms). Redis/DB donsa (OOM/pause/ağ) bile /health bu süre
 * içinde HIZLICA `degraded` (503) döner, ASKIDA KALMAZ. redis.commandTimeout (2sn) zaten reject
 * eder ama bu Promise.race, komut seviyesinde YAKALANMAYAN donmalara (ör. bağlantı el sıkışması)
 * karşı belt-and-suspenders ikinci kalkandır. DB'de de aynı tavan uygulanır.
 */
const PING_TIMEOUT_MS = 2000;

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
      version: APP_VERSION,
      time: new Date().toISOString(),
      checks: { db, redis },
    };
  }

  /**
   * `p`'yi en fazla PING_TIMEOUT_MS bekler; süre dolarsa `fallback` ile çözer (ASLA reject etmez).
   * `p` (ping) zaten kendi içinde try/catch ile boolean döndüğünden race sonrası bekleyen taraf
   * unhandled-rejection üretmez. Timer temizlenir (kazanan taraf ne olursa olsun event-loop'u tutmaz).
   */
  private async withTimeout(p: Promise<boolean>, fallback: boolean): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(fallback), PING_TIMEOUT_MS);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private pingDb(): Promise<boolean> {
    const probe = (async () => {
      try {
        await this.db.execute(sql`select 1`);
        return true;
      } catch {
        return false;
      }
    })();
    // Donma → kısa timeout'ta `false` (degraded), askıda kalma yok.
    return this.withTimeout(probe, false);
  }

  private pingRedis(): Promise<boolean> {
    const probe = (async () => {
      try {
        const pong = await this.redis.ping();
        return pong === 'PONG';
      } catch {
        return false;
      }
    })();
    return this.withTimeout(probe, false);
  }
}
