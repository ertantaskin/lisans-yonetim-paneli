import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { and, eq, gte, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { orders } from '../db/schema';
import type { AuthedRequest } from '../auth/hmac.guard';
import { SecurityService } from '../security/security.service';

/** Yerel gün sınırına (gece yarısı) kalan saniye — 429 Retry-After başlığı için (§4). */
function secondsUntilLocalMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // sonraki yerel gece yarısı
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}

/**
 * Günlük satış kotası ön-kontrolü (§5). HmacGuard'dan SONRA çalışır (req.site iliştirilmiş
 * olmalı). Site salesDailyQuota tanımlıysa bugünkü (created_at >= date_trunc('day', now()))
 * sipariş sayısını sayar; kota dolmuşsa 429 döner ve çekirdek atama akışına HİÇ girilmez.
 *
 * Çekirdek createOrder mantığı (atomik atama / idempotency) DEĞİŞMEZ — bu yalnız ön-guard.
 * Aşımda: (a) 'quota_exceeded' güvenlik olayı yazılır (§5/§15 gözlemlenebilirlik — dedupe'lu,
 * otomatik yaptırım YOK), (b) yanıta Retry-After başlığı (§4 "429 Retry-After") eklenir.
 */
@Injectable()
export class SalesQuotaGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly security: SecurityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const site = req.site;
    // HmacGuard sırayla önce çalışır; site yoksa guard zinciri zaten reddederdi.
    if (!site) return true;

    // Kota tanımsız (null) → limitsiz, kontrol yok.
    if (site.salesDailyQuota == null) return true;

    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(eq(orders.siteId, site.id), gte(orders.createdAt, sql`date_trunc('day', now())`)),
      );

    const todayCount = row?.count ?? 0;
    if (todayCount >= site.salesDailyQuota) {
      // Gözlemlenebilirlik: kota aşımı security_events'e düşer (dedupe'lu). Best-effort —
      // kaydedememe sipariş reddini ETKİLEMEZ (kritik yol korunur).
      await this.security
        .recordQuotaExceeded(site.id, todayCount, site.salesDailyQuota)
        .catch(() => undefined);
      // Retry-After (§4): kota yerel gün sınırında sıfırlanır → o ana kadarki saniye.
      const res = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
      res.header?.('retry-after', String(secondsUntilLocalMidnight()));
      throw new HttpException('Günlük satış kotası aşıldı', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
