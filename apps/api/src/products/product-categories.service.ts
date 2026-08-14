import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { productCategories } from '../db/schema/productCategories';

/**
 * Kategori kartı satırı — `/stock` giriş ekranı bunu çizer.
 *
 * Sayaçlar ANLIK türetilir (ürün/stok tablosundan), kategori kaydında TUTULMAZ: aksi halde
 * her stok girişinde/silmede senkron tutulması gereken ikinci bir doğruluk kaynağı doğardı
 * (bu panelde "iki tanım, tek ekran" hatalarının kaynağı tam olarak budur).
 */
export interface ProductCategoryRow {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
  productCount: number;
  /** Kategorideki ürünlerin ATANABİLİR stok toplamı (kapasite; MAK'ta kalan kullanım hakkı). */
  availableStock: number;
  /** Düşük stok eşiğinin altına düşmüş ürün sayısı (eşik tanımlı olanlar arasında). */
  lowStockCount: number;
}

/** Kategorisi olmayan ürünler için sanal kova — gerçek bir kategori kaydı DEĞİLDİR. */
export const UNCATEGORIZED_ID = 'none';

@Injectable()
export class ProductCategoriesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Kategori listesi + ürün/stok sayaçları. "Kategorisiz" kovası da (ürünü varsa) döner:
   * kategori atanmamış ürünler ekrandan KAYBOLMAMALI — operatör onları göremezse yeni ürün
   * eklediğini sanıp ikizini yaratır.
   *
   * `availableStock` KAPASİTEDİR (Σ max_uses - use_count), satır sayısı değil: MAK ürününde
   * 1 anahtar 500 kullanım taşır; satır saymak "1 stok" gösterip yanlış alarm üretirdi
   * (panelde daha önce yaşanmış sınıf — günlük özet sayacı aynı sebeple düzeltilmişti).
   * Süresi geçmiş kalem atanamaz → `notExpired` yüklemi atama sorgusuyla aynı.
   */
  async list(): Promise<ProductCategoryRow[]> {
    const rows = await rawRows<{
      id: string | null;
      name: string | null;
      description: string | null;
      sort_order: number | null;
      product_count: number;
      available_stock: number;
      low_stock_count: number;
    }>(
      this.db,
      sql`
        WITH stock AS (
          SELECT
            p.id AS product_id,
            p.category_id AS category_id,
            p.low_stock_threshold AS threshold,
            -- KAPASİTE (satır sayısı DEĞİL): tek kullanımlıkta max_uses=1 → 1; MAK'ta kalan
            -- kullanım hakkı. products.service ile BİREBİR aynı formül (iki tanım olmasın).
            COALESCE(SUM(GREATEST(li.max_uses - li.use_count, 0)), 0)::int AS available
          FROM products p
          LEFT JOIN license_items li
            ON li.product_id = p.id
           AND li.status = 'available'
           -- Süresi geçmiş kalem ATANAMAZ → sayımdan da düşer (assign.ts notExpiredCond ile aynı).
           AND (li.expires_at IS NULL OR li.expires_at > now())
          GROUP BY p.id, p.category_id, p.low_stock_threshold
        )
        SELECT
          c.id AS id,
          c.name AS name,
          c.description AS description,
          c.sort_order AS sort_order,
          COUNT(s.product_id)::int AS product_count,
          COALESCE(SUM(s.available), 0)::int AS available_stock,
          COUNT(*) FILTER (WHERE s.threshold IS NOT NULL AND s.available <= s.threshold)::int
            AS low_stock_count
        FROM product_categories c
        LEFT JOIN stock s ON s.category_id = c.id
        GROUP BY c.id, c.name, c.description, c.sort_order

        UNION ALL

        -- "Kategorisiz" kovası: yalnız gerçekten ürünü varsa satır üretir (boşsa kart çizilmez).
        SELECT
          NULL AS id, NULL AS name, NULL AS description, NULL AS sort_order,
          COUNT(*)::int AS product_count,
          COALESCE(SUM(s.available), 0)::int AS available_stock,
          COUNT(*) FILTER (WHERE s.threshold IS NOT NULL AND s.available <= s.threshold)::int
            AS low_stock_count
        FROM stock s
        WHERE s.category_id IS NULL
        HAVING COUNT(*) > 0

        ORDER BY sort_order NULLS LAST, name NULLS LAST
      `,
    );

    return rows.map((r) => ({
      id: r.id ?? UNCATEGORIZED_ID,
      name: r.name ?? 'Kategorisiz',
      description: r.description,
      sortOrder: Number(r.sort_order ?? 9999),
      productCount: Number(r.product_count),
      availableStock: Number(r.available_stock),
      lowStockCount: Number(r.low_stock_count),
    }));
  }

  /** Yeni kategori. Ad çakışması (büyük/küçük harf duyarsız) 409 döner — ikiz kategori olmaz. */
  async create(input: { name: string; description?: string | null; sortOrder?: number }) {
    const name = input.name.trim();
    if (!name) throw new ConflictException('Kategori adı boş olamaz');
    try {
      const [row] = await this.db
        .insert(productCategories)
        .values({
          name,
          description: input.description?.trim() || null,
          sortOrder: input.sortOrder ?? 0,
        })
        .returning();
      return row;
    } catch (e) {
      // 23505 = unique_violation (product_categories_name_lower_idx)
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException(`"${name}" kategorisi zaten var`);
      }
      throw e;
    }
  }

  /** Ad/açıklama/sıra güncelle. Ad değişince ürünlere DOKUNULMAZ (FK id üzerinden). */
  async update(
    id: string,
    input: { name?: string; description?: string | null; sortOrder?: number },
  ) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new ConflictException('Kategori adı boş olamaz');
      patch.name = name;
    }
    if (input.description !== undefined) patch.description = input.description?.trim() || null;
    if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

    try {
      const [row] = await this.db
        .update(productCategories)
        .set(patch)
        .where(eq(productCategories.id, id))
        .returning();
      if (!row) throw new NotFoundException('Kategori bulunamadı');
      return row;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        throw new ConflictException('Bu adda bir kategori zaten var');
      }
      throw e;
    }
  }

  /**
   * Kategoriyi sil. ÜRÜN SİLİNMEZ — FK `ON DELETE SET NULL` ile ürünler "Kategorisiz" olur.
   * Kaç ürünün etkilendiği yanıtta döner ki UI dürüst bir sonuç mesajı yazabilsin.
   */
  async remove(id: string): Promise<{ id: string; uncategorizedProducts: number }> {
    const [{ count } = { count: 0 }] = await rawRows<{ count: number }>(
      this.db,
      sql`SELECT COUNT(*)::int AS count FROM products WHERE category_id = ${id}`,
    );
    const [row] = await this.db
      .delete(productCategories)
      .where(eq(productCategories.id, id))
      .returning({ id: productCategories.id });
    if (!row) throw new NotFoundException('Kategori bulunamadı');
    return { id: row.id, uncategorizedProducts: Number(count) };
  }
}
