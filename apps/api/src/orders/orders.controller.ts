import { Body, Controller, Get, HttpCode, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { CreateOrderRequest, type CreateOrderResponse } from '@lisans/shared';
import { HmacGuard } from '../auth/hmac.guard';
import { CurrentSite } from '../auth/current-site.decorator';
import { WpActor } from '../auth/wp-actor.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import type { Site } from '../db/schema';
import { OrdersService } from './orders.service';
import { AdminOrdersService } from './admin-orders.service';
import { SalesQuotaExceededException } from './sales-quota.exception';

/** Site-facing revoke gövdesi — reason opsiyonel (WP iade/iptal sebebi). */
const RevokeOrderRequest = z.object({ reason: z.string().min(1).max(500).optional() });

/**
 * Site-facing KISMİ iade gövdesi (§2/§7). WP eklentisi satır-bazlı NET adedi (sipariş qty −
 * iade edilen qty) gönderir; netQty=0 = o satır tamamen iade (qty→0, tüm birim revoke).
 */
const SyncRefundsRequest = z.object({
  reason: z.string().min(1).max(500).optional(),
  lines: z
    .array(
      z.object({
        remoteLineId: z.string().min(1),
        netQty: z.number().int().nonnegative(),
        // Opsiyonel (yeni eklenti): panel netQty'yi (sipariş birimi) bundleQty ile PANEL birimine
        // ölçekler. Yoksa (eski eklenti) bundleQty=1 varsayılır — geriye dönük uyumlu.
        remoteProductId: z.string().min(1).max(64).optional(),
        remoteVariationId: z.string().max(64).optional(),
      }),
    )
    .min(1)
    .max(200),
});
type SyncRefundsRequest = z.infer<typeof SyncRefundsRequest>;

/** Site-facing toplu durum gövdesi (#33) — en fazla 100 remote sipariş id (payload dönmez). */
const BulkStatusRequest = z.object({
  remoteOrderIds: z.array(z.string().min(1)).max(100),
});
type BulkStatusRequest = z.infer<typeof BulkStatusRequest>;

/** §7 meta box değiştir gövdesi — sebep zorunlu (audit + timeline). */
const ReplaceBody = z.object({ reason: z.string().min(1).max(500) });
/** §7 meta box askıya al/geri aç gövdesi. */
const SuspendBody = z.object({ suspend: z.boolean() });

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

  /**
   * KISMİ iade uzlaştırması (§2/§7 "kısmi iade → yalnız ilgili satır revoke"). WooCommerce'te
   * siparişin bazı birimleri iade edilince (woocommerce_order_refunded) WP eklentisi satır-bazlı
   * NET adedi gönderir; panel qty'yi düşürür + fazla teslim edilmiş birimleri geri alır (autoComplete
   * artık iade edileni doldurmaz). Payload/key DÖNMEZ. @HttpCode(200): idempotent (WP tekrar denemez).
   */
  @Post(':remoteOrderId/refund')
  @HttpCode(200)
  refund(
    @CurrentSite() site: Site,
    @Param('remoteOrderId') remoteOrderId: string,
    @Body(new ZodBody(SyncRefundsRequest)) body: SyncRefundsRequest,
  ) {
    return this.adminOrders.syncRefunds(
      site,
      remoteOrderId,
      body.lines,
      body.reason ?? 'WooCommerce kısmi iade',
    );
  }

  // ─── §7 Meta box operasyon katmanı (site-scoped, HMAC imzalı) ───────────────────────
  // WP meta box'ın key-bazında işlemleri. Her uç AdminOrdersService'te ÖNCE hedefin bu siteye
  // ait olduğunu doğrular (çapraz-site = 404). actor = wp:<kullanıcı>@<site.domain> — kullanıcı
  // parçası WP'den (x-wp-actor, yalnız audit), domain CurrentSite'tan (güvenilir). WP rol→scope
  // (shop_manager reveal edemez) eklenti tarafında capability ile zorlanır; panel site-scope + audit sağlar.

  /** Meta box görünümü: maskeli atamalar (assignmentId + status) + geçmiş — PAYLOAD YOK. */
  @Get(':remoteOrderId/admin-view')
  adminView(@CurrentSite() site: Site, @Param('remoteOrderId') remoteOrderId: string) {
    return this.adminOrders.siteAdminView(site, remoteOrderId);
  }

  /** Loglu reveal (§17) — tam payload döner, audit'e wp:kullanıcı@site düşer. */
  @Post(':remoteOrderId/assignments/:assignmentId/reveal')
  @HttpCode(200)
  mbReveal(
    @CurrentSite() site: Site,
    @Param('remoteOrderId') remoteOrderId: string,
    @Param('assignmentId') assignmentId: string,
    @WpActor() wpUser: string,
  ) {
    return this.adminOrders.siteReveal(
      site,
      remoteOrderId,
      assignmentId,
      `wp:${wpUser}@${site.domain}`,
    );
  }

  /** Aynı üründen taze key ile değiştir (sebepli + eski anahtar geçmişi). */
  @Post(':remoteOrderId/assignments/:assignmentId/replace')
  @HttpCode(200)
  mbReplace(
    @CurrentSite() site: Site,
    @Param('remoteOrderId') remoteOrderId: string,
    @Param('assignmentId') assignmentId: string,
    @Body(new ZodBody(ReplaceBody)) body: { reason: string },
    @WpActor() wpUser: string,
  ) {
    return this.adminOrders.siteReplace(
      site,
      remoteOrderId,
      assignmentId,
      body.reason,
      `wp:${wpUser}@${site.domain}`,
    );
  }

  /** Askıya al / geri aç (geri alınabilir gizleme). */
  @Post(':remoteOrderId/assignments/:assignmentId/suspend')
  @HttpCode(200)
  mbSuspend(
    @CurrentSite() site: Site,
    @Param('remoteOrderId') remoteOrderId: string,
    @Param('assignmentId') assignmentId: string,
    @Body(new ZodBody(SuspendBody)) body: { suspend: boolean },
    @WpActor() wpUser: string,
  ) {
    return this.adminOrders.siteSuspend(
      site,
      remoteOrderId,
      assignmentId,
      body.suspend,
      `wp:${wpUser}@${site.domain}`,
    );
  }

  /** +1 bonus atama — per-LINE (Woo item id). O satırın ürününden ekstra key ekler. */
  @Post(':remoteOrderId/lines/:remoteLineId/bonus')
  @HttpCode(200)
  mbBonus(
    @CurrentSite() site: Site,
    @Param('remoteOrderId') remoteOrderId: string,
    @Param('remoteLineId') remoteLineId: string,
    @WpActor() wpUser: string,
  ) {
    return this.adminOrders.siteBonus(
      site,
      remoteOrderId,
      remoteLineId,
      `wp:${wpUser}@${site.domain}`,
    );
  }

  /** Teslimat mailini tekrar gönder (60sn debounce). */
  @Post(':remoteOrderId/resend')
  @HttpCode(200)
  mbResend(
    @CurrentSite() site: Site,
    @Param('remoteOrderId') remoteOrderId: string,
    @WpActor() wpUser: string,
  ) {
    return this.adminOrders.siteResend(site, remoteOrderId, `wp:${wpUser}@${site.domain}`);
  }
}
