import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { GUIDE_BODY_MAX } from '@lisans/shared';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { isUniqueViolation } from '../db/pg-error';
import { productGuides } from '../db/schema/productGuides';

/**
 * Rehber listesi satırı — `/guides` ekranı bunu çizer.
 *
 * `productCount` ANLIK türetilir (products tablosundan), rehber kaydında TUTULMAZ: aksi
 * halde her ürün düzenlemesinde senkron tutulması gereken ikinci bir doğruluk kaynağı
 * doğardı (bu panelde "iki tanım, tek ekran" hatalarının kaynağı tam olarak budur).
 */
export interface ProductGuideRow {
  id: string;
  title: string;
  body: string;
  /** Bu rehbere bağlı ürün sayısı — silmeden önce etkiyi göstermek için de kullanılır. */
  productCount: number;
  /** Rehberi kullanan ürünlerin adları (ilk birkaçı; listede ipucu olarak gösterilir). */
  productNames: string[];
  updatedAt: string;
}

@Injectable()
export class ProductGuidesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Rehber listesi + bağlı ürün sayaçları.
   *
   * Sıra: önce HİÇ ÜRÜNE bağlı olmayanlar (operatörün gözden kaçırdığı taslaklar üstte
   * dursun — yazılıp ürüne bağlanmamış rehber müşteriye HİÇ ulaşmaz ve bu sessiz bir
   * kayıptır), sonra başlığa göre. Eşitlikte id → deterministik (aynı veri hep aynı sırada).
   */
  async list(): Promise<ProductGuideRow[]> {
    const rows = await rawRows<{
      id: string;
      title: string;
      body: string;
      product_count: number;
      product_names: string[] | null;
      updated_at: string;
    }>(
      this.db,
      sql`
        SELECT
          g.id,
          g.title,
          g.body,
          COALESCE(u.product_count, 0)::int AS product_count,
          u.product_names AS product_names,
          g.updated_at
        FROM product_guides g
        LEFT JOIN LATERAL (
          -- LATERAL: rehber basina TEK gecis. Korele alt-sorgu yerine bu bicim, ad listesini
          -- ve sayaci ayni taramadan uretir (products_guide_idx uzerinden).
          SELECT COUNT(*)::int AS product_count,
                 (ARRAY_AGG(p.name ORDER BY p.name))[1:5] AS product_names
          FROM products p
          WHERE p.guide_id = g.id
        ) u ON TRUE
        ORDER BY (COALESCE(u.product_count, 0) = 0) DESC, g.title ASC, g.id ASC
      `,
    );

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      productCount: Number(r.product_count),
      productNames: r.product_names ?? [],
      updatedAt: new Date(r.updated_at).toISOString(),
    }));
  }

  async create(input: { title: string; body: string }) {
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title) throw new ConflictException('Rehber başlığı boş olamaz');
    if (!body) throw new ConflictException('Rehber metni boş olamaz');
    this.assertLength(body);
    try {
      const [row] = await this.db.insert(productGuides).values({ title, body }).returning();
      return row;
    } catch (e) {
      // 23505 = unique_violation (product_guides_title_lower_idx, Türkçe-duyarlı)
      if (isUniqueViolation(e)) {
        throw new ConflictException(`"${title}" başlıklı bir rehber zaten var`);
      }
      throw e;
    }
  }

  /**
   * Başlık/metin güncelle.
   *
   * Bağlı ÜRÜNLERE DOKUNULMAZ (bağ id üzerinden) → bir adımı düzeltmek, o rehberi kullanan
   * tüm ürünlerde anında geçerli olur. Bu tablonun var olma sebebi tam olarak budur.
   */
  async update(id: string, input: { title?: string; body?: string }) {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) {
      const title = input.title.trim();
      if (!title) throw new ConflictException('Rehber başlığı boş olamaz');
      patch.title = title;
    }
    if (input.body !== undefined) {
      const body = input.body.trim();
      if (!body) throw new ConflictException('Rehber metni boş olamaz');
      this.assertLength(body);
      patch.body = body;
    }

    try {
      const [row] = await this.db
        .update(productGuides)
        .set(patch)
        .where(eq(productGuides.id, id))
        .returning();
      if (!row) throw new NotFoundException('Rehber bulunamadı');
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('Bu başlıkta bir rehber zaten var');
      }
      throw e;
    }
  }

  /**
   * Rehberi sil. ÜRÜN SİLİNMEZ — FK `ON DELETE SET NULL` ile ürünler rehbersiz kalır.
   * Kaç ürünün etkilendiği yanıtta döner ki UI dürüst bir onay/sonuç mesajı yazabilsin
   * ("3 ürün artık kurulum rehberi göstermeyecek") — sessiz yan etki bırakılmaz.
   */
  async remove(id: string): Promise<{ id: string; affectedProducts: number }> {
    const [{ count } = { count: 0 }] = await rawRows<{ count: number }>(
      this.db,
      sql`SELECT COUNT(*)::int AS count FROM products WHERE guide_id = ${id}`,
    );
    const [row] = await this.db
      .delete(productGuides)
      .where(eq(productGuides.id, id))
      .returning({ id: productGuides.id });
    if (!row) throw new NotFoundException('Rehber bulunamadı');
    return { id: row.id, affectedProducts: Number(count) };
  }

  /**
   * Uzunluk tavanı SERVİSTE de denetlenir (controller'daki Zod'a EK olarak).
   *
   * Sebep: tavan bir görünüm tercihi değil, e-posta istemcisinin kırpma eşiğinden geriye
   * doğru hesaplanmış bir TESLİMAT güvencesidir (bkz. GUIDE_BODY_MAX). Yalnız gövde
   * doğrulamasına bırakılırsa, ileride servisi doğrudan çağıran bir yol (içe aktarma,
   * kopyalama) sınırı sessizce atlar ve müşteri KIRPILMIŞ bir rehber alır.
   */
  private assertLength(body: string): void {
    if (body.length > GUIDE_BODY_MAX) {
      throw new ConflictException(
        `Rehber metni en fazla ${GUIDE_BODY_MAX} karakter olabilir (şu an ${body.length}). ` +
          'Uzun metin e-posta istemcilerinde kırpılır — adımları sadeleştirin veya ikinci bir rehbere bölün.',
      );
    }
  }
}
