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
  /** Satılmamış (available) iken 'voided'e çekilen adet. */
  voided: number;
  /** Satılmış (available olmayan) — elle değiştirme gerektiren adet. */
  soldNeedingReplacement: number;
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
 * başka ürüne ait). İstemci ikisini de gösterir — "N kayıt eklendi" deyip sessizce 3 kalemi
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
  /** batch_id üzerinden satılmamış (available) adet. */
  unsoldCount: number;
  /** batch_id üzerinden satılmış (available olmayan) adet. */
  soldCount: number;
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
   * Parti listesi — tedarikçi adı + ürün sku/ad JOIN; batch_id sayımı ile satılmamış
   * (available) / satılmış (available olmayan) adet. RAW SQL (batches W1'in dosyası).
   *
   * BİLİNÇLİ İSTİSNA (G1 — "available" hizalaması buraya UYGULANMAZ): aşağıdaki iki sayaç
   * "atanabilir stok" DEĞİL, "satılmış mı" ikili ayrımıdır ve `recallBatch`'in geri çekmede
   * VOID edeceği kümeyle eşleşmek zorundadır (recall, süresi geçmiş available kalemi de
   * void eder — doğrusu budur). Buraya `notExpiredCond` eklenirse ekran "3 satılmamış" der,
   * geri çekme 5 kalem void eder; ayrıca iki kova (available / <> available) tüm partiyi
   * bölmeyi bırakır (süresi geçmiş kalemler hiçbir kovaya girmez). Atanabilir stok sayısı
   * ürün ekranlarından (products.list / stock.availableCount) okunur.
   */
  /**
   * TEK parti (detay ekranı). Liste sorgusunun aynısını `id` ile daraltır — sayaç ve alan
   * tanımları tek yerde kalsın diye ayrı bir sorgu YAZILMADI (iki tanım zamanla ayrışır).
   * Bulunamazsa 404.
   */
  async getBatch(id: string): Promise<BatchRow> {
    const rows = await this.listBatches(id);
    const row = rows[0];
    if (!row) throw new NotFoundException('Parti bulunamadı');
    return row;
  }

  async listBatches(onlyId?: string): Promise<BatchRow[]> {
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
      unsold_count: number;
      sold_count: number;
    }>(this.db, sql`
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
        coalesce(unsold.c, 0)::int AS unsold_count,
        coalesce(sold.c, 0)::int AS sold_count
      FROM batches b
      LEFT JOIN suppliers s ON s.id = b.supplier_id
      JOIN products p ON p.id = b.product_id
      LEFT JOIN (
        SELECT batch_id, count(*) AS c FROM license_items
        WHERE status = 'available' GROUP BY batch_id
      ) unsold ON unsold.batch_id = b.id
      LEFT JOIN (
        SELECT batch_id, count(*) AS c FROM license_items
        WHERE status <> 'available' GROUP BY batch_id
      ) sold ON sold.batch_id = b.id
      WHERE ${onlyId ? sql`b.id = ${onlyId}` : sql`true`}
      ORDER BY b.received_at DESC;
    `);
    return list.map((r) => ({
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
      unsoldCount: Number(r.unsold_count),
      soldCount: Number(r.sold_count),
    }));
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

      // Satılmamış (available) lisanslar → voided; id + product_id + KALAN KAPASİTE geri al.
      // remaining = max_uses - use_count: tek-kullanımda 1 (max_uses=1, use_count=0 → davranış
      // korunur); multi/MAK'ta yok edilen gerçek kapasite (fire miktarı hardcoded 1 değil).
      const voided = await rawRows<{ id: string; product_id: string; remaining: number }>(tx, sql`
        UPDATE license_items
        SET status = 'voided'
        WHERE batch_id = ${batchId} AND status = 'available'
        RETURNING id, product_id, (max_uses - use_count) AS remaining;
      `);

      // Satılmış + hâlâ CANLI (aktif atamalı) kalemler — elle değiştirme gerektirenler.
      // (status<>'available' KULLANMA: aynı tx'te 'voided'e çekilenler + terminal statüler —
      // quarantined/revoked/replaced/expired — yanlış sayılır. Aktif atama = sold+canlı, audit bulgusu.)
      const soldRows = await rawRows<{ c: number }>(tx, sql`
        SELECT count(*)::int AS c FROM license_items li
        WHERE li.batch_id = ${batchId}
          AND EXISTS (
            SELECT 1 FROM assignments a
            WHERE a.license_item_id = li.id AND a.status = 'active'
          );
      `);
      const soldNeedingReplacement = Number(soldRows[0]?.c ?? 0);

      // Her void edilen lisans için sebepli stok düzeltmesi (§12 — sebepsiz değişiklik yok).
      // qty = kalan kapasite (tek-kullanım→1, multi/MAK→max_uses-use_count) → CostsService.wastage
      // gerçek yok edilen birim(ler)i değerler, sabit 1 değil. Defansif: <=0 ise 1.
      if (voided.length > 0) {
        await tx.insert(stockAdjustments).values(
          voided.map((v) => ({
            productId: v.product_id,
            licenseItemId: v.id,
            action: 'recall' as const,
            qty: Number(v.remaining) > 0 ? Number(v.remaining) : 1,
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
        meta: { voided: voided.length, soldNeedingReplacement, reason },
      });

      return { voided: voided.length, soldNeedingReplacement };
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
   * `available` iken). Kalem başına AYRI bir `stock_adjustments` satırı yazılır: karantina
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
      // `= ANY(...)` tek turda kilitler; `status='available'` şartı yarışta kapılmış kalemi
      // kendiliğinden eler (RETURNING yalnız gerçekten değişenleri döndürür → atlananlar
      // fark alınarak bulunur, ayrı bir ön SELECT'e ve TOCTOU penceresine gerek yok).
      const updated = await rawRows<{ id: string; max_uses: number; use_count: number }>(tx, sql`
        UPDATE license_items
        SET status = 'voided'
        WHERE id = ANY(${ids}::uuid[])
          AND product_id = ${input.productId}
          AND status = 'available'
        RETURNING id, max_uses, use_count;
      `);

      if (updated.length === 0) {
        throw new BadRequestException(
          ids.length === 1
            ? 'Lisans satırı bulunamadı ya da satılabilir (available) durumda değil'
            : 'Seçilen lisansların hiçbiri stoktan düşülemedi (satılmış ya da zaten geçersiz olabilir)',
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
