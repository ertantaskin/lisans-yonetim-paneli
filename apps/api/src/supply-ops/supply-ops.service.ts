import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { auditLog } from '../db/schema/audit';
import { stockAdjustments, type StockAdjustment } from '../db/schema/stockAdjustments';
import { AdminOrdersService } from '../orders/admin-orders.service';
import { FulfillmentService } from '../orders/fulfillment.service';

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
  action: AdjustmentAction;
  qty: number;
  reason: string;
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
   */
  async listBatches(): Promise<BatchRow[]> {
    const rows = await this.db.execute<{
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
    }>(sql`
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
      ORDER BY b.received_at DESC;
    `);
    const list = rows as unknown as Array<{
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
    }>;
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
      // Parti var mı + zaten çekilmiş mi? (RAW SQL — batches W1'in dosyası, import etme.)
      const batchRows = await tx.execute<{ id: string; status: string }>(sql`
        SELECT id, status FROM batches WHERE id = ${batchId} LIMIT 1;
      `);
      const batch = (batchRows as unknown as Array<{ id: string; status: string }>)[0];
      if (!batch) throw new NotFoundException('Parti bulunamadı');
      if (batch.status === 'recalled') {
        throw new BadRequestException('Parti zaten geri çekilmiş');
      }

      // Parti durumu → recalled.
      await tx.execute(sql`UPDATE batches SET status = 'recalled' WHERE id = ${batchId};`);

      // Satılmamış (available) lisanslar → voided; id + product_id geri al.
      const voidedRows = await tx.execute<{ id: string; product_id: string }>(sql`
        UPDATE license_items
        SET status = 'voided'
        WHERE batch_id = ${batchId} AND status = 'available'
        RETURNING id, product_id;
      `);
      const voided = voidedRows as unknown as Array<{ id: string; product_id: string }>;

      // Satılmış + hâlâ CANLI (aktif atamalı) kalemler — elle değiştirme gerektirenler.
      // (status<>'available' KULLANMA: aynı tx'te 'voided'e çekilenler + terminal statüler —
      // quarantined/revoked/replaced/expired — yanlış sayılır. Aktif atama = sold+canlı, audit bulgusu.)
      const soldRows = await tx.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM license_items li
        WHERE li.batch_id = ${batchId}
          AND EXISTS (
            SELECT 1 FROM assignments a
            WHERE a.license_item_id = li.id AND a.status = 'active'
          );
      `);
      const soldNeedingReplacement = Number(
        (soldRows as unknown as Array<{ c: number }>)[0]?.c ?? 0,
      );

      // Her void edilen lisans için sebepli stok düzeltmesi (§12 — sebepsiz değişiklik yok).
      if (voided.length > 0) {
        await tx.insert(stockAdjustments).values(
          voided.map((v) => ({
            productId: v.product_id,
            licenseItemId: v.id,
            action: 'recall' as const,
            qty: 1,
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
    const batchRows = await this.db.execute<{ id: string; status: string }>(sql`
      SELECT id, status FROM batches WHERE id = ${batchId} LIMIT 1;
    `);
    const batch = (batchRows as unknown as Array<{ id: string; status: string }>)[0];
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
    const candRows = await this.db.execute<{
      assignment_id: string;
      line_id: string;
      usage_mode: string;
    }>(sql`
      SELECT a.id AS assignment_id, a.line_id AS line_id, p.usage_mode AS usage_mode
      FROM license_items li
      JOIN assignments a ON a.license_item_id = li.id
      JOIN products p ON p.id = li.product_id
      WHERE li.batch_id = ${batchId}
        AND li.status <> 'available'
        AND a.status = 'active'
      ORDER BY a.created_at ASC;
    `);
    const candidates = candRows as unknown as Array<{
      assignment_id: string;
      line_id: string;
      usage_mode: string;
    }>;

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
      const availRows = await this.db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n
        FROM license_items li
        JOIN order_lines ol ON ol.id = ${c.line_id}
        WHERE li.product_id = ol.product_id
          AND li.status = 'available'
          AND li.use_count < li.max_uses
          -- Değiştirilen key ASLA geri çekilen HEDEF partiden gelmesin. IS DISTINCT FROM:
          -- batch'siz (batch_id NULL, elle girilen) key'ler aday olarak sayılmaya devam eder.
          AND li.batch_id IS DISTINCT FROM ${batchId}
          -- Ve 'voided' (elle geçersiz kılınmış) partilere ait key de aday olmasın.
          AND NOT EXISTS (
            SELECT 1 FROM batches b WHERE b.id = li.batch_id AND b.status = 'voided'
          );
      `);
      const n = Number((availRows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
      if (n <= 0) {
        skippedNoStock++;
        continue;
      }

      // 1) Eskiyi geri al (single → karantina, multi → kapasite iadesi; audit'e düşer).
      // markLineCanceled=false: recall/bulkReplace da revoke sonrası MEŞRU yeniden-atama yapar
      // (değişim deseni); satır 'canceled' işaretlenirse completeLine no-op eder → yanlış "stok yok".
      await this.adminOrders.revokeAssignment(c.assignment_id, 'replace', actor, false);

      // 2) Yenisini ata — açılan yere 1 birim (atomik atama makinesi). Stok araya girip
      // tükendiyse added=0 dönebilir → o kalemi atlanmış say (eski zaten revoke edildi;
      // completeLine sonraki stok girişinde partial-auto ile tamamlanabilir).
      const res = await this.fulfillment.completeLine(c.line_id, 1);
      if (res.added > 0) {
        replaced++;
      } else {
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
   * Sebepli stok düzeltme (§12). licenseItemId verilip action 'void'/'damage' ise o
   * lisans satırı 'voided'e çekilir (yalnız available iken). Her düzeltme sebep + aktör
   * ile stock_adjustments'a ve audit_log'a yazılır. Tek transaction.
   */
  async createAdjustment(input: CreateAdjustmentInput, actor: string): Promise<StockAdjustment> {
    return this.db.transaction(async (tx) => {
      // Ürün var mı? (RAW SQL — mevcut products tablosu.)
      const prodRows = await tx.execute<{ id: string }>(sql`
        SELECT id FROM products WHERE id = ${input.productId} LIMIT 1;
      `);
      if ((prodRows as unknown as Array<{ id: string }>).length === 0) {
        throw new NotFoundException('Ürün bulunamadı');
      }

      // Lisans satırını iptal statüsüne çek (yalnız void/damage + item verildiyse).
      let affectedItem = false;
      if (input.licenseItemId && (input.action === 'void' || input.action === 'damage')) {
        const upd = await tx.execute<{ id: string }>(sql`
          UPDATE license_items
          SET status = 'voided'
          WHERE id = ${input.licenseItemId}
            AND product_id = ${input.productId}
            AND status = 'available'
          RETURNING id;
        `);
        if ((upd as unknown as Array<{ id: string }>).length === 0) {
          throw new BadRequestException(
            'Lisans satırı bulunamadı ya da satılabilir (available) durumda değil',
          );
        }
        affectedItem = true;
      }

      const [row] = await tx
        .insert(stockAdjustments)
        .values({
          productId: input.productId,
          licenseItemId: input.licenseItemId ?? null,
          action: input.action,
          qty: input.qty,
          reason: input.reason,
          actor,
        })
        .returning();

      await tx.insert(auditLog).values({
        action: 'adjust',
        actor,
        targetType: input.licenseItemId ? 'license_item' : 'product',
        targetId: input.licenseItemId ?? input.productId,
        meta: {
          action: input.action,
          qty: input.qty,
          reason: input.reason,
          affectedItem,
        },
      });

      return row!;
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
