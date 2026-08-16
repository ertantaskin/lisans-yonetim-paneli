import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { auditLog } from '../db/schema/audit';
import { stockAdjustments, type StockAdjustment } from '../db/schema/stockAdjustments';
import { AdminOrdersService } from '../orders/admin-orders.service';
import { FulfillmentService } from '../orders/fulfillment.service';
import { recordReplacementLineage } from '../orders/assignment-history';
import { notExpiredCond } from '../assignment/assign';

/** Toplu değiştirme (§13) özet sonucu. */
export interface BulkReplaceResult {
  /** Bu partiye ait satılmış + aktif atamalı kalem sayısı (değiştirilmeye aday). */
  total: number;
  /** Başarıyla yenisiyle değiştirilen (revoke + yeni atama) kalem sayısı. */
  replaced: number;
  /** Stok bulunmadığı için atlanan (eski atama korunur) kalem sayısı. */
  skippedNoStock: number;
  /** Çok-kullanımlı (MAK) olduğu için otomatik değiştirilemeyen kalem sayısı (elle işlenir). */
  skippedUnsupported: number;
}

/** Geri çekilmiş partinin özet sonucu. */
export interface RecallResult {
  /** Stokta (available) iken 'voided'e çekilen adet. */
  voided: number;
  /**
   * AKTİF ataması olan — yani hâlâ müşterinin elinde ÇALIŞAN ve elle karar verilmesi gereken
   * adet. (Yorum eskiden "available olmayan" diyordu; SQL hiçbir zaman öyle DEĞİLDİ —
   * `EXISTS assignments.status='active'`. Yanlış yorum, `listBatches`'teki eski `soldCount`
   * hatasının kaynağıydı: okuyanı "durumdan türet" sanısına itiyordu.)
   */
  soldNeedingReplacement: number;
  /**
   * Müşterinin elinde duran TOPLAM adet — aktif + ASKIYA ALINMIŞ atamalar.
   * `listBatches.customerCount` ve parti detayındaki "Müşterilerdeki lisanslar" listesiyle
   * AYNI kümedir. Ayrı durmasının sebebi: geri çekme sonrası bandı "müşterilerde N anahtar
   * var" derken, üstündeki onay modali ve alttaki liste ile FARKLI bir sayı göstermemeli;
   * `soldNeedingReplacement` ise yalnız OTOMATİK değiştirilebilenleri sayar (askıdakiler
   * elle işlenir).
   */
  customerHeld: number;
}

export type AdjustmentAction = 'void' | 'damage' | 'correct' | 'recall';

export interface CreateAdjustmentInput {
  productId: string;
  licenseItemId?: string | null;
  /** Toplu kalem seçimi (envanter listesinden çoklu seçim). licenseItemId ile birlikte GELMEZ. */
  licenseItemIds?: string[] | null;
  action: AdjustmentAction;
  qty: number;
  reason: string;
}

/**
 * Toplu düzeltme sonucu. `affected` GERÇEKTEN stoktan düşen kalem sayısıdır; `skipped`
 * istekte olup dokunulamayanlar (araya giren bir sipariş kalemi kapmış / zaten geçersiz /
 * başka ürüne ait / müşteride CANLI ataması var — C6). İstemci ikisini de gösterir — "N kayıt eklendi" deyip sessizce 3 kalemi
 * atlamak, bozuk anahtarın müşteriye gitmeye devam etmesi demektir.
 */
export interface AdjustmentResult {
  rows: StockAdjustment[];
  requested: number;
  affected: number;
  skipped: number;
  /** Fire olarak deftere yazılan toplam birim (MAK'ta kalan kapasite toplanır). */
  qtyTotal: number;
}

/** Parti listesi satırı (raw JOIN çıktısı → camelCase). */
export interface BatchRow {
  id: string;
  label: string;
  status: string;
  qtyReceived: number;
  receivedAt: string | null;
  notes: string | null;
  supplierId: string | null;
  supplierName: string | null;
  productId: string;
  productSku: string;
  productName: string;
  /**
   * Ürün tipi ('key' | 'account' | 'code' | 'custom'). Parti TEK bir ürüne bağlıdır
   * (`batches.product_id NOT NULL`) → ekran "5 anahtar" mı "5 hesap" mı yazacağını buradan
   * bilir. Panel yalnız anahtar satmıyor; her yere "anahtar" yazmak yanlış (kullanıcı bulgusu).
   */
  productKind: string;
  /** Partideki TOPLAM lisans kalemi (aşağıdaki kovaların toplamı DEĞİL — bkz. MAK notu). */
  totalCount: number;
  /** `status='available'` — geri çekmenin GEÇERSİZ KILACAĞI küme. */
  unsoldCount: number;
  /** CANLI ataması olan (müşteride duran) kalem: assignment.status ∈ (active, suspended). */
  customerCount: number;
  /** Otomatik toplu değiştirmeye ADAY olan (aktif atamalı) kalem — bulkReplaceBatch ile birebir. */
  replaceableCount: number;
  /** Ne stokta ne müşteride: geçersiz kılınmış / karantina / iade / değiştirilmiş / süresi geçmiş. */
  deadCount: number;
}

/**
 * Tedarik operasyonları (§12): parti geri çekme (recall) + sebepli stok düzeltme.
 * W1'in tabloları (batches / suppliers / purchase_orders) ve license_items'a
 * BİLEREK RAW SQL ile dokunulur — bu modül o şema dosyalarına build-bağımlı değildir.
 * Kendi tablosu stock_adjustments (drizzle) + audit_log ile sebep/aktör izini yazar.
 */
@Injectable()
export class SupplyOpsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly adminOrders: AdminOrdersService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  /**
   * Parti listesi — tedarikçi adı + ürün sku/ad JOIN + kalem sayaçları. RAW SQL (batches
   * W1'in dosyası).
   *
   * SAYAÇ TANIMI (kullanıcı bulgusu — eski `sold_count` YANILTICIYDI): sayaç
   * `status <> 'available'` idi, yani ELLE geçersiz kılınmış / karantinaya alınmış / iade
   * edilmiş / değiştirilmiş / süresi geçmiş kalemlerin HEPSİNİ "satılmış" sayıyordu. Ekran
   * "Satılmış 6 birim müşterilerde — bunlar için değişim gerekir" derken müşteride tek bir
   * anahtar bile olmayabiliyordu; `canBulkReplace` de bu sayaca baktığı için değiştirilecek
   * hiçbir şey yokken "Toplu Değiştir" sunuluyordu. Artık kova, kalemin DURUMUNDAN değil
   * ATAMASINDAN türer:
   *   - `unsoldCount`     : status IN ('available','depleted') → geri çekmenin VOID EDECEĞİ küme
   *                         (recallBatch'in yüklemiyle BİREBİR; 'depleted' kapasitesi tükenmiş
   *                         MAK anahtarıdır ve recall onu da void eder).
   *   - `customerCount`   : canlı ataması var (active|suspended) → gerçekten müşteride.
   *   - `replaceableCount`: aktif ataması var → bulkReplaceBatch'in aday kümesiyle BİREBİR
   *                         (askıya alınmış atama otomatik değiştirilmez; elle işlenir).
   *   - `deadCount`       : ne stokta ne müşteride (voided/quarantined/revoked/replaced/expired).
   *
   * BİLİNÇLİ İSTİSNA (G1 — "available" hizalaması buraya UYGULANMAZ): `unsoldCount`
   * "atanabilir stok" DEĞİL, `recallBatch`'in VOID edeceği kümedir (recall, süresi geçmiş
   * available kalemi de void eder — doğrusu budur). Buraya `notExpiredCond` eklenirse ekran
   * "3 stokta" der, geri çekme 5 kalem void eder. Atanabilir stok ürün ekranlarından okunur.
   *
   * MAK NOTU (kovalar TOPLAMI vermez, bilerek): çok-kullanımlı bir anahtar 500 hakkının 3'ü
   * satılmışken hâlâ `status='available'`dır → aynı kalem HEM `unsoldCount` HEM
   * `customerCount` içinde görünür. Bu yüzden `totalCount` ayrı sorulur; ekranlar
   * "toplam = stokta + müşteride + düşmüş" ARİTMETİĞİ KURMAMALI.
   */
  /**
   * TEK parti (detay ekranı). Liste sorgusunun aynısını `id` ile daraltır — sayaç ve alan
   * tanımları tek yerde kalsın diye ayrı bir sorgu YAZILMADI (iki tanım zamanla ayrışır).
   * Bulunamazsa 404.
   */
  async getBatch(id: string): Promise<BatchRow> {
    const { rows } = await this.listBatches(id);
    const row = rows[0];
    if (!row) throw new NotFoundException('Parti bulunamadı');
    return row;
  }

  /**
   * Liste üst sınırı. Sayaç alt-sorgusu ÖNCEDEN `WHERE li.batch_id IS NOT NULL` ile TÜM
   * license_items'ı okuyup her kalem için LATERAL tarama yapıyordu ve dış sorguda LIMIT YOKTU
   * → envanter büyüdükçe /batches doğrusal yavaşlıyordu. Artık önce parti penceresi seçilir,
   * kalem taraması O pencereye kapsanır. Kırpma SESSİZ DEĞİL: `truncated` ile raporlanır.
   */
  private static readonly BATCH_LIST_LIMIT = 500;

  /**
   * @param onlyId    Tek parti (detay ekranı) — süzgeç LIMIT'ten önce uygulanır, `truncated` daima false.
   * @param productId ÜRÜN süzgeci (stok girişi ekranındaki parti seçicisi). SUNUCUDA süzülür ve
   *   üst sınır O ÜRÜNÜN partilerine uygulanır. Süzme yalnız istemcide kalsaydı (eski davranış),
   *   ürünün AKTİF partisi global "en yeni 500" penceresinin dışında kaldığında seçicide HİÇ
   *   görünmez ve operatöre yanlışlıkla "bu ürünün aktif partisi yok" denirdi. Bu yüzden koşul
   *   `picked` CTE'sinin WHERE'ine (LIMIT'ten ÖNCE) iner, dış SELECT'e değil.
   */
  async listBatches(
    onlyId?: string,
    productId?: string,
  ): Promise<{ rows: BatchRow[]; truncated: boolean }> {
    const list = await rawRows<{
      id: string;
      label: string;
      status: string;
      qty_received: number;
      received_at: string | null;
      notes: string | null;
      supplier_id: string | null;
      supplier_name: string | null;
      product_id: string;
      product_sku: string;
      product_name: string;
      product_kind: string;
      total_count: number;
      unsold_count: number;
      customer_count: number;
      replaceable_count: number;
      dead_count: number;
    }>(this.db, sql`
      WITH picked AS (
        -- Parti PENCERESİ önce seçilir; hem dış liste hem sayaç taraması bu kümeye kapsanır.
        -- Tie-break (b.id) ŞART: LIMIT'li bir ORDER BY'da eşit received_at satırlarında pencere
        -- sınırı keyfi kalırdı (proje dersi: LIMIT'li her ORDER BY'ın tie-break'i olmalı).
        -- NULLS sırası DEĞİŞMEDİ (DESC → NULLS FIRST, eski davranış).
        --
        -- LIMIT = TAVAN + 1 (proje deseni: pending-lines.service / readonly-sql — "tavan+1 çek,
        -- JS'te kırp"). Eskiden LIMIT TAVAN + (truncated = n >= TAVAN) idi: TAM 500 parti
        -- varken hiçbir şey kırpılmamışken "liste eksik" uyarısı basılıyordu (yanlış alarm →
        -- operatör GERÇEK kırpmaya da inanmaz). Fazladan satır ORDER BY tie-break'i (b.id)
        -- sayesinde deterministiktir.
        SELECT b.id
        FROM batches b
        WHERE ${onlyId ? sql`b.id = ${onlyId}` : sql`true`}
          AND ${productId ? sql`b.product_id = ${productId}` : sql`true`}
        ORDER BY b.received_at DESC, b.id DESC
        LIMIT ${SupplyOpsService.BATCH_LIST_LIMIT + 1}
      )
      SELECT
        b.id,
        b.label,
        b.status,
        b.qty_received,
        b.received_at,
        b.notes,
        b.supplier_id,
        s.name AS supplier_name,
        b.product_id,
        p.sku AS product_sku,
        p.name AS product_name,
        p.kind::text AS product_kind,
        coalesce(c.total_c, 0)::int      AS total_count,
        coalesce(c.unsold_c, 0)::int     AS unsold_count,
        coalesce(c.customer_c, 0)::int   AS customer_count,
        coalesce(c.replaceable_c, 0)::int AS replaceable_count,
        coalesce(c.dead_c, 0)::int       AS dead_count
      FROM batches b
      JOIN picked pk ON pk.id = b.id
      LEFT JOIN suppliers s ON s.id = b.supplier_id
      JOIN products p ON p.id = b.product_id
      LEFT JOIN (
        SELECT
          li.batch_id,
          count(*) AS total_c,
          -- (DİKKAT: bu blok bir sql şablonunun İÇİNDE — ters tırnak KULLANMA.)
          -- KÜME recallBatch'in VOID ETTİĞİYLE BİREBİR OLMALI: orada yüklem
          -- status IN ('available','depleted'). Sayaç yalnız 'available' sayıyordu →
          -- kapasitesi tamamen satılmış (depleted) MAK anahtarları taşıyan bir partide ekran
          -- "Stokta 0" derken onay modali "0 anahtar geçersiz kılınacak" diyor, geri çekme ise
          -- o anahtarları void edip Kusurlu Stok havuzuna düşürüyordu — operatör GERİ ALINAMAZ
          -- kararı yanlış sayıyla veriyordu. ("satılmış 6 birim" hatasının aynı sınıfı.)
          count(*) FILTER (WHERE li.status IN ('available', 'depleted')) AS unsold_c,
          count(*) FILTER (WHERE ag.has_live) AS customer_c,
          -- bulkReplaceBatch'in ADAY kümesiyle BİREBİR: aktif atama + available OLMAYAN kalem
          -- + tek-kullanımlık ürün. Üçü de o sorguda var (aşağıdaki candidates + 'multi' elemesi);
          -- burada eksik bırakılırsa MAK partisinde "Toplu Değiştir" menüsü açılır ve işlem
          -- "0/1 değiştirildi" der — yani bu turda düzeltilen hatanın MAK'taki tekrarı olurdu.
          count(*) FILTER (
            WHERE ag.has_active AND li.status <> 'available' AND p.usage_mode <> 'multi'
          ) AS replaceable_c,
          count(*) FILTER (WHERE li.status <> 'available' AND NOT ag.has_live) AS dead_c
        FROM license_items li
        JOIN products p ON p.id = li.product_id
        -- Kalem başına TEK atama taraması: üç ayrı korele EXISTS satır başına 3 index
        -- probe'u demekti (agregat FILTER içindeki sublink semi-join'e çevrilemez).
        -- LATERAL + bool_or ile aynı bilgi tek geçişte çıkar. coalesce ŞART: atama yoksa
        -- bool_or NULL döner, NOT NULL de NULL'dur → atamasız (ör. geçersiz kılınmış)
        -- kalemler dead_c'ye HİÇ girmezdi.
        LEFT JOIN LATERAL (
          SELECT
            coalesce(bool_or(a.status = 'active'), false) AS has_active,
            coalesce(bool_or(a.status IN ('active', 'suspended')), false) AS has_live
          FROM assignments a
          WHERE a.license_item_id = li.id
        ) ag ON true
        -- Süzgeç ALT SORGUYA da iner (tek parti VE liste yolunda): aksi halde /batches[/[id]]
        -- her açılışta TÜM license_items'ı gruplayıp sonra ihtiyacı olan satırları seçerdi.
        -- IN (picked) NULL batch_id'yi zaten dışlar (eski IS NOT NULL koşulunu kapsar).
        WHERE li.batch_id IN (SELECT id FROM picked)
        GROUP BY li.batch_id
      ) c ON c.batch_id = b.id
      ORDER BY b.received_at DESC, b.id DESC;
    `);

    // KIRPILMA (DÜRÜSTLÜK): sinyal HAM SQL satır sayısından türer (JS süzme yok, birebir aynı sayı).
    // TAVAN+1 çekildiği için `>` KESİN sinyaldir: tam TAVAN kadar satır varken uyarı BASILMAZ.
    // `onlyId` yolu tek satır döndürür → limitten etkilenmez, daima false.
    const truncated = !onlyId && list.length > SupplyOpsService.BATCH_LIST_LIMIT;

    // Tespit için çekilen fazladan satır YANITA GİRMEZ (sözleşme: en fazla TAVAN satır).
    const rows = list.slice(0, SupplyOpsService.BATCH_LIST_LIMIT).map((r) => ({
      id: r.id,
      label: r.label,
      status: r.status,
      qtyReceived: Number(r.qty_received),
      receivedAt: r.received_at,
      notes: r.notes,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      productId: r.product_id,
      productSku: r.product_sku,
      productName: r.product_name,
      productKind: r.product_kind,
      totalCount: Number(r.total_count),
      unsoldCount: Number(r.unsold_count),
      customerCount: Number(r.customer_count),
      replaceableCount: Number(r.replaceable_count),
      deadCount: Number(r.dead_count),
    }));
    return { rows, truncated };
  }

  /**
   * Parti geri çekme (§12). Parti 'recalled' olur; satılmamış (available) lisanslar
   * 'voided'e çekilir (hak geri gelmez, §2 iptal statüsü); her biri için sebepli
   * stock_adjustments('recall') + toplu audit_log. Satılmış adet elle değiştirme
   * için raporlanır. Tümü tek transaction — kısmi bırakma yok.
   */
  async recallBatch(batchId: string, reason: string, actor: string): Promise<RecallResult> {
    return this.db.transaction(async (tx) => {
      // Parti var mı + zaten çekilmiş mi? FOR UPDATE ile satır KİLİDİ guard'dan ÖNCE alınır:
      // eşzamanlı iki recall'da ikincisi bloklanır, kilit gelince 'recalled' okur ve idempotent
      // BadRequestException atar (kilitsiz SELECT'te ikisi de geçip ikinci çift audit yazardı).
      const batchRows = await rawRows<{ id: string; status: string }>(tx, sql`
        SELECT id, status FROM batches WHERE id = ${batchId} LIMIT 1 FOR UPDATE;
      `);
      const batch = batchRows[0];
      if (!batch) throw new NotFoundException('Parti bulunamadı');
      if (batch.status === 'recalled') {
        throw new BadRequestException('Parti zaten geri çekilmiş');
      }

      // Parti durumu → recalled.
      await tx.execute(sql`UPDATE batches SET status = 'recalled' WHERE id = ${batchId};`);

      /*
       * Satılmamış (available) + TÜKENMİŞ (depleted) lisanslar → voided; id + product_id +
       * KALAN KAPASİTE geri al. remaining = max_uses - use_count: tek-kullanımda 1
       * (max_uses=1, use_count=0 → davranış korunur); multi/MAK'ta yok edilen gerçek kapasite.
       *
       * C5 — NEDEN 'depleted' DE DAHİL (geri çekilen partiden yeniden satış açığı):
       * Eskiden yalnız `available` kalemler void'leniyordu. MAK/çok-kullanımlık bir anahtar
       * kapasitesi dolunca `depleted` olur ve recall ona DOKUNMUYORDU; sonra MEŞRU bir kapasite
       * iadesi (değişim / adet-düşür / recall-bulkReplace yollarındaki
       * `use_count -= units, depleted → available`) o anahtarı SATIŞ HAVUZUNA geri sokuyordu →
       * geri çekilmiş (kusurlu) partiden yeni müşteriye anahtar teslim edilebiliyordu.
       * `voided` durumundaki kalem o CASE ifadesinin ('depleted' → 'available') dışında kalır,
       * yani kapasite iadesi artık onu diriltemez.
       *
       * NEDEN BURADA, `assign.ts` YÜKLEMİNDE DEĞİL: tek-kaynak açısından atama sorgusuna
       * "partisi recalled değil" koşulu eklemek daha temiz olurdu; ama o sorgu sistemin en sıcak
       * yolu (FOR UPDATE SKIP LOCKED) ve `batches`'e JOIN + yeni bir index gerektirirdi. Recall
       * NADİR ve TOPLU bir olaydır → durumu kalem üzerinde bir kez yazmak, her atamada bir join
       * ödemekten hem ucuz hem geriye dönük güvenli (mevcut atama yüklemleri `status='available'`
       * zaten süzüyor). Şema/migration GEREKMEZ.
       *
       * MÜŞTERİYİ ETKİLEMEZ: `getDeliveries` atama durumuna bakar, `license_items.status`'a
       * değil → müşterideki canlı lisans çalışmaya devam eder (§15 "insan onaylar": elle
       * değiştirme `soldNeedingReplacement` ile raporlanır). `dead_count`/`customer_count`
       * sayaçları da `status <> 'available'` tabanlı olduğundan değişmez.
       */
      const voided = await rawRows<{ id: string; product_id: string; remaining: number }>(tx, sql`
        UPDATE license_items
        SET status = 'voided'
        WHERE batch_id = ${batchId} AND status IN ('available', 'depleted')
        RETURNING id, product_id, (max_uses - use_count) AS remaining;
      `);

      // Satılmış + hâlâ CANLI (aktif atamalı) kalemler — elle değiştirme gerektirenler.
      // (status<>'available' KULLANMA: aynı tx'te 'voided'e çekilenler + terminal statüler —
      // quarantined/revoked/replaced/expired — yanlış sayılır. Aktif atama = sold+canlı, audit bulgusu.)
      const soldRows = await rawRows<{ active_c: number; live_c: number }>(tx, sql`
        SELECT
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM assignments a
            WHERE a.license_item_id = li.id AND a.status = 'active'
          ))::int AS active_c,
          count(*) FILTER (WHERE EXISTS (
            SELECT 1 FROM assignments a
            WHERE a.license_item_id = li.id AND a.status IN ('active', 'suspended')
          ))::int AS live_c
        FROM license_items li
        WHERE li.batch_id = ${batchId};
      `);
      const soldNeedingReplacement = Number(soldRows[0]?.active_c ?? 0);
      const customerHeld = Number(soldRows[0]?.live_c ?? 0);

      /*
       * Her void edilen lisans için sebepli stok düzeltmesi (§12 — sebepsiz değişiklik yok).
       * qty = kalan kapasite (tek-kullanım→1, multi/MAK→max_uses-use_count) → CostsService.wastage
       * gerçek yok edilen birim(ler)i değerler, sabit 1 değil.
       *
       * C5 yan etkisi: kümeye giren `depleted` MAK anahtarında remaining = 0'dır — HİÇBİR kapasite
       * ziyan olmadı, hepsi zaten SATILDI. Eski defansif `<=0 ise 1` kuralı burada YANLIŞ olurdu
       * (satılmış her MAK anahtarı için 1 birim hayalet fire → zayi/maliyet raporu şişer). Bu
       * yüzden taban 0'a çekildi; `available` kalemde davranış BİREBİR aynı (o kalemde
       * use_count < max_uses olduğundan remaining her zaman ≥ 1). Kayıt yine YAZILIR: karantina
       * ekranı iptal SEBEBİNİ `stock_adjustments`ten okur, satır atlanırsa sebep '—' görünürdü.
       */
      // CHUNK: satır başına 6 bind parametresi → int16 sınırı (65534) ~10.922 satırda dolar ve
      // TÜM geri çekme transaction'ı düşerdi (parti `recalled` bile olmazdı). Stok girişindeki
      // aynı tuzağın kardeşi; eşik daha yüksek olduğu için gözden kaçmıştı.
      const ADJ_INSERT_CHUNK = 2000;
      for (let i = 0; i < voided.length; i += ADJ_INSERT_CHUNK) {
        await tx.insert(stockAdjustments).values(
          voided.slice(i, i + ADJ_INSERT_CHUNK).map((v) => ({
            productId: v.product_id,
            licenseItemId: v.id,
            action: 'recall' as const,
            qty: Math.max(0, Number(v.remaining)),
            reason,
            actor,
          })),
        );
      }

      // Toplu recall audit izi. (Not: özel 'recall' audit_action enum'u yok → 'revoke' +
      // meta.op; orkestratör enum ekleyince 'recall'a çevrilebilir.)
      await tx.insert(auditLog).values({
        action: 'recall',
        actor,
        targetType: 'batch',
        targetId: batchId,
        meta: { voided: voided.length, soldNeedingReplacement, customerHeld, reason },
      });

      return { voided: voided.length, soldNeedingReplacement, customerHeld };
    });
  }

  /**
   * Toplu değiştirme (§13). Bir partiye ait SATILMIŞ (available olmayan) kalemlerin
   * AKTİF atamalarını, MEVCUT değişim makinesiyle (replacements.approve DESENİ) sırayla
   * yenisiyle değiştirir: her aday için stok ön-kontrol → revokeAssignment('replace')
   * → completeLine(lineId, 1). Stok biten kalem ATLANIR (eski atama korunur — müşteri
   * boşta bırakılmaz). Atama çekirdeği (SKIP LOCKED/idempotency) yeniden yazılmaz, KULLANILIR.
   * Tek büyük transaction DEĞİL: her kalem replacements.approve gibi kendi transaction'ında
   * işlenir (kısmi ilerleme, batch operasyonu için kabul edilir).
   */
  async bulkReplaceBatch(batchId: string, actor: string): Promise<BulkReplaceResult> {
    // Parti var mı + GERİ ÇEKİLMİŞ mi? (RAW SQL — batches W1'in dosyası, import etme.)
    // Toplu değiştirme YALNIZ recall sonrası çalışır: hedef parti 'recalled' değilse
    // (ör. hâlâ 'active') reddet — aksi halde kusurlu partiden müşteriye yeni key verilebilir.
    const batchRows = await rawRows<{ id: string; status: string }>(this.db, sql`
      SELECT id, status FROM batches WHERE id = ${batchId} LIMIT 1;
    `);
    const batch = batchRows[0];
    if (!batch) {
      throw new NotFoundException('Parti bulunamadı');
    }
    if (batch.status !== 'recalled') {
      throw new BadRequestException(
        'Toplu değiştirme yalnız geri çekilmiş (recalled) partide çalışır',
      );
    }

    // Bu partiye ait SATILMIŞ (status <> 'available') kalemlerin AKTİF atamaları.
    // license_items.batch_id üzerinden; assignments.status = 'active'. RAW SQL.
    const candidates = await rawRows<{
      assignment_id: string;
      line_id: string;
      usage_mode: string;
    }>(this.db, sql`
      SELECT a.id AS assignment_id, a.line_id AS line_id, p.usage_mode AS usage_mode
      FROM license_items li
      JOIN assignments a ON a.license_item_id = li.id
      JOIN products p ON p.id = li.product_id
      WHERE li.batch_id = ${batchId}
        AND li.status <> 'available'
        AND a.status = 'active'
      -- tie-break: aynı siparişin atamaları tek tx'te oluşur → created_at eşit;
      -- li.seq olmadan değiştirme sırası (ve kısmi başarısızlıkta kimin değiştiği) keyfi.
      ORDER BY a.created_at ASC, li.seq ASC;
    `);

    let replaced = 0;
    let skippedNoStock = 0;
    let skippedUnsupported = 0;

    for (const c of candidates) {
      // MAK/çok-kullanımlı: otomatik değişim aynı paylaşımlı anahtarı yeniden atardı (no-op)
      // → atla, elle işlensin (replacements.approve ile tutarlı, audit bulgusu).
      if (c.usage_mode === 'multi') {
        skippedUnsupported++;
        continue;
      }

      // 0) Stok ön-kontrolü: satırın ürününde uygun (available + kapasiteli) stok YOKSA
      // eskiyi REVOKE ETMEDEN atla — müşteriyi boşta bırakma (replacements.approve deseni).
      //
      // KÜME HİZASI (G1): temel yüklem artık fulfillment.allocatableCountForLine ile BİREBİR
      // aynıdır — status='available' + notExpiredCond + use_count < max_uses. `notExpiredCond`
      // eksikken sayım "stok var" diyor, gerçek atama (assign.ts süresi geçmiş kalemi dışlar)
      // 0 döndürüyordu → eski key revoke edilmiş, yenisi gelmemiş oluyordu (müşteri boşta).
      //
      // GLUE NOTU — tek kaynak devri neden ERTELENDİ: bu sayımın allocatableCountForLine'da
      // KARŞILIĞI OLMAYAN iki recall-özel hariç tutması var (hedef partinin kendi key'leri +
      // 'voided' partilerin key'leri). Servise devredersek bu iki koruma KAYBOLUR (kusurlu
      // partiden taze key verilebilir) — yani devir güvenliği GEVŞETİR. Doğru devir:
      // allocatableCountForLine'a opsiyonel "hariç tutulacak parti" parametresi eklenip
      // (excludeBatchId + voided-parti süzgeci) BURASI o servise bağlanmalı; o değişiklik
      // fulfillment.service.ts'i de kapsadığı için bu partinin dosya kapsamı DIŞINDA.
      const availRows = await rawRows<{ n: number }>(this.db, sql`
        SELECT count(*)::int AS n
        FROM license_items li
        JOIN order_lines ol ON ol.id = ${c.line_id}
        WHERE li.product_id = ol.product_id
          AND li.status = 'available'
          -- Stok ömrü (expires_at) dolmuş kalem ATANAMAZ (tek kaynak: assignment/assign.ts).
          AND ${notExpiredCond('li')}
          AND li.use_count < li.max_uses
          -- Değiştirilen key ASLA geri çekilen HEDEF partiden gelmesin. IS DISTINCT FROM:
          -- batch'siz (batch_id NULL, elle girilen) key'ler aday olarak sayılmaya devam eder.
          AND li.batch_id IS DISTINCT FROM ${batchId}
          -- Ve 'voided' (elle geçersiz kılınmış) partilere ait key de aday olmasın.
          AND NOT EXISTS (
            SELECT 1 FROM batches b WHERE b.id = li.batch_id AND b.status = 'voided'
          );
      `);
      const n = Number(availRows[0]?.n ?? 0);
      if (n <= 0) {
        skippedNoStock++;
        continue;
      }

      // ATOMİKLİK (denetim — approve/replaceAssignment H1-atomiklik düzeltmesinin ikizi): revoke +
      // completeLine ARTIK advisory-lock ALTINDA TEK transaction'da koşar. Eskiden ikisi AYRI tx'te
      // commit ediyordu → completeLine SKIP LOCKED çekişmesinde added=0 dönerse (stok VARKEN de
      // dönebilir) eski key çoktan karantinaya düşmüş + yeni key yazılmamış oluyordu (müşteri, recall
      // bağlamında bile, partial-auto refill'ine dek boşta kalıyordu). Artık added<=0 ⇒ throw ⇒
      // rollback ⇒ revoke da geri alınır ⇒ eski key CANLI kalır. markLineCanceled=false: satır
      // yeniden-atanabilir kalır. Yan etkiler (mail/webhook) COMMIT SONRASI (rollback'ta duyurulmaz).
      try {
        const out = await this.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${'replace:' + c.assignment_id}))`,
          );
          const revoked = await this.adminOrders.revokeAssignment(
            c.assignment_id,
            'replace',
            actor,
            false,
            tx,
          );
          // Yarışta başka yol (iade/eşzamanlı değişim) atamayı zaten geri almış → no-op (tx boş commit).
          if ('already' in revoked) return { added: 0, completion: null };
          const res = await this.fulfillment.completeLine(c.line_id, 1, true, tx);
          if (res.added <= 0) {
            // added=0 "stok yok" DEĞİL (SKIP LOCKED çekişmesi olabilir) → throw ⇒ rollback ⇒ eski canlı.
            throw new Error('bulk-replace: atama açılamadı (çekişme/stok)');
          }
          // Soyağacı (§3): eski→yeni assignment_history (recall-toplu-değiştir yolu da izlenir).
          // newAssignmentId KESİN yolla geçilir (bu turda oluşturulan atama) — aksi halde
          // recordReplacementLineage "satırın en yeni aktif ataması" tahmin dalına düşer ve AYNI
          // satırda eşzamanlı bir değişim (replaceAssignment/replacements.approve) koşarsa soyağacı
          // yanlış atamaya bağlanabilir. Diğer üç çağıranla (approve/replaceAssignment) simetri.
          await recordReplacementLineage(tx, {
            lineId: c.line_id,
            oldLicenseItemId: ('licenseItemId' in revoked ? revoked.licenseItemId : null) ?? null,
            newAssignmentId: res.createdAssignmentIds?.[0] ?? null,
            reason: 'recall-bulk-replace',
            actor,
          });
          return { added: res.added, completion: res };
        });
        if (out.added > 0 && out.completion) {
          replaced++;
          await this.fulfillment.emitCompletionEffects(out.completion);
        } else {
          skippedNoStock++;
        }
      } catch {
        // Rollback oldu → eski atama CANLI kaldı (müşteri kaybı yok); sonraki stok girişinde
        // partial-auto meşru şekilde doldurur. Bu adayı "stok yok" say (özet dürüst kalır).
        skippedNoStock++;
      }
    }

    // Toplu değiştirme özeti — audit izi ('replace' audit_action mevcut).
    await this.db.insert(auditLog).values({
      action: 'replace',
      actor,
      targetType: 'batch',
      targetId: batchId,
      meta: { op: 'bulk_replace', total: candidates.length, replaced, skippedNoStock, skippedUnsupported },
    });

    return { total: candidates.length, replaced, skippedNoStock, skippedUnsupported };
  }

  /**
   * Sebepli stok düzeltme (§12) — TEKİL ya da TOPLU.
   *
   * `action` 'void'/'damage' ise seçilen lisans satır(lar)ı 'voided'e çekilir (yalnız
   * `available` iken VE müşteride canlı ataması yokken — C6, tekil yolla parite).
   * Kalem başına AYRI bir `stock_adjustments` satırı yazılır: karantina
   * ekranı sebebi `license_item_id` üzerinden okur, tek toplu satır yazılsaydı iptal edilen
   * anahtarların hiçbirinin sebebi görünmezdi. Hepsi TEK transaction'da.
   *
   * TOPLU YOLDA "hepsi ya da hiçbiri" DEĞİL: araya giren bir sipariş kalemlerden birini
   * kapmışsa (artık 'assigned') o kalem atlanır, kalanlar iptal edilir ve sonuç `skipped`
   * ile dürüstçe raporlanır. Tümü atlanırsa 400 — sessizce "başarılı" demek, bozuk
   * anahtarların stokta kalmaya devam etmesi demekti.
   */
  async createAdjustment(input: CreateAdjustmentInput, actor: string): Promise<AdjustmentResult> {
    const destructive = input.action === 'void' || input.action === 'damage';
    // Tekil alan + toplu dizi tek listede birleşir (controller ikisini birlikte kabul etmez).
    // Tekrarlı id gönderimi aynı kalemi iki kez saymasın diye benzersizleştirilir.
    const ids = Array.from(
      new Set(
        (input.licenseItemIds ?? (input.licenseItemId ? [input.licenseItemId] : [])).filter(Boolean),
      ),
    );

    return this.db.transaction(async (tx) => {
      // Ürün var mı? (RAW SQL — mevcut products tablosu.)
      const prodRows = await rawRows<{ id: string }>(tx, sql`
        SELECT id FROM products WHERE id = ${input.productId} LIMIT 1;
      `);
      if (prodRows.length === 0) {
        throw new NotFoundException('Ürün bulunamadı');
      }

      /*
       * SESSİZ YUTMA KAPATILDI (denetim bulgusu): `correct`/`recall` yıkıcı DEĞİLDİR (kaleme
       * dokunmaz, yalnız defter satırı yazar). Çağıran buna rağmen `licenseItemIds` gönderirse
       * eski kod yalnız `ids[0]`'ı deftere yazıp kalan N−1 id'yi ATIYOR ve yanıtta
       * `requested: 0, affected: 0, skipped: 0` diyerek bunu SÖYLEMİYORDU — bu panelin
       * "sessiz kırpma yasak" kuralının ihlali. Bugün UI bu kombinasyonu göndermiyor ama
       * otoriter kapı sunucuda olmalı; niyet belirsiz olduğu için tahmin etmek yerine reddet.
       */
      if (!destructive && ids.length > 1) {
        throw new BadRequestException(
          `'${input.action}' işlemi kalem seçimiyle kullanılamaz (${ids.length} kalem gönderildi). ` +
            "Kalem bazlı işlem için 'void' veya 'damage' kullanın; defter kaydı için kalem göndermeyin.",
        );
      }

      // ── Kalem-kapsamsız (yalnız defter kaydı: 'correct'/'recall') ──
      if (!destructive || ids.length === 0) {
        const [row] = await tx
          .insert(stockAdjustments)
          .values({
            productId: input.productId,
            licenseItemId: ids[0] ?? null,
            action: input.action,
            qty: input.qty,
            reason: input.reason,
            actor,
          })
          .returning();
        await tx.insert(auditLog).values({
          action: 'adjust',
          actor,
          targetType: ids[0] ? 'license_item' : 'product',
          targetId: ids[0] ?? input.productId,
          meta: { action: input.action, qty: input.qty, reason: input.reason, affectedItem: false },
        });
        return { rows: [row!], requested: 0, affected: 0, skipped: 0, qtyTotal: input.qty };
      }

      // ── Yıkıcı + kalem seçili: TEK UPDATE ile tüm seçim ──
      // Tek turda kilitler; `status='available'` şartı yarışta kapılmış kalemi kendiliğinden
      // eler (RETURNING yalnız gerçekten değişenleri döndürür → atlananlar fark alınarak
      // bulunur, ayrı bir ön SELECT'e ve TOCTOU penceresine gerek yok).
      //
      // DİKKAT — `= ANY(${ids}::uuid[])` KULLANMAYIN: drizzle'ın `sql` şablonunda JS dizisi
      // bu şekilde geçirilince BOZUK SQL üretiliyor (Postgres 42846 "cannot cast").
      // Bu tuzak projede daha önce KVKK anonymize yolunda yaşandı ve orada JOIN'e çevrilmişti;
      // burada tek tek parametreli `IN (...)` listesi kuruluyor (her id ayrı parametre →
      // enjeksiyon yok, plan önbelleği id sayısına göre değişir ama liste ≤500).
      const idList = sql.join(
        ids.map((v) => sql`${v}::uuid`),
        sql`, `,
      );
      /*
       * C6 — "TESLİM EDİLMİŞ Mİ" KONTROLÜ (tekil yolla parite).
       *
       * Tekil `StockService.voidLicenseItem` canlı atama (`active|suspended`) varsa 409 verir;
       * toplu yol yalnız `status='available'` bakıyordu. Bu ikisi MAK/çok-kullanımlıkta AYNI ŞEY
       * DEĞİLDİR: kısmen satılmış bir MAK anahtarı kapasitesi bitene kadar 'available' KALIR.
       * Yani müşterilerde canlı aktivasyonları varken toplu seçimle 'voided' yapılabiliyordu —
       * anahtar envanterden düşer, zayi olarak değerlenir ve karantinada "ölü" görünür, oysa
       * müşteri onu kullanmaya devam eder (tutarsız defter + yanlış maliyet).
       *
       * `NOT EXISTS` UPDATE'in KENDİ koşulunda durur (ayrı ön SELECT + TOCTOU penceresi yok);
       * atlananlar zaten `requested/affected/skipped` ile dürüstçe raporlanıyor — tekil yoldaki
       * 409 mesajının toplu karşılığı budur.
       */
      const updated = await rawRows<{ id: string; max_uses: number; use_count: number }>(tx, sql`
        UPDATE license_items
        SET status = 'voided'
        WHERE id IN (${idList})
          AND product_id = ${input.productId}
          AND status = 'available'
          AND NOT EXISTS (
            SELECT 1 FROM assignments a
            WHERE a.license_item_id = license_items.id
              AND a.status IN ('active', 'suspended')
          )
        RETURNING id, max_uses, use_count;
      `);

      if (updated.length === 0) {
        throw new BadRequestException(
          ids.length === 1
            ? 'Lisans satırı bulunamadı, satılabilir (available) durumda değil ya da müşteride canlı bir ataması var'
            : 'Seçilen lisansların hiçbiri stoktan düşülemedi (satılmış, müşteride canlı ya da zaten geçersiz olabilir)',
        );
      }

      // Fire miktarı FORM'dan DEĞİL, yok edilen kalemin KENDİSİNDEN türetilir: tek-kullanımda 1,
      // MAK/çok-kullanımlıda KALAN kapasite (controller varsayılanı qty=0 → sıfır fire yazardı).
      const rows: StockAdjustment[] = [];
      let qtyTotal = 0;
      for (const item of updated) {
        const remaining = Number(item.max_uses) - Number(item.use_count);
        const qty = remaining > 0 ? remaining : 1;
        qtyTotal += qty;
        const [row] = await tx
          .insert(stockAdjustments)
          .values({
            productId: input.productId,
            licenseItemId: item.id,
            action: input.action,
            qty,
            reason: input.reason,
            actor,
          })
          .returning();
        rows.push(row!);
        await tx.insert(auditLog).values({
          action: 'adjust',
          actor,
          targetType: 'license_item',
          targetId: item.id,
          meta: {
            action: input.action,
            qty,
            reason: input.reason,
            affectedItem: true,
            // Toplu işlemde hangi kalemler birlikte iptal edildi — denetimde tek tıkla izlenebilsin.
            ...(ids.length > 1 ? { bulk: ids.length } : {}),
          },
        });
      }

      return {
        rows,
        requested: ids.length,
        affected: updated.length,
        skipped: ids.length - updated.length,
        qtyTotal,
      };
    });
  }

  /** Sebepli stok düzeltme listesi (opsiyonel ürün filtresi). */
  async listAdjustments(productId?: string): Promise<StockAdjustment[]> {
    if (productId) {
      return this.db
        .select()
        .from(stockAdjustments)
        .where(eq(stockAdjustments.productId, productId))
        .orderBy(desc(stockAdjustments.createdAt));
    }
    return this.db.select().from(stockAdjustments).orderBy(desc(stockAdjustments.createdAt));
  }
}
