import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { SupplyOpsService } from './supply-ops.service';

/**
 * Parti listesi süzgeci. `productId` boş string olarak da gelebilir (istemci `?productId=`
 * yazarsa) → `''` MEŞRU kabul edilip "süzgeç yok"a çevrilir; geçersiz bir UUID ise 400.
 * (ParseUUIDPipe query'de `''`i reddederdi; supplier-claims.controller'daki aynı desen.)
 */
const BatchListQuery = z.object({
  productId: z.union([z.literal(''), z.string().uuid()]).optional(),
});
type BatchListQuery = z.infer<typeof BatchListQuery>;

const RecallBody = z.object({ reason: z.string().min(1) });
type RecallBody = z.infer<typeof RecallBody>;

const BulkReplaceBody = z.object({ actor: z.string().min(1).optional() });
type BulkReplaceBody = z.infer<typeof BulkReplaceBody>;

const CreateAdjustmentBody = z
  .object({
    productId: z.string().uuid(),
    /** Tekil kalem (eski istemciler + 'Düzeltme' defter kaydı). */
    licenseItemId: z.string().uuid().optional(),
    /**
     * TOPLU kalem (yeni): bozuk bir parti geldiğinde operatör anahtarları tek tek seçmek
     * zorunda kalmasın diye envanter listesinden çoklu seçim gönderir. `licenseItemId` ile
     * BİRLİKTE gönderilemez (hangisinin geçerli olduğu belirsizleşir). Üst sınır 500:
     * tek transaction'da kilitlenecek satır sayısını sınırlar.
     */
    licenseItemIds: z.array(z.string().uuid()).min(1).max(500).optional(),
    action: z.enum(['void', 'damage', 'correct', 'recall']),
    /**
     * Defter kaydına yazılan adet. Üst sınır int4 taşmasına karşı (stock_adjustments.qty
     * `integer`): sınırsız girdi 2.147.483.647 üstünde PG 22003 ile ham 500 üretirdi, artık
     * kullanıcı 400 alır (gerekçe: purchase-orders.controller:16). 1.000.000 tavanı stok
     * girişi/PO adet tavanlarıyla hizalıdır — tek bir düzeltme kaydı bir stok girişinden
     * daha büyük olamaz.
     */
    qty: z.number().int().nonnegative().max(1_000_000).default(0),
    reason: z.string().min(1),
  })
  .refine((b) => !(b.licenseItemId && b.licenseItemIds), {
    message: 'licenseItemId ve licenseItemIds birlikte gönderilemez',
    path: ['licenseItemIds'],
  });
type CreateAdjustmentBody = z.infer<typeof CreateAdjustmentBody>;

/**
 * Admin: tedarik operasyonları (§12) — parti geri çekme + sebepli stok düzeltme.
 * ADMIN_TOKEN gerektirir. Kritik aksiyonlar sebep + audit ile yazılır.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class SupplyOpsController {
  constructor(private readonly supplyOps: SupplyOpsService) {}

  /**
   * Parti listesi. `{ items, truncated }` — truncated=true ise liste üst sınırda kırpıldı.
   *
   * Zarf anahtarı `items`: panelin TÜM liste uçlarının sözleşmesi bu (customers/sites/…) ve
   * admin tarafındaki savunmalı okuyucular (`Array.isArray(d) ? d : d?.items ?? []`) tam olarak
   * bunu bekliyor. Başka bir ad (ör. `rows`) sessizce BOŞ liste gösterirdi — bu projede daha
   * önce yaşanmış sessiz-kırpma sınıfı.
   *
   * `?productId=<uuid>` (opsiyonel): üst sınır O ÜRÜNÜN partilerine uygulanır. Süzgeç yalnız
   * istemcide kalırsa, ürünün aktif partisi global pencerenin dışında kaldığında seçicide hiç
   * görünmez ve operatöre yanlışlıkla "bu ürünün aktif partisi yok" denir. Yanıt şekli AYNI.
   */
  @Get('batches')
  async listBatches(@Query(new ZodBody(BatchListQuery)) q: BatchListQuery) {
    const productId = (q.productId ?? '').trim() || undefined;
    const { rows, truncated } = await this.supplyOps.listBatches(undefined, productId);
    return { items: rows, truncated };
  }

  /** Tek parti (detay ekranı). Liste satırıyla AYNI şekil — sayaçlar dahil. */
  @Get('batches/:id')
  getBatch(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.supplyOps.getBatch(id);
  }

  @Post('batches/:id/recall')
  recall(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(RecallBody)) body: RecallBody,
    @AdminActor() actor: string,
  ) {
    return this.supplyOps.recallBatch(id, body.reason, actor);
  }

  /**
   * Toplu değiştirme (§13): partiye ait satılmış + aktif atamalı kalemleri MEVCUT değişim
   * makinesiyle yenisiyle değiştirir (stok olmayanı atlar). Dön: { total, replaced, skippedNoStock }.
   */
  @Post('batches/:id/bulk-replace')
  bulkReplace(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(BulkReplaceBody)) body: BulkReplaceBody,
    @AdminActor() actor: string,
  ) {
    // actor artık oturumdan (x-admin-actor header) gelir; body.actor legacy/yok sayılır.
    void body;
    return this.supplyOps.bulkReplaceBatch(id, actor);
  }

  @Post('stock-adjustments')
  createAdjustment(
    @Body(new ZodBody(CreateAdjustmentBody)) body: CreateAdjustmentBody,
    @AdminActor() actor: string,
  ) {
    return this.supplyOps.createAdjustment(body, actor);
  }

  @Get('stock-adjustments')
  listAdjustments(@Query('productId') productId?: string) {
    return this.supplyOps.listAdjustments(productId);
  }
}
