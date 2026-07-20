import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
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
        availableStock: sql<number>`count(${licenseItems.id}) filter (where ${licenseItems.status} = 'available')`,
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
    const [row] = await this.db
      .select()
      .from(siteProductMappings)
      .where(
        and(
          eq(siteProductMappings.siteId, siteId),
          eq(siteProductMappings.remoteProductId, remoteProductId),
          remoteVariationId
            ? eq(siteProductMappings.remoteVariationId, remoteVariationId)
            : sql`${siteProductMappings.remoteVariationId} is null`,
          eq(siteProductMappings.active, true),
        ),
      )
      .limit(1);

    if (!row) return null;
    return { productId: row.productId, bundleQty: row.bundleQty };
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
