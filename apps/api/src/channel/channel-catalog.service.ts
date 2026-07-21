import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { licenseItems, products, siteProductMappings } from '../db/schema';

/**
 * Reseller/marketplace katalog kalemi (§10) — SALT-OKUNUR.
 * FİYAT/GELİR YOK: panel ödemeye dokunmaz, satış fiyatı panelde tutulmaz.
 * availableStock = kalan kapasite (Σ max_uses−use_count, products.list ile AYNI semantik);
 * inStock = availableStock > 0.
 */
export interface ChannelCatalogItem {
  /** Eşleme kaydı (site_product_mappings.id) — reseller kendi remote id'siyle eşler. */
  mappingId: string;
  productId: string;
  sku: string;
  name: string;
  kind: string;
  usageMode: string;
  /** Site tarafındaki remote ürün/varyasyon kimlikleri. */
  remoteProductId: string;
  remoteVariationId: string | null;
  /** 1 Woo adedi = N key. */
  bundleQty: number;
  /** Anlık kalan stok kapasitesi (FİYAT DEĞİL). */
  availableStock: number;
  inStock: boolean;
}

/**
 * Reseller/marketplace kanalı için salt-okunur katalog+stok servisi (§10).
 * Yalnız mevcut tabloları okur (site_product_mappings, products, license_items);
 * yazma/yan etki YOK, migration YOK. FİYAT/gelir hiçbir zaman dönmez.
 */
@Injectable()
export class ChannelCatalogService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Verilen siteye AKTİF eşlenmiş ürünlerin katalog+stok görünümü. Her satır bir eşleme
   * kaydıdır (reseller birden çok remote ürünü aynı panel ürününe eşleyebilir). availableStock,
   * products.list agregasyonunu birebir aynalar: status='available' license_items üzerinden
   * (max_uses − use_count) toplamı; partial index (license_items_available_idx) kullanılır.
   * LEFT JOIN korunur → stoksuz eşleme de availableStock=0 / inStock=false ile listede kalır.
   */
  async catalogForSite(siteId: string): Promise<ChannelCatalogItem[]> {
    const rows = await this.db
      .select({
        mappingId: siteProductMappings.id,
        productId: products.id,
        sku: products.sku,
        name: products.name,
        kind: products.kind,
        usageMode: products.usageMode,
        remoteProductId: siteProductMappings.remoteProductId,
        remoteVariationId: siteProductMappings.remoteVariationId,
        bundleQty: siteProductMappings.bundleQty,
        // Kalan kapasite: single'da satır sayısı, multi'de (max_uses − use_count) toplamı.
        availableStock: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(siteProductMappings)
      .innerJoin(products, eq(products.id, siteProductMappings.productId))
      .leftJoin(
        licenseItems,
        and(eq(licenseItems.productId, products.id), eq(licenseItems.status, 'available')),
      )
      .where(and(eq(siteProductMappings.siteId, siteId), eq(siteProductMappings.active, true)))
      // Mapping + ürün PK'larıyla grupla — diğer kolonlar bu PK'lara fonksiyonel bağımlı.
      .groupBy(siteProductMappings.id, products.id)
      .orderBy(asc(products.name));

    return rows.map((r) => {
      const availableStock = Number(r.availableStock);
      return {
        mappingId: r.mappingId,
        productId: r.productId,
        sku: r.sku,
        name: r.name,
        kind: r.kind,
        usageMode: r.usageMode,
        remoteProductId: r.remoteProductId,
        remoteVariationId: r.remoteVariationId,
        bundleQty: Number(r.bundleQty),
        availableStock,
        inStock: availableStock > 0,
      };
    });
  }
}
