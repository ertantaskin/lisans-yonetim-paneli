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

/** §3 katalog senkron gövdesi (site-scoped) — WP mağaza ürün listesinin tam snapshot'ı. SIR YOK. */
const SyncCatalogBody = z.object({
  products: z
    .array(
      z.object({
        remoteProductId: z.string().min(1).max(64),
        remoteVariationId: z.string().max(64).nullish(),
        name: z.string().min(1).max(500),
        sku: z.string().max(120).nullish(),
        kind: z.string().max(40).nullish(),
      }),
    )
    .max(5000),
});
type SyncCatalogBody = z.infer<typeof SyncCatalogBody>;

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

  /**
   * Mağaza ürün kataloğu senkronu (§3) — bu site için TAM snapshot (delete+insert). WP eklentisi
   * "Ürünleri Panele Aktar" + ürün kaydında çağırır → panelde proaktif eşleme mümkün olur. SIR YOK.
   */
  @Post('catalog')
  @HttpCode(200)
  syncCatalog(@CurrentSite() site: Site, @Body(new ZodBody(SyncCatalogBody)) body: SyncCatalogBody) {
    return this.products.syncCatalog(site.id, body.products);
  }
}
