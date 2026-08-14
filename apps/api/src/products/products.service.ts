import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { notExpiredCond } from '../assignment/assign';
import {
  products,
  siteProductMappings,
  siteRemoteProducts,
  sites,
  licenseItems,
  type NewProduct,
  type Product,
} from '../db/schema';

/** Ürün detay sayfası (§13) — salt-okunur agregasyon, mevcut tablolardan türetilir. */
export interface ProductDetail {
  product: Product;
  /**
   * license_items status kırılımı. available = SATILABİLİR kalan kapasite
   * (Σ max_uses−use_count, yalnız süresi GEÇMEMİŞ kalemler), diğerleri satır sayısı.
   */
  stock: {
    available: number;
    assigned: number;
    revoked: number;
    expired: number;
    voided: number;
    /**
     * status='available' AMA stok ömrü (expires_at) dolmuş → ATANAMAZ kapasite.
     * `available` toplamından HARİÇtir; sessizce kaybolmasın diye ayrı raporlanır
     * (operatör "stok neden düştü?" sorusunun cevabını panelde görür).
     */
    expiredAvailable: number;
  };
  batches: Array<{
    id: string;
    label: string;
    status: string;
    qtyReceived: number;
    /** Teslim alma tarihi — parti seçicide (stok import) etiketle birlikte gösterilir. */
    receivedAt: string;
    /** Partiyi getiren tedarikçi (elle girilen partide null). */
    supplierId: string | null;
    supplierName: string | null;
  }>;
  purchaseOrders: Array<{
    id: string;
    status: string;
    qtyOrdered: number;
    qtyReceived: number;
    eta: string | null;
    /**
     * Emri verdiğimiz tedarikçi — "stok bitiyor, kimi arayacağım?" sorusunun cevabı
     * ekranda olsun diye JOIN ile getirilir (operatör başka ekrana gitmesin).
     */
    supplierId: string;
    supplierName: string;
  }>;
  velocity: {
    sold7d: number;
    sold30d: number;
    /** sold30d / 30. */
    dailyRate: number;
    /** available / dailyRate (yuvarlanmış); dailyRate=0 ise null. */
    daysRemaining: number | null;
  };
  adjustments: Array<{
    id: string;
    action: string;
    qty: number;
    reason: string;
    /** Düzeltmeyi yapan operatör (çok-operatörlü panelde "bunu kim yaptı?" ekrandan yanıtlanır). */
    actor: string;
    /**
     * Düzeltmenin dokunduğu lisans kalemi (varsa). null ⇒ düzeltme YALNIZ deftere yazıldı,
     * satılabilir stok DEĞİŞMEDİ — ekran bunu dürüstçe ayırt edebilsin diye döndürülür.
     */
    licenseItemId: string | null;
    createdAt: string;
  }>;
  /** Bu ürünün site eşlemeleri (§3) — ürün-merkezli yönetim: eşleme artık ürün detayında. */
  mappings: Array<{
    id: string;
    siteId: string;
    siteDomain: string;
    productId: string;
    productName: string;
    remoteProductId: string;
    remoteVariationId: string | null;
    /** Katalogdan öğrenilen mağaza ürün adı (varsa) — ham ID yerine operatör dostu; yoksa null. */
    remoteName: string | null;
    bundleQty: number;
    active: boolean;
    createdAt: string;
  }>;
}

/**
 * Bir (usage_mode, max_uses) çiftinin ANAHTAR BAŞINA kapasitesi.
 * single → her zaman 1 (max_uses kavramı yoktur); multi → max_uses (yoksa 1).
 */
function capacityOf(usageMode: Product['usageMode'], maxUses: number | null | undefined): number {
  if (usageMode !== 'multi') return 1;
  const n = maxUses ?? 1;
  return n > 0 ? n : 1;
}

/** `productCapacityChange` sonucu — güncellemenin kapasiteye etkisi. */
export interface CapacityChange {
  currentCapacity: number;
  nextCapacity: number;
  /**
   * true → yeni kapasite mevcudun ALTINDA (multi→single dahil). YALNIZ bu durumda stok
   * denetimi yapılır; kapasite ARTIŞI ve kapasiteye dokunmayan düzenlemeler serbesttir.
   */
  reduced: boolean;
}

/**
 * Ürün güncellemesinin ANAHTAR KAPASİTESİNE etkisini hesaplar (saf fonksiyon — birim testli).
 *
 * NEDEN yalnız DÜŞÜŞ önemli (denetim/re-doğrulama dersi): `license_items.max_uses` import
 * anında ürün kapasitesinden kopyalanan bir ANLIK GÖRÜNTÜdür; ürün satırını güncellemek
 * mevcut kalemlerin kapasitesini değiştirmez. Bu yüzden:
 *  · kapasite ARTIRMA (MAK 500 → 800) mevcut anahtarları BOZMAZ — yeni importlar daha
 *    büyük kapasiteyle gelir, eskiler aynen 500 kalır → serbest olmalıdır,
 *  · `usage_mode` değişmeden yapılan düzenlemeler (ad/eşik/politika) kapasiteye dokunmaz,
 *  · single → multi de kapasiteyi ARTIRIR (1 → N) → serbesttir,
 *  · ama kapasite DÜŞÜRME ve multi → single, stokta duran yüksek kapasiteli anahtarların
 *    kalan kullanım hakkını temsil edilemez hale getirir (allocate() single dalına düşer ve
 *    anahtarın TAMAMINI tek birim sayar → anahtar başına N−1 kullanım KALICI kaybolur).
 */
export function productCapacityChange(
  current: Pick<Product, 'usageMode' | 'maxUses'>,
  patch: Pick<Partial<NewProduct>, 'usageMode' | 'maxUses'>,
): CapacityChange {
  const nextUsageMode = patch.usageMode ?? current.usageMode;
  // patch'te ANAHTAR YOK → kolon değişmez; anahtar VAR ama null → temizlenir.
  const nextMaxUses = patch.maxUses === undefined ? (current.maxUses ?? null) : (patch.maxUses ?? null);

  const currentCapacity = capacityOf(current.usageMode, current.maxUses);
  const nextCapacity = capacityOf(nextUsageMode, nextMaxUses);
  return { currentCapacity, nextCapacity, reduced: nextCapacity < currentCapacity };
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  async create(input: NewProduct): Promise<Product> {
    const [row] = await this.db.insert(products).values(input).returning();
    return row!;
  }

  /**
   * Kısmi ürün güncellemesi (§11). Yalnız verilen alanlar değişir; updatedAt her
   * güncellemede now() olur. Boş patch (hiç alan yok) reddedilir — yanlışlıkla
   * yalnız updatedAt dokunmasını engeller. Ürün yoksa 404.
   * Null semantiği: patch'te ANAHTAR YOK → kolon değişmez; anahtar VAR ama değer null
   * → kolon TEMİZLENİR (Drizzle .set() null'ı SET col = null'a çevirir) → opsiyonel
   * alan (validityDays/warrantyDays/lowStockThreshold/keyFormat/releaseAt) boşaltılabilir.
   */
  async update(id: string, patch: Partial<NewProduct>): Promise<Product> {
    if (Object.keys(patch).length === 0) {
      throw new NotFoundException('Güncellenecek alan yok');
    }
    return this.db.transaction(async (tx) => {
      // Mevcut ürünü KİLİTLE: karar (mod/kapasite değişiyor mu + canlı lisans var mı) ile
      // yazma arasında ikinci bir düzenleme araya giremesin.
      const [current] = await tx
        .select()
        .from(products)
        .where(eq(products.id, id))
        .limit(1)
        .for('update');
      if (!current) throw new NotFoundException('Ürün bulunamadı');

      // ── Kapasite koruması (§2/§11, denetim bulgusu — DARALTILMIŞ) ──────────────────
      // usage_mode / max_uses, license_items satırlarının KAPASİTE anlamını belirler:
      //  · single → allocate() anahtarın TAMAMINI 'assigned' yapar (kapasite = 1),
      //  · multi  → use_count += units (kalan kapasite = max_uses − use_count).
      //
      // Guard YALNIZ gerçekten veri bozan geçişte devreye girer: kapasite DÜŞÜREN değişiklik
      // (MAK 500 → 100) ve multi → single. Bu iki durumda stokta duran YÜKSEK kapasiteli
      // anahtarların kalan kullanım hakkı temsil edilemez hale gelir (anahtar başına N−1
      // kullanım KALICI kaybolur, panel ise license_items.max_uses'ten hesapladığı için bir
      // süre ŞİŞİK stok gösterir). Kapasite ARTIRMA (500 → 800), single → multi ve
      // usage_mode'a dokunmayan düzenlemeler MEŞRUDUR ve engellenmez — `license_items.max_uses`
      // import anında yazılan bir anlık görüntüdür; ürünü güncellemek eski kalemleri değiştirmez.
      const change = productCapacityChange(current, patch);

      if (change.reduced) {
        // Yalnız KAPASİTESİ KAYBOLACAK canlı kalemler sayılır:
        //  · ölü satırlar (voided/revoked/replaced/quarantined/expired) atamaya girmez,
        //  · tükenmiş (use_count >= max_uses) kalemde kaybedilecek kapasite YOKTUR,
        //  · yeni kapasiteye SIĞAN kalemler (max_uses <= nextCapacity) etkilenmez.
        // → ürünü sonsuza dek kilitlemeyiz; yalnız gerçek veri kaybı reddedilir.
        const [row] = await rawRows<{ n: number; max_cap: number }>(tx, sql`
          SELECT count(*)::int AS n, coalesce(max(max_uses), 0)::int AS max_cap
          FROM license_items
          WHERE product_id = ${id}
            AND status IN ('available', 'assigned', 'suspended')
            AND max_uses > ${change.nextCapacity}
            AND use_count < max_uses;
        `);
        const live = Number(row?.n ?? 0);
        if (live > 0) {
          const maxCap = Number(row?.max_cap ?? 0);
          throw new ConflictException(
            `Stokta kapasitesi ${change.nextCapacity} üstünde olan ${live} canlı lisans kaydı var ` +
              `(en yükseği ${maxCap} kullanım); kapasiteyi ${change.currentCapacity} → ` +
              `${change.nextCapacity} düşürmek bu anahtarların kalan kullanım hakkını yok eder. ` +
              'Kapasiteyi ARTIRMAK serbesttir. Düşürmek için: önce bu kalemleri tüketin ya da ' +
              'Envanter ekranından iptal edin; alternatif olarak yeni kapasiteyle YENİ bir ürün ' +
              'açıp site eşlemesini ona taşıyın.',
          );
        }
      }

      // Tek kullanımlığa geçirilen üründe `max_uses` kavramı YOKTUR → bayat 500 değeri
      // kolonda bırakmayız (ileride mod tekrar 'multi' yapılırsa sessizce eski kapasiteyi
      // diriltir). Yalnız operatör bu modu AÇIKÇA gönderdiğinde uygulanır; kapasitesi
      // kaybolacak canlı kalem varsa zaten yukarıdaki 409'a takılmıştır. Kapasite modeliyle
      // TUTARLI: capacityOf(single, *) = 1, yani bu temizlik kapasiteyi değiştirmez.
      const set: Partial<NewProduct> =
        patch.usageMode === 'single' ? { ...patch, maxUses: null } : { ...patch };

      const [row] = await tx
        .update(products)
        .set({ ...set, updatedAt: new Date() })
        .where(eq(products.id, id))
        .returning();
      if (!row) throw new NotFoundException('Ürün bulunamadı');
      return row;
    });
  }

  async list(): Promise<
    Array<
      Product & {
        availableStock: number;
        mappedSites: string[];
        mappingCount: number;
        categoryName: string | null;
      }
    >
  > {
    // Ürün başına anlık 'available' stok sayısı — tek GROUP BY agregasyonu.
    // status='available' filtresi JOIN ON'a alındı: yalnız uygun satırlar okunur,
    // partial index (license_items_available_idx: product_id,created_at WHERE
    // status='available') kullanılır; assigned/revoked/expired satırlar taranmaz.
    // LEFT JOIN korunur → stoksuz ürün de NULL→coalesce 0 ile listede kalır.
    //
    // notExpiredCond(): stok ömrü dolmuş kalemler ATANAMAZ (assign.ts aynı koşulu uygular);
    // toplamda sayılırlarsa panel var olmayan stok gösterir ve düşük-stok alarmı geç kalır.
    // Koşulun TEK KAYNAĞI assignment/assign.ts — kopya yok.
    const rows = await this.db
      .select({
        product: products,
        // Kalan kapasite: single'da satır sayısı, multi'de (max_uses - use_count) toplamı.
        availableStock: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(products)
      .leftJoin(
        licenseItems,
        and(
          eq(licenseItems.productId, products.id),
          eq(licenseItems.status, 'available'),
          notExpiredCond('license_items'),
        ),
      )
      .groupBy(products.id);

    // Ürün başına AKTİF eşleme özeti (§3) — "bu ürün hangi mağazalarda satılıyor?".
    // AYRI sorgu (JOIN DEĞİL) bilinçli: yukarıdaki sorgu license_items üzerinden SUM
    // agregasyonu yapıyor; eşleme tablosunu aynı JOIN'e katmak satırları çoğaltıp
    // availableStock'u ŞİŞİRİRDİ (ürün başına eşleme sayısı kadar). İki sorgu → N+1 değil.
    const mapRows = await rawRows<{ product_id: string; domains: string[] | null; cnt: number }>(
      this.db,
      sql`
        SELECT m.product_id,
               array_agg(DISTINCT s.domain) AS domains,
               count(*)::int AS cnt
        FROM site_product_mappings m
        JOIN sites s ON s.id = m.site_id
        WHERE m.active = true
        GROUP BY m.product_id;
      `,
    );
    const byProduct = new Map(mapRows.map((r) => [r.product_id, r]));

    // Kategori ADI ayrı sorguda çözülür (JOIN DEĞİL): yukarıdaki sorgu SUM agregasyonu
    // yapıyor, ikinci bir tabloyu aynı JOIN'e katmak satır çoğaltma riskini geri getirir.
    // Kategori sayısı ürün sayısından küçüktür → tek küçük sorgu, N+1 yok.
    const catRows = await rawRows<{ id: string; name: string }>(
      this.db,
      sql`SELECT id, name FROM product_categories`,
    );
    const catName = new Map(catRows.map((c) => [c.id, c.name]));

    return rows.map((r) => {
      const m = byProduct.get(r.product.id);
      return {
        ...r.product,
        // null = Kategorisiz (geçerli durum; ekran ayrı kovada gösterir, ürünü GİZLEMEZ).
        categoryName: r.product.categoryId ? (catName.get(r.product.categoryId) ?? null) : null,
        availableStock: Number(r.availableStock),
        // Eşlemesi olmayan ürün → boş dizi (null değil): ekran "eşleme yok" uyarısını
        // BİLGİYE dayanarak basar, alanın gelmemesiyle karıştırmaz.
        mappedSites: m?.domains ?? [],
        mappingCount: Number(m?.cnt ?? 0),
      };
    });
  }

  async getById(id: string): Promise<Product> {
    const [row] = await this.db.select().from(products).where(eq(products.id, id)).limit(1);
    if (!row) throw new NotFoundException('Ürün bulunamadı');
    return row;
  }

  /**
   * Ürün detay panosu (§13) — salt-okunur agregasyon. Ürünü getById ile çözer
   * (yoksa 404), ardından stok kırılımı / parti / satın-alma emri / satış hızı /
   * stok düzeltmelerini mevcut tablolardan (license_items, batches, purchase_orders,
   * assignments, stock_adjustments) toplar. Hiçbir yazma/yan etki yok.
   */
  async getDetail(id: string): Promise<ProductDetail> {
    const product = await this.getById(id);

    const [stock, batches, purchaseOrders, velocity, adjustments, mappings] = await Promise.all([
      this.detailStock(id),
      this.detailBatches(id),
      this.detailPurchaseOrders(id),
      this.detailVelocity(id),
      this.detailAdjustments(id),
      this.detailMappings(id),
    ]);

    // Tükenme tahmini: kalan available kapasitesini günlük satış hızına böl.
    const dailyRate = velocity.sold30d / 30;
    const daysRemaining =
      dailyRate > 0 ? Math.round(stock.available / dailyRate) : null;

    return {
      product,
      stock,
      batches,
      purchaseOrders,
      velocity: {
        sold7d: velocity.sold7d,
        sold30d: velocity.sold30d,
        // dailyRate sunum için 2 ondalığa; daysRemaining ham orandan hesaplandı.
        dailyRate: Math.round(dailyRate * 100) / 100,
        daysRemaining,
      },
      adjustments,
      mappings,
    };
  }

  /**
   * Bu ürüne bağlı site eşlemeleri (§3) — site domain + ürün adıyla zenginleştirilmiş,
   * tek ürüne daraltılmış (ürün-merkezli yönetim: eşleme oluşturma/aç-kapa ürün detayında).
   */
  private async detailMappings(id: string): Promise<ProductDetail['mappings']> {
    const rows = await this.db
      .select({
        id: siteProductMappings.id,
        siteId: siteProductMappings.siteId,
        siteDomain: sites.domain,
        productId: siteProductMappings.productId,
        productName: products.name,
        remoteProductId: siteProductMappings.remoteProductId,
        remoteVariationId: siteProductMappings.remoteVariationId,
        remoteName: siteRemoteProducts.name,
        bundleQty: siteProductMappings.bundleQty,
        active: siteProductMappings.active,
        createdAt: siteProductMappings.createdAt,
      })
      .from(siteProductMappings)
      .innerJoin(sites, eq(sites.id, siteProductMappings.siteId))
      .innerJoin(products, eq(products.id, siteProductMappings.productId))
      // Katalog snapshot'ından mağaza ürün adını öğren (varsa) — ham ID yerine ad göster.
      // (site, remote_product_id, varyasyon-eşit-VEYA-ikisi-de-null) ile tek satır eşleşir (unique index).
      .leftJoin(
        siteRemoteProducts,
        and(
          eq(siteRemoteProducts.siteId, siteProductMappings.siteId),
          eq(siteRemoteProducts.remoteProductId, siteProductMappings.remoteProductId),
          or(
            eq(siteRemoteProducts.remoteVariationId, siteProductMappings.remoteVariationId),
            and(
              isNull(siteRemoteProducts.remoteVariationId),
              isNull(siteProductMappings.remoteVariationId),
            ),
          ),
        ),
      )
      .where(eq(siteProductMappings.productId, id))
      .orderBy(desc(siteProductMappings.createdAt));
    return rows.map((r) => ({
      ...r,
      bundleQty: Number(r.bundleQty),
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    }));
  }

  /**
   * license_items status kırılımı. available = SATILABİLİR kalan kapasite (Σ max_uses−use_count,
   * products.list/reports ile AYNI semantik); assigned/revoked/expired/voided = satır sayısı.
   *
   * Kapasite toplamı atama koşuluyla (notExpiredCond) HİZALI: stok ömrü dolmuş kalemler
   * atanamadıkları için 'available' toplamına GİRMEZ; kaybolmasınlar diye `expiredAvailable`
   * olarak ayrı raporlanır.
   */
  private async detailStock(id: string): Promise<ProductDetail['stock']> {
    const list = await rawRows<{
      status: string;
      cnt: number;
      remaining: number;
      expired_remaining: number;
    }>(this.db, sql`
      SELECT
        status,
        count(*)::int AS cnt,
        coalesce(sum(max_uses - use_count) FILTER (WHERE ${notExpiredCond()}), 0)::int AS remaining,
        coalesce(sum(max_uses - use_count) FILTER (WHERE NOT ${notExpiredCond()}), 0)::int
          AS expired_remaining
      FROM license_items
      WHERE product_id = ${id}
      GROUP BY status;
    `);
    const by: Record<string, { cnt: number; remaining: number; expiredRemaining: number }> = {};
    for (const r of list) {
      by[r.status] = {
        cnt: Number(r.cnt),
        remaining: Number(r.remaining),
        expiredRemaining: Number(r.expired_remaining),
      };
    }
    return {
      available: by['available']?.remaining ?? 0,
      assigned: by['assigned']?.cnt ?? 0,
      revoked: by['revoked']?.cnt ?? 0,
      expired: by['expired']?.cnt ?? 0,
      voided: by['voided']?.cnt ?? 0,
      expiredAvailable: by['available']?.expiredRemaining ?? 0,
    };
  }

  /**
   * Bu ürüne bağlı teslim partileri (§12), en yeni önce.
   * Tedarikçi adı + teslim tarihi JOIN ile gelir: stok import ekranındaki parti seçici ham
   * UUID yerine "etiket · tarih · durum" gösterebilsin (operatörün elinde UUID yok).
   */
  private async detailBatches(id: string): Promise<ProductDetail['batches']> {
    const list = await rawRows<{
      id: string;
      label: string;
      status: string;
      qty_received: number;
      received_at: string;
      supplier_id: string | null;
      supplier_name: string | null;
    }>(this.db, sql`
      SELECT b.id, b.label, b.status, b.qty_received, b.received_at,
             b.supplier_id, s.name AS supplier_name
      FROM batches b
      LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.product_id = ${id}
      ORDER BY b.received_at DESC, b.created_at DESC;
    `);
    return list.map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status,
      qtyReceived: Number(r.qty_received),
      receivedAt: r.received_at,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
    }));
  }

  /**
   * Bu ürüne verilmiş satın alma emirleri (§12), en yeni önce.
   * supplier_id NOT NULL + RESTRICT FK → INNER JOIN güvenli (emirsiz tedarikçi satırı olamaz).
   */
  private async detailPurchaseOrders(id: string): Promise<ProductDetail['purchaseOrders']> {
    const list = await rawRows<{
      id: string;
      status: string;
      qty_ordered: number;
      qty_received: number;
      eta: string | null;
      supplier_id: string;
      supplier_name: string;
    }>(this.db, sql`
      SELECT po.id, po.status, po.qty_ordered, po.qty_received, po.eta,
             po.supplier_id, s.name AS supplier_name
      FROM purchase_orders po
      JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.product_id = ${id}
      ORDER BY po.created_at DESC;
    `);
    return list.map((r) => ({
      id: r.id,
      status: r.status,
      qtyOrdered: Number(r.qty_ordered),
      qtyReceived: Number(r.qty_received),
      eta: r.eta,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
    }));
  }

  /**
   * Satış hızı: bu ürünün atamalarında (assignments→order_lines) 7/30 gün penceresinde
   * tüketilen units toplamı. reports.velocity ile AYNI mantık, tek ürüne daraltılmış.
   * Yalnız AYAKTA atamalar (active/suspended/expired) — iade/değişimde geri alınan eski
   * atama satış SAYILMAZ (reports.velocity ile tutarlı).
   */
  private async detailVelocity(id: string): Promise<{ sold7d: number; sold30d: number }> {
    const list = await rawRows<{ sold7d: number; sold30d: number }>(this.db, sql`
      SELECT
        coalesce(sum(a.units) FILTER (WHERE a.created_at >= now() - interval '7 days' AND a.status IN ('active','suspended','expired')), 0)::int AS sold7d,
        coalesce(sum(a.units) FILTER (WHERE a.created_at >= now() - interval '30 days' AND a.status IN ('active','suspended','expired')), 0)::int AS sold30d
      FROM assignments a
      JOIN order_lines ol ON ol.id = a.line_id
      WHERE ol.product_id = ${id}
        -- PERF (reports.velocity ile aynı budama): dış tarama 30 güne daraltılır. Toplamlar
        -- ZATEN yalnız 7g/30g FILTER'larından çıkıyor → 30 günden eski atamaların katkısı 0'dı;
        -- WHERE olmadan ürünün TÜM geçmişi taranıyordu. SONUÇ BİREBİR AYNI (yalnız okunan satır azalır).
        AND a.created_at >= now() - interval '30 days';
    `);
    return { sold7d: Number(list[0]?.sold7d ?? 0), sold30d: Number(list[0]?.sold30d ?? 0) };
  }

  /**
   * Sebepli stok düzeltme izi (§12), en yeni önce (son 50).
   * actor + license_item_id de döner: "bu 5 anahtarı KİM geçersiz kıldı" ve "düzeltme
   * gerçekten stoka dokundu mu" soruları ekrandan yanıtlanabilsin (ikisi de zaten yazılıyordu,
   * yalnız okunmuyordu).
   */
  private async detailAdjustments(id: string): Promise<ProductDetail['adjustments']> {
    const list = await rawRows<{
      id: string;
      action: string;
      qty: number;
      reason: string;
      actor: string;
      license_item_id: string | null;
      created_at: string;
    }>(this.db, sql`
      SELECT id, action, qty, reason, actor, license_item_id, created_at
      FROM stock_adjustments
      WHERE product_id = ${id}
      ORDER BY created_at DESC
      LIMIT 50;
    `);
    return list.map((r) => ({
      id: r.id,
      action: r.action,
      qty: Number(r.qty),
      reason: r.reason,
      actor: r.actor,
      licenseItemId: r.license_item_id,
      createdAt: r.created_at,
    }));
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
    remoteVariationId?: string | null;
    bundleQty?: number;
  }) {
    // Biçimi geçerli ama VAR OLMAYAN site/ürün id'si → ham Postgres FK ihlali (23503) →
    // opak 500. stock.import/sites.update deseni gibi önce varlığı çöz, yoksa anlamlı 404.
    await this.getById(input.productId); // ürün yoksa 404
    const [site] = await this.db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.id, input.siteId))
      .limit(1);
    if (!site) throw new NotFoundException('Site bulunamadı');

    // '0'/boş varyasyon = varyasyon yok (resolveMapping ile AYNI normalizasyon) → depoda null.
    const variation =
      input.remoteVariationId && input.remoteVariationId !== '0' ? input.remoteVariationId : null;

    // KRİTİK: unique index (site, remote_product_id, remote_variation_id) Postgres'te NULL'ları
    // AYRI sayar → aynı (site, ürün, varyasyonsuz) için İKİ eşleme eklenebilir (sessiz mükerrer,
    // resolveMapping "en eski"i seçer). advisory-lock + app-düzeyi ön-kontrol ile kapatılır
    // (D3 site-scoped upsert deseni; artık panel formu da güvenli). Kilit anahtarı normalize varyasyonu içerir.
    // KRİTİK: advisory-lock anahtarı upsertSiteMapping (WP "Panel Eşlemesi" kutusu,
    // /v1/site-mappings) ile BİREBİR AYNI olmalı → iki yazar aynı kilitte serialize olur. Farklı
    // anahtar (ör. 'map:' önekli) kullanılsaydı eşzamanlı panel-formu + WP-kutu, NULL-varyasyonda
    // (unique index NULL'ı ayrı sayar) çift-satır üretebilirdi (denetim MED bulgusu).
    const lockKey = `${input.siteId}:${input.remoteProductId}:${variation ?? ''}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      const existing = await tx
        .select({ id: siteProductMappings.id })
        .from(siteProductMappings)
        .where(
          and(
            eq(siteProductMappings.siteId, input.siteId),
            eq(siteProductMappings.remoteProductId, input.remoteProductId),
            variation
              ? eq(siteProductMappings.remoteVariationId, variation)
              : isNull(siteProductMappings.remoteVariationId),
          ),
        )
        .limit(1);
      if (existing.length) {
        throw new ConflictException('Bu site + mağaza ürün/varyasyon eşlemesi zaten kayıtlı');
      }
      try {
        const [row] = await tx
          .insert(siteProductMappings)
          .values({
            siteId: input.siteId,
            productId: input.productId,
            remoteProductId: input.remoteProductId,
            remoteVariationId: variation,
            bundleQty: input.bundleQty ?? 1,
          })
          .returning();
        return row!;
      } catch (err) {
        // Varyasyonlu yarışta mappings_site_remote_uniq (23505) → ham 500 yerine anlamlı 409.
        if (String(err).toLowerCase().includes('unique') || String(err).includes('23505')) {
          throw new ConflictException('Bu site + mağaza ürün/varyasyon eşlemesi zaten kayıtlı');
        }
        throw err;
      }
    });
  }

  /**
   * "Eşlenmemiş gelen ürünler" (§3): gerçek siparişlerde gelmiş AMA hâlâ aktif eşlemesi olmayan
   * mağaza ürünleri — (site, mağaza ürün, varyasyon) bazında gruplanır, en son gelen ad + adet +
   * son görülme ile. Operatör buradan ELLE ID yazmadan tek-tıkla eşler (typo riski biter).
   * Yalnız 0022 sonrası siparişlerde remote_product_id dolu; öncekiler görünmez (geriye dönük zararsız).
   */
  async listUnmapped() {
    const rows = await rawRows<{
      site_id: string;
      domain: string;
      remote_product_id: string;
      remote_variation_id: string | null;
      name: string | null;
      line_count: number;
      order_count: number;
      last_seen: string;
    }>(
      this.db,
      sql`
        SELECT o.site_id,
               s.domain,
               ol.remote_product_id,
               NULLIF(NULLIF(ol.remote_variation_id, '0'), '') AS remote_variation_id,
               MAX(ol.remote_name) AS name,
               COUNT(*)::int AS line_count,
               COUNT(DISTINCT o.id)::int AS order_count,
               MAX(o.created_at) AS last_seen
        FROM order_lines ol
        JOIN orders o ON ol.order_id = o.id
        JOIN sites s ON o.site_id = s.id
        WHERE ol.product_id IS NULL
          AND ol.canceled = false
          AND ol.remote_product_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM site_product_mappings m
            WHERE m.site_id = o.site_id
              AND m.remote_product_id = ol.remote_product_id
              AND m.active = true
              AND (
                m.remote_variation_id IS NULL
                OR m.remote_variation_id = NULLIF(NULLIF(ol.remote_variation_id, '0'), '')
              )
          )
        GROUP BY o.site_id, s.domain, ol.remote_product_id,
                 NULLIF(NULLIF(ol.remote_variation_id, '0'), '')
        ORDER BY last_seen DESC
        LIMIT 500
      `,
    );
    return rows.map((r) => ({
      siteId: r.site_id,
      siteDomain: r.domain,
      remoteProductId: r.remote_product_id,
      remoteVariationId: r.remote_variation_id,
      remoteName: r.name,
      lineCount: Number(r.line_count),
      orderCount: Number(r.order_count),
      lastSeen: r.last_seen,
    }));
  }

  /**
   * Eşleme kısmi güncelleme (§3): aktif/pasif toggle VE/VEYA hedef panel ürününü DEĞİŞTİR (remap) +
   * bundle adedi. productId verilirse ürün varlığı doğrulanır (yoksa 404, ham FK 500 yerine). En az
   * bir alan zorunlu. (site, remote, varyasyon) anahtarı değişmediği için remap unique çakışması
   * YARATMAZ — advisory-lock gerekmez. Eşleme HER ZAMAN operatör kontrolünde; otomatik değişim YOK.
   */
  async updateMapping(
    id: string,
    patch: { active?: boolean; productId?: string; bundleQty?: number },
  ) {
    const set: Partial<typeof siteProductMappings.$inferInsert> = {};
    if (patch.active !== undefined) set.active = patch.active;
    if (patch.productId !== undefined) {
      await this.getById(patch.productId); // hedef ürün yoksa 404
      set.productId = patch.productId;
    }
    if (patch.bundleQty !== undefined) set.bundleQty = patch.bundleQty;
    if (Object.keys(set).length === 0) {
      throw new BadRequestException('Güncellenecek alan yok');
    }
    const [row] = await this.db
      .update(siteProductMappings)
      .set(set)
      .where(eq(siteProductMappings.id, id))
      .returning();
    if (!row) throw new NotFoundException('Eşleme bulunamadı');
    return row;
  }

  /**
   * Eşlemeyi TAMAMEN kaldır (§3). Yoksa 404. Sonrasında bu mağaza ürününün siparişleri artık panel
   * ürünü çözemez (unmapped → pending; yanlış teslim YOK). Operatör dilerse yeniden eşler.
   */
  async deleteMapping(id: string) {
    const [row] = await this.db
      .delete(siteProductMappings)
      .where(eq(siteProductMappings.id, id))
      .returning({ id: siteProductMappings.id });
    if (!row) throw new NotFoundException('Eşleme bulunamadı');
    return { id: row.id, deleted: true };
  }

  // ─── Mağaza ürün kataloğu senkronu (§3 — panelde PROAKTİF eşleme) ────────────────────

  /**
   * Katalog senkronu (site-facing HMAC): WP eklentisi sitenin yayınlanmış ürünlerini (ad/sku/tip/
   * varyasyon) gönderir → panel snapshot'ı YENİLER (delete+insert, atomik). Eşlemeler
   * (site_product_mappings) AYRI tablo → katalog yenilense de kopmaz. SIR YOK. Amaç: operatör
   * sipariş beklemeden mağaza ürününü ADIYLA seçip eşlesin (elle ham ID yazmasın).
   *
   * `adminOrderUrlTemplate` (opsiyonel, §17): mağaza kendi admin sipariş bağlantı şablonunu bildirir
   * (HPOS açık/kapalı olduğunu yalnız mağaza bilir → panelin varsayımı yerine kaynağından gelir).
   * Karar artık değerin DOLU olup olmadığına değil, KAYNAĞINA bakar (`sites.admin_order_url_template_manual`):
   *   - undefined  → mevcut şablona DOKUNULMAZ (alan hiç gönderilmemiş)                → 'absent',
   *   - kaynak ELLE (manual=true) → mağaza ne gönderirse göndersin DOKUNULMAZ (S5)     → 'kept_manual',
   *   - kaynak OTOMATİK (manual=false) + null/boş gönderildi → mevcut değer SİLİNMEZ,
   *     no-op (mağaza panelin ayarını kaldıramaz)                                      → 'accepted',
   *   - kaynak OTOMATİK + dolu gönderildi → DOLU OLSA BİLE güncellenir; yalnız http(s) + `{orderId}` +
   *     kimlik-bilgisiz + host==site.domain (ya da ALT alan adı) ise yazılır; aksi halde SESSİZCE
   *     yok sayılır (warn) → 'rejected_format' / 'rejected_host'. Katalog senkronu ASLA başarısız olmaz.
   * Yanıt: `adminOrderUrlTemplateStatus` (sebep kodu, WP tarafı reddin NEDENİNİ görebilsin) +
   * geriye dönük uyum için `adminOrderUrlTemplateAccepted` (yalnız 'accepted' iken true). Sır dönmez.
   */
  async syncCatalog(
    siteId: string,
    items: Array<{
      remoteProductId: string;
      remoteVariationId?: string | null;
      name: string;
      sku?: string | null;
      kind?: string | null;
    }>,
    adminOrderUrlTemplate?: string | null,
  ): Promise<{
    synced: number;
    adminOrderUrlTemplateAccepted: boolean;
    adminOrderUrlTemplateStatus: SyncCatalogTemplateStatus;
  }> {
    // Şablon alanı HİÇ gönderilmemişse (undefined) mevcut sites.admin_order_url_template'e
    // DOKUNMAYIZ — eski eklenti sürümleri alanı bilmez, kataloğu senkronlarken operatörün
    // panelde elle girdiği şablonu silmemeliler.
    const hasTemplateField = adminOrderUrlTemplate !== undefined;
    // Boş snapshot'ı NO-OP say (kataloğu SİLME): WP'de toplu düzenlemede tüm ürünler geçici olarak
    // taslağa düşerse ya da object-cache boş dönerse gelen boş dizi mevcut kataloğu YANLIŞLIKLA
    // silmesin. Gerçek "0 ürün" durumu da proaktif eşleme için anlamsız; snapshot korunur, sonraki
    // gerçek senkron düzeltir. (Silme YALNIZ dolu snapshot geldiğinde, replace semantiğiyle olur.)
    const skipCatalog = !items.length;
    // Ne yazılacak katalog ne de şablon varsa hiç transaction açma (eski erken-çıkış davranışı).
    if (skipCatalog && !hasTemplateField) {
      return {
        synced: 0,
        adminOrderUrlTemplateAccepted: false,
        adminOrderUrlTemplateStatus: 'absent',
      };
    }
    // Eşzamanlı aynı-site tam-snapshot'ları serileştir (upsertSiteMapping deseni): manuel "Ürünleri
    // Panele Aktar" ile arka plan otomatik senkron ÇAKIŞABİLİR. Kilit olmadan (a) varyasyonlu
    // katalogda T2 insert 23505 → 500; (b) tüm-basit katalogda unique index NULL'ı AYRI saydığından
    // çift satır kalır (ürün 2× görünür, sayı şişer). Advisory-xact-lock delete+insert'i atomik yapar.
    const lockKey = `catalog:${siteId}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
      let synced = 0;
      if (!skipCatalog) {
        await tx.delete(siteRemoteProducts).where(eq(siteRemoteProducts.siteId, siteId));
        const seen = new Set<string>();
        const rows = items
          .map((it) => {
            const variation =
              it.remoteVariationId && it.remoteVariationId !== '0' ? it.remoteVariationId : null;
            return {
              siteId,
              remoteProductId: it.remoteProductId,
              remoteVariationId: variation,
              name: it.name.slice(0, 500),
              sku: it.sku ? it.sku.slice(0, 120) : null,
              kind: it.kind ? it.kind.slice(0, 40) : null,
            };
          })
          // unique index NULL'ı ayrı sayar → delete+insert içinde mükerrer (product,variation) çift
          // satırı INSERT'i patlatmasın diye app-düzeyi dedup (ilk kazanır).
          .filter((r) => {
            const k = `${r.remoteProductId}::${r.remoteVariationId ?? ''}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        for (let i = 0; i < rows.length; i += 500) {
          await tx.insert(siteRemoteProducts).values(rows.slice(i, i + 500));
        }
        synced = rows.length;
      }

      // Mağazanın bildirdiği admin sipariş URL şablonu (§17) — AYNI kilit/transaction içinde
      // değerlendirilir ki eşzamanlı iki senkron farklı şablon bırakmasın. Şablon SALT YÖNLENDİRME:
      // panel bu adrese bağlanmaz, yalnız operatörün tıklayacağı bağlantıyı üretir. Geçersizse
      // SESSİZCE yok sayılır (warn) — katalog asıl iştir, senkron başarısız EDİLMEZ.
      //
      // [S5 — düzeltildi] ELLE GİRİLEN DEĞER KAZANIR, ama karar KAYNAĞA bakar (değerin dolu olup
      // olmadığına DEĞİL): `sites.admin_order_url_template_manual` true ise şablona DOKUNULMAZ.
      //
      // Neden kaynak-tabanlı: eski kural "panelde dolu ⇒ dokunma" idi. Bu, İLK otomatik değerin
      // sütunu KALICI olarak kilitlemesi demekti — mağaza 3 ay sonra HPOS'u kapatsa ya da WP'yi
      // alt dizine taşısa mağazanın bildirdiği YENİ DOĞRU şablon bir daha asla yazılamıyor, panel
      // ölü/yanlış bağlantı üretmeye devam ediyordu ("ya doğru ya hiç" şartının ihlali). Artık:
      //   - manual=true  (operatör panel formundan girdi) → senkron ÜZERİNE YAZMAZ (operatör
      //     düzeltmesi ~3 dk sonra sessizce ezilmez; S5'in asıl amacı budur),
      //   - manual=false (mağazanın bildirdiği ya da hiç girilmemiş) → mağaza kaynaktır, dolu
      //     olsa bile TAZE değer yazılır (mağaza taşınınca link kendiliğinden düzelir).
      // Mağazanın açık `null`/boş göndermesi dolu alanı SİLMEZ: temizleme operatörün işidir,
      // mağaza panelin ayarını kaldıramaz. (`manual` bayrağını YALNIZ sites.update yazar; katalog
      // senkronu bayrağa dokunmaz → otomatik değer yazmak alanı elle-girilmiş yapmaz.)
      let templateStatus: SyncCatalogTemplateStatus = 'absent';
      if (hasTemplateField) {
        // Mevcut değer + kaynak bayrağı + domain TEK okumada. FOR UPDATE (TOCTOU): okuma ile yazma
        // arasında operatör panel formundan şablon kaydederse (sites.update, manual=true) o UPDATE
        // bu tx bitene kadar bekler → "otomatikti sandım, yazdım" yarışı kapanır. Kilit sırası:
        // advisory(catalog) → sites satırı (bu tx sonunda zaten aynı satırı UPDATE ediyordu).
        const [site] = await tx
          .select({
            domain: sites.domain,
            current: sites.adminOrderUrlTemplate,
            manual: sites.adminOrderUrlTemplateManual,
          })
          .from(sites)
          .where(eq(sites.id, siteId))
          .limit(1)
          .for('update');
        const current = (site?.current ?? '').trim();
        const raw = (adminOrderUrlTemplate ?? '').trim();
        if (site?.manual === true) {
          // Kaynak ELLE → DOKUNMA (ne yazma ne temizleme). Operatör mağazadan yeniden öğrenilmesini
          // isterse alanı panel formundan TEMİZLER (sites.update manual=false yapar) → sonraki
          // senkron mağazanın bildirdiğini yazar.
          templateStatus = 'kept_manual';
        } else if (!raw) {
          // Mağaza boş/null gönderdi → mevcut (otomatik) değeri koru, istenen durum sağlanmış sayılır.
          templateStatus = 'accepted';
        } else {
          const reason = adminOrderUrlTemplateRejection(raw, site?.domain ?? '');
          if (reason) {
            // Ham şablonu LOGLAMA (gereksiz veri, kimlik bilgisi içerebilir); yalnız site + sebep.
            this.logger.warn(
              `Katalog senkronu: adminOrderUrlTemplate yok sayıldı (site=${siteId}, sebep=${reason})`,
            );
            templateStatus = rejectionStatus(reason);
          } else if (raw === current) {
            // Değer değişmemiş → gereksiz UPDATE yazma (senkron ~3 dk'da bir koşuyor; updatedAt'i
            // her turda kirletmek sipariş/site listelerinde yanıltıcı "az önce güncellendi" üretir).
            templateStatus = 'accepted';
          } else {
            await tx
              .update(sites)
              .set({ adminOrderUrlTemplate: raw, updatedAt: new Date() })
              .where(eq(sites.id, siteId));
            templateStatus = 'accepted';
          }
        }
      }

      return {
        synced,
        // Geriye dönük uyum: alanı bilen eski WP sürümleri yalnız bu boolean'a bakar (yeni sürüm
        // reddin SEBEBİNİ `adminOrderUrlTemplateStatus`tan okur).
        adminOrderUrlTemplateAccepted: templateStatus === 'accepted',
        adminOrderUrlTemplateStatus: templateStatus,
      };
    });
  }

  /** Sitelerin katalog özeti (picker için): aktif ürün sayısı + son senkron; katalog yoksa 0. */
  async catalogSummary() {
    const rows = await rawRows<{
      site_id: string;
      domain: string;
      product_count: number;
      last_synced_at: string | null;
    }>(
      this.db,
      sql`
        SELECT s.id AS site_id, s.domain,
               COUNT(rp.id)::int AS product_count,
               MAX(rp.synced_at) AS last_synced_at
        FROM sites s
        LEFT JOIN site_remote_products rp ON rp.site_id = s.id AND rp.active = true
        GROUP BY s.id, s.domain
        ORDER BY s.domain
      `,
    );
    return rows.map((r) => ({
      siteId: r.site_id,
      domain: r.domain,
      productCount: Number(r.product_count),
      lastSyncedAt: r.last_synced_at,
    }));
  }

  /**
   * Bir sitenin senkron kataloğu + her ürünün EŞLEME DURUMU (eşli → panel ürün adı + bundle; yoksa
   * null). Eşli mantığı resolveMapping ile aynı (varyasyon-özel VEYA ürün-seviyesi; en spesifik
   * tercih — DISTINCT ON). Eşlenmemiş ÜSTTE. Panelde proaktif eşleme ekranını besler.
   *
   * [G9] VARYASYONLU ÜRÜNÜN EBEVEYN SATIRI — eşleme semantiği DEĞİŞMEZ, yalnız SUNUM bilgisi eklenir.
   * Katalogda variable bir ürün hem EBEVEYN satırı (kind='variable', remote_variation_id IS NULL) hem
   * her varyasyonu (kind='variation') ile durur. Sipariş satırı her zaman bir varyasyona düşer ve
   * eşleme varyasyon-özel kurulur; ebeveyn satırı SQL üç-değerli mantığı gereği varyasyon-özel
   * eşlemelerle ASLA eşleşmez (m.remote_variation_id = NULL → NULL) → tüm varyasyonları doğru eşlenmiş
   * üründe bile ebeveyn sonsuza dek `mapped=false` kalır. Dashboard sayacı (dashboard.service
   * unmappedCatalogProducts) bu satırı zaten HARİÇ tutuyordu → iki ekran farklı sayı gösteriyor,
   * operatör "hangisi doğru" diye tereddüt edip alarmı susturmak için TEHLİKELİ bir ürün-seviyesi
   * catch-all eşleme kurmaya yöneliyordu. Çözüm: satırı ayırt eden bayrak + varyasyon eşleme sayacı
   *   `isVariableParent` / `variationCount` / `mappedVariationCount`
   * döndürülür; UI bu satırı kırmızı "eşlenmemiş" yerine nötr "varyasyonları eşleyin (N/M eşli)"
   * olarak gösterir. Ebeveyne DOĞRUDAN eşleme kurmak hâlâ mümkündür (ürün-seviyesi eşleme meşru bir
   * fallback'tir) — yalnız VARSAYILAN eylem değildir. Sıralamada da ebeveyn "eşlenmemiş" bloğunun
   * başına çıkmaz (gerçekten eşlenmemiş somut satırlar üstte kalır).
   */
  async listCatalog(siteId: string) {
    const rows = await rawRows<{
      remote_product_id: string;
      remote_variation_id: string | null;
      name: string;
      sku: string | null;
      kind: string | null;
      synced_at: string;
      mapping_id: string | null;
      mapped_product_id: string | null;
      bundle_qty: number | null;
      mapped_product_name: string | null;
      is_variable_parent: boolean;
      variation_count: number;
      mapped_variation_count: number;
    }>(
      this.db,
      sql`
        WITH base AS (
          SELECT DISTINCT ON (rp.id)
                 rp.id,
                 rp.remote_product_id, rp.remote_variation_id, rp.name, rp.sku, rp.kind, rp.synced_at,
                 m.id AS mapping_id, m.product_id AS mapped_product_id, m.bundle_qty, p.name AS mapped_product_name
          FROM site_remote_products rp
          LEFT JOIN site_product_mappings m
            ON m.site_id = rp.site_id
           AND m.remote_product_id = rp.remote_product_id
           AND m.active = true
           AND (m.remote_variation_id IS NULL OR m.remote_variation_id = rp.remote_variation_id)
          LEFT JOIN products p ON p.id = m.product_id
          WHERE rp.site_id = ${siteId} AND rp.active = true
          ORDER BY rp.id, (m.remote_variation_id IS NOT NULL) DESC
        ), variation_stats AS (
          -- Aynı mağaza ürününün VARYASYON satırları (ebeveyn hariç): kaçı eşli? Yalnız SUNUM için
          -- (ebeveyn satırında "N/M eşli" yazabilmek); eşleme kararına HİÇ karışmaz.
          SELECT remote_product_id,
                 count(*)::int AS variation_count,
                 (count(*) FILTER (WHERE mapped_product_id IS NOT NULL))::int AS mapped_variation_count
          FROM base
          WHERE remote_variation_id IS NOT NULL
          GROUP BY remote_product_id
        )
        SELECT b.*,
               -- coalesce ŞART: kind NULL olan ESKİ katalog satırlarında düz karşılaştırma NULL
               -- üretir (dashboard sayacındaki aynı gerekçe) → bayrak sessizce NULL olurdu.
               (coalesce(b.kind, '') = 'variable' AND b.remote_variation_id IS NULL) AS is_variable_parent,
               coalesce(v.variation_count, 0) AS variation_count,
               coalesce(v.mapped_variation_count, 0) AS mapped_variation_count
        FROM base b
        LEFT JOIN variation_stats v ON v.remote_product_id = b.remote_product_id
        -- Sıralama: gerçekten eşlenmemiş SOMUT satırlar üstte; ebeveyn satırı (bilgi amaçlı) ve
        -- eşli satırlar altta, ad'a göre (varyasyonlar zaten ebeveyn adıyla aynı öbekte toplanır).
        ORDER BY (b.mapped_product_id IS NOT NULL
                  OR (coalesce(b.kind, '') = 'variable' AND b.remote_variation_id IS NULL)), b.name
        LIMIT 5000
      `,
    );
    return rows.map((r) => ({
      remoteProductId: r.remote_product_id,
      remoteVariationId: r.remote_variation_id,
      name: r.name,
      sku: r.sku,
      kind: r.kind,
      syncedAt: r.synced_at,
      mapped: r.mapped_product_id !== null,
      mappingId: r.mapping_id,
      mappedProductId: r.mapped_product_id,
      mappedProductName: r.mapped_product_name,
      bundleQty: r.bundle_qty,
      // Sunum bayrakları (bkz. üstteki [G9] notu) — eşleme semantiği değişmez.
      isVariableParent: r.is_variable_parent === true,
      variationCount: Number(r.variation_count ?? 0),
      mappedVariationCount: Number(r.mapped_variation_count ?? 0),
    }));
  }

  // ─── §7 WP ürün-eşleme kutusu (site-scoped, HMAC) ────────────────────────────────────
  // WP ürün-düzenleme ekranındaki "Panel Eşlemesi" kutusu için hafif katalog + site-scoped
  // eşleme CRUD. SIR YOK (yalnız ürün adı/sku/tip; fiyat/lisans DÖNMEZ). Tüm yazma/okuma
  // ÇAĞIRAN SİTEYE scope'lu (controller CurrentSite.id geçirir) → başka sitenin eşlemesine dokunulmaz.

  /** Eşleme kutusu ürün seçici: hafif katalog listesi (sır yok). */
  async listForCatalog() {
    return this.db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        kind: products.kind,
        usageMode: products.usageMode,
      })
      .from(products)
      .orderBy(asc(products.name))
      .limit(500);
  }

  /** Bu sitenin eşlemeleri (ürün adıyla); opsiyonel remoteProductId filtresi (o Woo ürünü). */
  async listSiteMappings(siteId: string, remoteProductId?: string) {
    const where = remoteProductId
      ? and(
          eq(siteProductMappings.siteId, siteId),
          eq(siteProductMappings.remoteProductId, remoteProductId),
        )
      : eq(siteProductMappings.siteId, siteId);
    return this.db
      .select({
        id: siteProductMappings.id,
        remoteProductId: siteProductMappings.remoteProductId,
        remoteVariationId: siteProductMappings.remoteVariationId,
        productId: siteProductMappings.productId,
        productName: products.name,
        productSku: products.sku,
        bundleQty: siteProductMappings.bundleQty,
        active: siteProductMappings.active,
      })
      .from(siteProductMappings)
      .innerJoin(products, eq(siteProductMappings.productId, products.id))
      .where(where)
      .orderBy(asc(siteProductMappings.remoteProductId))
      .limit(500);
  }

  /**
   * Site-scoped eşleme UPSERT (§7 WP kutusu). (site, remoteProductId, varyasyon) varsa GÜNCELLE,
   * yoksa EKLE. NULL-varyasyon güvenli (Postgres unique index NULL'ları ayrı sayar → onConflict
   * fire etmez; bu yüzden elle select-then-write). Ürün yoksa 404 (FK 500 yerine anlamlı).
   */
  async upsertSiteMapping(input: {
    siteId: string;
    productId: string;
    remoteProductId: string;
    remoteVariationId?: string;
    bundleQty?: number;
  }) {
    await this.getById(input.productId); // ürün yoksa 404
    const variation =
      input.remoteVariationId && input.remoteVariationId !== '0' ? input.remoteVariationId : null;

    // Denetim (TOCTOU): select-then-write iki eşzamanlı çağrıda (site, remoteProductId, variation=null)
    // için ÇİFT satır üretebilirdi — Postgres unique index NULL varyasyonu AYRI sayar, onConflict
    // fire etmez. Advisory-xact-lock ile (site+remote+variation başına) serileştir → tek satır garanti.
    const lockKey = `${input.siteId}:${input.remoteProductId}:${variation ?? ''}`;
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      const [existing] = await tx
        .select({ id: siteProductMappings.id })
        .from(siteProductMappings)
        .where(
          and(
            eq(siteProductMappings.siteId, input.siteId),
            eq(siteProductMappings.remoteProductId, input.remoteProductId),
            variation === null
              ? isNull(siteProductMappings.remoteVariationId)
              : eq(siteProductMappings.remoteVariationId, variation),
          ),
        )
        .limit(1);

      if (existing) {
        const [row] = await tx
          .update(siteProductMappings)
          .set({ productId: input.productId, bundleQty: input.bundleQty ?? 1, active: true })
          .where(eq(siteProductMappings.id, existing.id))
          .returning();
        return row!;
      }
      try {
        const [row] = await tx
          .insert(siteProductMappings)
          .values({
            siteId: input.siteId,
            productId: input.productId,
            remoteProductId: input.remoteProductId,
            remoteVariationId: variation,
            bundleQty: input.bundleQty ?? 1,
          })
          .returning();
        return row!;
      } catch (err) {
        // Varyasyonlu yol: mappings_site_remote_uniq ihlali → ham 500 yerine anlamlı 409.
        if (String(err).toLowerCase().includes('unique') || String(err).includes('23505')) {
          throw new ConflictException('Bu site + remote ürün/varyasyon eşlemesi zaten kayıtlı');
        }
        throw err;
      }
    });
  }

  /** Bu sitenin (remoteProductId, varyasyon) eşlemesini sil (§7 "Eşlemeyi kaldır"). */
  async deleteSiteMapping(siteId: string, remoteProductId: string, remoteVariationId?: string) {
    const variation =
      remoteVariationId && remoteVariationId !== '0' ? remoteVariationId : null;
    await this.db
      .delete(siteProductMappings)
      .where(
        and(
          eq(siteProductMappings.siteId, siteId),
          eq(siteProductMappings.remoteProductId, remoteProductId),
          variation === null
            ? isNull(siteProductMappings.remoteVariationId)
            : eq(siteProductMappings.remoteVariationId, variation),
        ),
      );
    return { deleted: true };
  }
}

/**
 * Katalog senkronunda mağazanın bildirdiği admin sipariş URL şablonunun AKIBETİ (§17). Sır
 * içermeyen kısa sebep kodu — WP tarafı "kabul edilmedi"nin NEDENİNİ görüp operatöre anlamlı
 * uyarı gösterebilsin (eskiden yalnız `accepted: false` dönüyordu, sebep görünmüyordu).
 *   accepted        → yazıldı (ya da istenen boş durum zaten sağlanmış),
 *   kept_manual     → kaynak ELLE (sites.admin_order_url_template_manual=true) → değer korundu
 *                     (S5: operatörün panel formundan girdiği değer kazanır),
 *   rejected_host   → şablonun hedefi sitenin alan adı değil (ya da kimlik bilgisi taşıyor),
 *   rejected_format → şema/`{orderId}`/ayrıştırma hatası,
 *   absent          → mağaza bu alanı hiç göndermedi.
 */
export type SyncCatalogTemplateStatus =
  | 'accepted'
  | 'kept_manual'
  | 'rejected_host'
  | 'rejected_format'
  | 'absent';

/** `adminOrderUrlTemplateRejection` sebepleri (log metni + status eşlemesi tek yerde tanımlı). */
type TemplateRejectionReason =
  | 'sema_http_degil'
  | 'orderId_yer_tutucusu_yok'
  | 'url_ayristirilamadi'
  | 'kimlik_bilgisi_iceriyor'
  | 'host_site_domaini_ile_uyusmuyor';

/** Reddetme sebebi → dışarıya dönen kaba sebep kodu (hedef/authority sorunu vs biçim sorunu). */
function rejectionStatus(reason: TemplateRejectionReason): SyncCatalogTemplateStatus {
  return reason === 'host_site_domaini_ile_uyusmuyor' || reason === 'kimlik_bilgisi_iceriyor'
    ? 'rejected_host'
    : 'rejected_format';
}

/**
 * Mağazanın katalog senkronuyla bildirdiği admin sipariş URL şablonunun güvenlik kapısı (§17).
 * Reddetme sebebini döndürür; null ise şablon KABUL edilebilir. Kurallar:
 *   - http:// veya https:// ZORUNLU + `new URL` ile ayrıştırılabilmeli (javascript:/data: reddedilir),
 *   - `{orderId}` yer tutucusu ŞART (yoksa üretilen bağlantı siparişe gitmez),
 *   - URL KİMLİK BİLGİSİ TAŞIYAMAZ (`https://kullanici:parola@host/...`): (a) tarayıcı adres
 *     çubuğunda gerçek host'u gizleyip operatörü yanıltır (kimlik-avı), (b) sır benzeri veriyi
 *     panele/sites tablosuna sokar. Şablon SALT yönlendirmedir, kimlik doğrulaması taşımaz.
 *   - HOST DOĞRULAMASI: şablonun host'u sitenin KAYITLI domain'iyle uyumlu olmalı → bir site
 *     kendi alan adı dışına (yabancı/phishing hedefine) operatör bağlantısı yazdıramaz.
 */
function adminOrderUrlTemplateRejection(
  raw: string,
  siteDomain: string,
): TemplateRejectionReason | null {
  if (!/^https?:\/\//i.test(raw)) return 'sema_http_degil';
  if (!raw.includes('{orderId}')) return 'orderId_yer_tutucusu_yok';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'url_ayristirilamadi';
  }
  if (url.username || url.password) return 'kimlik_bilgisi_iceriyor';
  if (!hostMatchesSiteDomain(url.hostname, siteDomain))
    return 'host_site_domaini_ile_uyusmuyor';
  return null;
}

/**
 * Host, sitenin kayıtlı domain'iyle uyumlu mu (F15 sertleştirmesi).
 *
 * KABUL: host === site.domain  VEYA  host, site.domain'in ALT alan adı (`a.endsWith('.' + b)`).
 * RED  : host'un site.domain'i KAPSAYAN üst alan adı olması (kaldırılan `b.endsWith('.' + a)` dalı).
 *   Senaryo (çok kiracılı kurulum): kiracı sitesi `shop1.ortak.com`. Eski kural şablon host'u olarak
 *   `ortak.com`'u da kabul ediyordu → kiracı, sipariş detayındaki "Mağaza panelinde aç" linkini
 *   BAŞKA bir alan adına (ortak alan / başka kiracının kontrolündeki sayfa) yazdırabiliyordu.
 *   Panel operatörü o linke WP-admin oturumu açıkken tıklar → oturum/kimlik-avı yüzeyi. Artık bir
 *   site yalnız KENDİ alan adına veya onun ALTINDAKİ bir ada link yazdırabilir.
 * Normalizasyon: küçük harf + şema/port/yol/`www.`/kök noktası (`ornek.com.`) atılır; olası
 * `user:pass@` öneki (zaten reddediliyor) savunma derinliği olarak temizlenir. Boş → false.
 * NOT: `www.` iki tarafta da atıldığı için site domain'i `www.ornek.com` ise `ornek.com` alt
 * alan adları da kabul edilir (www.x ≡ x geleneği) — kiracı-başına-www kurulumu varsayılmıyor.
 */
function hostMatchesSiteDomain(host: string, siteDomain: string): boolean {
  const norm = (h: string) =>
    h
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^[^/@]*@/, '')
      .replace(/[/?#].*$/, '')
      .replace(/:\d+$/, '')
      .replace(/^www\./, '')
      .replace(/\.$/, '');
  const a = norm(host);
  const b = norm(siteDomain);
  if (!a || !b) return false;
  return a === b || a.endsWith(`.${b}`);
}
