import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { licenseItems, type NewLicenseItem } from '../db/schema';
import { ProductsService } from '../products/products.service';

export interface ImportResult {
  requested: number;
  imported: number;
  duplicates: number;
}

@Injectable()
export class StockService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly products: ProductsService,
  ) {}

  /**
   * Stok import (§12). Her payload şifrelenir (envelope), içerik hash'iyle mükerrer
   * engellenir (UNIQUE payload_hash → onConflictDoNothing). Çok kullanımlıkta (multi)
   * her key ürünün max_uses kapasitesiyle girer.
   */
  async import(
    productId: string,
    items: Array<{ payload: string; expiresAt?: string }>,
  ): Promise<ImportResult> {
    const product = await this.products.getById(productId);
    const maxUses = product.usageMode === 'multi' ? (product.maxUses ?? 1) : 1;

    const values: NewLicenseItem[] = items.map((it) => ({
      productId,
      payloadEnc: this.crypto.encrypt(it.payload),
      payloadHash: CryptoService.payloadHash(it.payload),
      payloadSuffixHash: CryptoService.payloadSuffixHash(it.payload),
      maxUses,
      expiresAt: it.expiresAt ? new Date(it.expiresAt) : null,
      status: 'available',
    }));

    if (values.length === 0) return { requested: 0, imported: 0, duplicates: 0 };

    const inserted = await this.db
      .insert(licenseItems)
      .values(values)
      .onConflictDoNothing({ target: licenseItems.payloadHash })
      .returning({ id: licenseItems.id });

    return {
      requested: items.length,
      imported: inserted.length,
      duplicates: items.length - inserted.length,
    };
  }

  /** Ürün başına anlık 'available' stok (single: satır sayısı; multi: kalan kapasite). */
  async availableCount(productId: string): Promise<number> {
    const [row] = await this.db
      .select({
        count: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(licenseItems)
      .where(and(eq(licenseItems.productId, productId), eq(licenseItems.status, 'available')));
    return Number(row?.count ?? 0);
  }
}
