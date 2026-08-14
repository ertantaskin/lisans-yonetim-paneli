import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import type { Notification } from '../db/schema/notifications';
import { LowStockService } from './low-stock.service';
import { NotificationsService } from './notifications.service';
import { SiteSilenceService } from './site-silence.service';

/**
 * Okundu işaretleme gövdesi (§17 çan). `ids` (seçili bildirimler) VEYA `all: true`
 * (tümünü okundu yap) beklenir; ikisi de yoksa 400 — "yanlışlıkla hepsini okudu yapma"
 * korumasi açık niyet ister. id'ler UUID doğrulanır (geçersiz id pg 22P02 → 500 üretmesin).
 */
const MarkReadBody = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(500).optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => b.all === true || (b.ids?.length ?? 0) > 0, {
    message: "En az bir bildirim id'si ya da all:true gerekli",
  });

/** Admin: bildirim akışı + okuma durumu + düşük stok elle tetik (§12/§17). */
@Controller('admin/notifications')
@UseGuards(AdminGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly lowStock: LowStockService,
    private readonly siteSilence: SiteSilenceService,
  ) {}

  /**
   * Son bildirimler (createdAt DESC). limit varsayılan 50, 1..200 sınırlı.
   * `?unread=true` yalnız okunmamışları döndürür (çan dropdown'ı / okunmamış görünümü).
   * Yanıta `readAt` alanı dahildir (null = okunmamış).
   */
  @Get()
  async list(
    @Query('limit') limit?: string,
    @Query('unread') unread?: string,
  ): Promise<Notification[]> {
    const n = Number(limit);
    const clamped = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 200) : 50;
    const unreadOnly = unread === 'true' || unread === '1';
    return this.notifications.list(clamped, { unreadOnly });
  }

  /** Okunmamış bildirim sayısı (çan rozeti — canlı uç kullanılamadığında hafif yedek). */
  @Get('unread-count')
  async unreadCount(): Promise<{ unread: number }> {
    return { unread: await this.notifications.unreadCount() };
  }

  /**
   * Bildirimleri okundu işaretle: { ids: [...] } (seçili) veya { all: true } (tümü).
   * Yalnız okunmamışlar güncellenir → idempotent; `marked` gerçekten yeni okunanları sayar.
   * Okuma durumu GLOBAL olduğundan aktör yalnız iz/log amaçlıdır (yetki AdminGuard'da).
   */
  @Post('read')
  async markRead(
    @Body(new ZodBody(MarkReadBody)) body: z.infer<typeof MarkReadBody>,
    @AdminActor() actor: string,
  ): Promise<{ marked: number; unread: number }> {
    // actor okuma durumunu ETKİLEMEZ (global okuma) — imza tutarlılığı + ileride iz için alınır.
    void actor;
    return this.notifications.markRead({ ids: body.ids, all: body.all });
  }

  /** Düşük stok taramasını elle çalıştırır (ops + doğrulama). */
  @Post('check-low-stock')
  async checkLowStock(): Promise<{ created: number }> {
    return { created: await this.lowStock.checkLowStock() };
  }

  /**
   * Mağaza sessizlik (canlılık) taramasını elle çalıştırır (§16 — ops + doğrulama).
   * Tekrarlı iş 30 dakikada bir zaten koşar; bu uç "şimdi bak" içindir.
   */
  @Post('check-site-silence')
  async checkSiteSilence(): Promise<{ created: number }> {
    return { created: await this.siteSilence.checkSilence() };
  }
}
