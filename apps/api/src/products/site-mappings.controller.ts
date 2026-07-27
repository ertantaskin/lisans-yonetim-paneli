import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { HmacGuard } from '../auth/hmac.guard';
import { CurrentSite } from '../auth/current-site.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import type { Site } from '../db/schema';
import { ProductsService } from './products.service';

/** §7 WP ürün-eşleme kutusu upsert gövdesi (site-scoped). */
const UpsertMappingBody = z.object({
  remoteProductId: z.string().min(1).max(64),
  remoteVariationId: z.string().max(64).optional(),
  productId: z.string().uuid(),
  bundleQty: z.number().int().min(1).max(1000).optional(),
});
type UpsertMappingBody = z.infer<typeof UpsertMappingBody>;

/** §7 eşleme silme gövdesi. */
const DeleteMappingBody = z.object({
  remoteProductId: z.string().min(1).max(64),
  remoteVariationId: z.string().max(64).optional(),
});
type DeleteMappingBody = z.infer<typeof DeleteMappingBody>;

/**
 * Site-facing ürün-eşleme uçları (§7 "Ürün ekranına eşleme kutusu"). HMAC imzalı; WP eklentisi
 * ürün-düzenleme ekranından çağırır. TÜM işlemler ÇAĞIRAN SİTEYE scope'lu (CurrentSite.id) →
 * bir site yalnız KENDİ eşlemelerini görür/değiştirir. Katalog listesi sır içermez (fiyat/lisans YOK).
 */
@Controller('site-mappings')
@UseGuards(HmacGuard)
export class SiteMappingsController {
  constructor(private readonly products: ProductsService) {}

  /** Eşleme kutusu ürün seçici — hafif panel ürün kataloğu (ad/sku/tip; sır yok). */
  @Get('products')
  catalog() {
    return this.products.listForCatalog();
  }

  /** Bu sitenin eşlemeleri (opsiyonel ?remoteProductId= ile tek Woo ürünü). */
  @Get()
  list(@CurrentSite() site: Site, @Query('remoteProductId') remoteProductId?: string) {
    return this.products.listSiteMappings(site.id, remoteProductId || undefined);
  }

  /** Eşleme oluştur/güncelle (upsert) — bu site için. */
  @Post()
  upsert(@CurrentSite() site: Site, @Body(new ZodBody(UpsertMappingBody)) body: UpsertMappingBody) {
    return this.products.upsertSiteMapping({
      siteId: site.id,
      productId: body.productId,
      remoteProductId: body.remoteProductId,
      remoteVariationId: body.remoteVariationId,
      bundleQty: body.bundleQty,
    });
  }

  /** Eşlemeyi kaldır — bu site için (remoteProductId + varyasyon). */
  @Post('delete')
  @HttpCode(200)
  remove(@CurrentSite() site: Site, @Body(new ZodBody(DeleteMappingBody)) body: DeleteMappingBody) {
    return this.products.deleteSiteMapping(site.id, body.remoteProductId, body.remoteVariationId);
  }
}
