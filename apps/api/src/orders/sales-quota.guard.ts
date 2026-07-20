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

/**
 * Günlük satış kotası ön-kontrolü (§5). HmacGuard'dan SONRA çalışır (req.site iliştirilmiş
 * olmalı). Site salesDailyQuota tanımlıysa bugünkü (created_at >= date_trunc('day', now()))
 * sipariş sayısını sayar; kota dolmuşsa 429 döner ve çekirdek atama akışına HİÇ girilmez.
 *
 * Çekirdek createOrder mantığı (atomik atama / idempotency) DEĞİŞMEZ — bu yalnız ön-guard.
 */
@Injectable()
export class SalesQuotaGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Database) {}

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
      throw new HttpException('Günlük satış kotası aşıldı', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
