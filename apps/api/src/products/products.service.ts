import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import {
  products,
  siteProductMappings,
  licenseItems,
  type NewProduct,
  type Product,
} from '../db/schema';

@Injectable()
export class ProductsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(input: NewProduct): Promise<Product> {
    const [row] = await this.db.insert(products).values(input).returning();
    return row!;
  }

  async list(): Promise<Array<Product & { availableStock: number }>> {
    // Ürün başına anlık 'available' stok sayısı (partial index üzerinden).
    const rows = await this.db
      .select({
        product: products,
        // Kalan kapasite: single'da satır sayısı, multi'de (max_uses - use_count) toplamı.
        availableStock: sql<number>`coalesce(sum(case when ${licenseItems.status} = 'available' then ${licenseItems.maxUses} - ${licenseItems.useCount} else 0 end), 0)`,
      })
      .from(products)
      .leftJoin(licenseItems, eq(licenseItems.productId, products.id))
      .groupBy(products.id);

    return rows.map((r) => ({ ...r.product, availableStock: Number(r.availableStock) }));
  }

  async getById(id: string): Promise<Product> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!row) throw new NotFoundException('Ürün bulunamadı');
    return row;
  }

  /** Site-facing sipariş akışı için: remote ürün → panel ürünü çöz (§2 mapping_not_found). */
  async resolveMapping(
    siteId: string,
    remoteProductId: string,
    remoteVariationId?: string | null,
  ): Promise<{ productId: string; bundleQty: number } | null> {
    // '0'/boş varyasyon = varyasyon yok (Woo bazen '0' gönderir).
    const variation = remoteVariationId && remoteVariationId !== '0' ? remoteVariationId : null;

    // 1) Varyasyon-özel eşleme (varsa) — en spesifik.
    if (variation) {
      const [row] = await this.db
        .select()
        .from(siteProductMappings)
        .where(
          and(
            eq(siteProductMappings.siteId, siteId),
            eq(siteProductMappings.remoteProductId, remoteProductId),
            eq(siteProductMappings.remoteVariationId, variation),
            eq(siteProductMappings.active, true),
          ),
        )
        .orderBy(asc(siteProductMappings.createdAt))
        .limit(1);
      if (row) return { productId: row.productId, bundleQty: row.bundleQty };
    }

    // 2) Ürün-seviyesi (varyasyon null) eşleme — fallback, deterministik (en eski).
    const [row] = await this.db
      .select()
      .from(siteProductMappings)
      .where(
        and(
          eq(siteProductMappings.siteId, siteId),
          eq(siteProductMappings.remoteProductId, remoteProductId),
          isNull(siteProductMappings.remoteVariationId),
          eq(siteProductMappings.active, true),
        ),
      )
      .orderBy(asc(siteProductMappings.createdAt))
      .limit(1);

    return row ? { productId: row.productId, bundleQty: row.bundleQty } : null;
  }

  async createMapping(input: {
    siteId: string;
    productId: string;
    remoteProductId: string;
    remoteVariationId?: string;
    bundleQty?: number;
  }) {
    const [row] = await this.db
      .insert(siteProductMappings)
      .values({
        siteId: input.siteId,
        productId: input.productId,
        remoteProductId: input.remoteProductId,
        remoteVariationId: input.remoteVariationId ?? null,
        bundleQty: input.bundleQty ?? 1,
      })
      .returning();
    return row!;
  }
}
