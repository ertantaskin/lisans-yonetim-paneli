import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CreateOrderRequest, type CreateOrderResponse } from '@jetlisans/shared';
import { HmacGuard } from '../auth/hmac.guard';
import { CurrentSite } from '../auth/current-site.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import type { Site } from '../db/schema';
import { OrdersService } from './orders.service';
import { AdminOrdersService } from './admin-orders.service';
import { SalesQuotaExceededException } from './sales-quota.exception';

/** Site-facing revoke gövdesi — reason opsiyonel (WP iade/iptal sebebi). */
const RevokeOrderRequest = z.object({ reason: z.string().min(1).max(500).optional() });

/** Site-facing toplu durum gövdesi (#33) — en fazla 100 remote sipariş id (payload dönmez). */
const BulkStatusRequest = z.object({
  remoteOrderIds: z.array(z.string().min(1)).max(100),
});
type BulkStatusRequest = z.infer<typeof BulkStatusRequest>;

/** Site-facing sipariş uçları (§4). HMAC imzalı. */
@Controller('orders')
@UseGuards(HmacGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly adminOrders: AdminOrdersService,
  ) {}

  // Satış kotası ön-kontrolü artık OrdersService.createOrder içinde, idempotency
  // lookup'ından SONRA çalışır (idempotent retry 429'a takılmasın diye). Guard bu
  // yüzden route'a bağlı DEĞİL — sadece HmacGuard kimlik doğrular.
  @Post()
  async create(
    @CurrentSite() site: Site,
    @Body(new ZodBody(CreateOrderRequest)) body: CreateOrderRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateOrderResponse> {
    try {
      const outcome = await this.orders.createOrder(site, body);
      // 201 fully / 207 partial / 202 pending_stock / 202 held_for_review (§4/§8)
      reply.status(outcome.httpStatus);
      return outcome.body;
    } catch (e) {
      // Sert kota aşımı (§5): 429'a Retry-After başlığı ekle (gün sınırında sıfırlanır). Fastify
      // reply header'ı istisna filtresi 429'u render etmeden ÖNCE korur → başlık yanıtta kalır.
      if (e instanceof SalesQuotaExceededException) {
        reply.header('retry-after', String(e.retryAfterSec));
      }
      throw e;
    }
  }

  /** Müşteri ekranı: yalnız aktif atamalar + çözülmüş payload (§4, §7). */
  @Get(':id/deliveries')
  deliveries(@CurrentSite() site: Site, @Param('id') id: string) {
    return this.orders.getDeliveries(site, id);
  }

  /**
   * Toplu durum yoklama (#33): WP eklentisi çok siparişi tek çağrıda kontrol eder. Yalnız
   * site kapsamındaki siparişler için { remoteOrderId, status, fulfilled, total } döner —
   * PAYLOAD/KEY YOK. @HttpCode(200): sorgu, kaynak yaratmaz (POST varsayılanı 201 olurdu).
   * Tek segment yol (`orders/bulk-status`) — `:remoteOrderId/revoke` (iki segment) ile çakışmaz.
   */
  @Post('bulk-status')
  @HttpCode(200)
  bulkStatus(
    @CurrentSite() site: Site,
    @Body(new ZodBody(BulkStatusRequest)) body: BulkStatusRequest,
  ) {
    return this.orders.bulkStatus(site, body.remoteOrderIds);
  }

  /**
   * İade/iptal → lisans revoke (§2). WooCommerce sipariş refunded/cancelled olunca WP
   * eklentisi çağırır. Siteye ait siparişin aktif atamalarını idempotent geri alır.
   * Payload/key DÖNMEZ. @HttpCode(200): WP idempotent olarak 200'ü başarı sayar (Nest
   * POST varsayılanı 201 olurdu → WP tekrar-tekrar denerdi).
   */
  @Post(':remoteOrderId/revoke')
  @HttpCode(200)
  revoke(
    @CurrentSite() site: Site,
    @Param('remoteOrderId') remoteOrderId: string,
    @Body(new ZodBody(RevokeOrderRequest)) body: { reason?: string },
  ) {
    return this.adminOrders.revokeOrderForSite(
      site,
      remoteOrderId,
      body.reason ?? 'WooCommerce iade/iptal',
    );
  }
}
