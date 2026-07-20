import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { auditLog } from '../db/schema/audit';
import { stockAdjustments, type StockAdjustment } from '../db/schema/stockAdjustments';

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
  constructor(@Inject(DB) private readonly db: Database) {}

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

      // Satılmış (available olmayan) adet — elle değiştirme gerektirenler.
      const soldRows = await tx.execute<{ c: number }>(sql`
        SELECT count(*)::int AS c FROM license_items
        WHERE batch_id = ${batchId} AND status <> 'available';
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
        action: 'revoke',
        actor,
        targetType: 'batch',
        targetId: batchId,
        meta: { op: 'recall', voided: voided.length, soldNeedingReplacement, reason },
      });

      return { voided: voided.length, soldNeedingReplacement };
    });
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
        action: 'revoke',
        actor,
        targetType: input.licenseItemId ? 'license_item' : 'product',
        targetId: input.licenseItemId ?? input.productId,
        meta: {
          op: 'stock_adjustment',
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
