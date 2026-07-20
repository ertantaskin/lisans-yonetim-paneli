import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { auditLog } from '../db/schema';
import { batches } from '../db/schema/batches';
import { purchaseOrders, type PurchaseOrder } from '../db/schema/purchaseOrders';
import { suppliers } from '../db/schema/suppliers';
// products: yalnız FK/JOIN için okunur (o dosya düzenlenmez).
import { products } from '../db/schema/products';

export type PoStatus = PurchaseOrder['status'];

export interface PurchaseOrderRow extends PurchaseOrder {
  supplierName: string;
  productSku: string;
  productName: string;
}

/**
 * PurchaseOrdersService — satın alma emri (§12). Teslim alma (receive) emri
 * qtyReceived'i artırır, partial/received'a çeker ve YENİ bir parti (batch) kaydı
 * açar. Gerçek key'lerin stok girişi ayrıdır (stock.import; batchId ile bağlanır).
 */
@Injectable()
export class PurchaseOrdersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Tedarikçi adı + ürün sku/name JOIN'li liste. */
  async list(): Promise<PurchaseOrderRow[]> {
    const rows = await this.db
      .select({
        po: purchaseOrders,
        supplierName: suppliers.name,
        productSku: products.sku,
        productName: products.name,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .innerJoin(products, eq(purchaseOrders.productId, products.id))
      .orderBy(desc(purchaseOrders.createdAt));

    return rows.map((r) => ({
      ...r.po,
      supplierName: r.supplierName,
      productSku: r.productSku,
      productName: r.productName,
    }));
  }

  async getById(id: string): Promise<PurchaseOrderRow> {
    const [row] = await this.db
      .select({
        po: purchaseOrders,
        supplierName: suppliers.name,
        productSku: products.sku,
        productName: products.name,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .innerJoin(products, eq(purchaseOrders.productId, products.id))
      .where(eq(purchaseOrders.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Satın alma emri bulunamadı');
    return {
      ...row.po,
      supplierName: row.supplierName,
      productSku: row.productSku,
      productName: row.productName,
    };
  }

  async create(input: {
    supplierId: string;
    productId: string;
    status?: 'draft' | 'ordered';
    qtyOrdered: number;
    unitCostCents?: number;
    currency?: string;
    eta?: string;
    notes?: string;
  }): Promise<PurchaseOrder> {
    const status = input.status ?? 'draft';
    const [row] = await this.db
      .insert(purchaseOrders)
      .values({
        supplierId: input.supplierId,
        productId: input.productId,
        status,
        qtyOrdered: input.qtyOrdered,
        unitCostCents: input.unitCostCents ?? null,
        currency: input.currency ?? 'TRY',
        eta: input.eta ? new Date(input.eta) : null,
        // Sipariş verildiyse zaman damgası düş (draft'ta null).
        orderedAt: status === 'ordered' ? new Date() : null,
        notes: input.notes ?? null,
      })
      .returning();
    return row!;
  }

  /** Kısmi güncelleme: status/eta/notes. draft→ordered geçişinde orderedAt işaretlenir. */
  async update(
    id: string,
    patch: { status?: PoStatus; eta?: string | null; notes?: string | null },
  ): Promise<PurchaseOrder> {
    const current = await this.getById(id);
    const set: Partial<typeof purchaseOrders.$inferInsert> = { updatedAt: new Date() };
    if (patch.status !== undefined) {
      set.status = patch.status;
      if (patch.status === 'ordered' && current.orderedAt == null) set.orderedAt = new Date();
    }
    if (patch.eta !== undefined) set.eta = patch.eta ? new Date(patch.eta) : null;
    if (patch.notes !== undefined) set.notes = patch.notes;

    const [row] = await this.db
      .update(purchaseOrders)
      .set(set)
      .where(eq(purchaseOrders.id, id))
      .returning();
    return row!;
  }

  /**
   * Teslim alma (§12). Kabul edilen adet = min(qty, kalan). qtyReceived artar,
   * status kalan==0 ise 'received', değilse 'partial'. YENİ parti (batch) kaydı açılır.
   * Sebep/aktör audit_log'a düşer. Tümü tek transaction + satır kilidi (FOR UPDATE) ile
   * — eşzamanlı teslim almalar over-receive yapamaz.
   */
  async receive(
    id: string,
    input: { qty: number; batchLabel: string; notes?: string },
  ): Promise<{ purchaseOrder: PurchaseOrder; batchId: string; accepted: number }> {
    if (input.qty <= 0) throw new BadRequestException('qty > 0 olmalı');

    return this.db.transaction(async (tx) => {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, id))
        .for('update')
        .limit(1);
      if (!po) throw new NotFoundException('Satın alma emri bulunamadı');
      if (po.status === 'cancelled')
        throw new BadRequestException('İptal edilmiş emre teslim alınamaz');

      const remaining = po.qtyOrdered - po.qtyReceived;
      if (remaining <= 0) throw new BadRequestException('Emir zaten tamamen teslim alınmış');

      const accepted = Math.min(input.qty, remaining);
      const newReceived = po.qtyReceived + accepted;
      const newStatus: PoStatus = newReceived >= po.qtyOrdered ? 'received' : 'partial';
      const now = new Date();

      const [updated] = await tx
        .update(purchaseOrders)
        .set({
          qtyReceived: newReceived,
          status: newStatus,
          receivedAt: now,
          updatedAt: now,
        })
        .where(eq(purchaseOrders.id, id))
        .returning();

      // Teslim alınan partiyi kaydet (gerçek key'lerin stok girişi ayrı: stock.import).
      const [batch] = await tx
        .insert(batches)
        .values({
          supplierId: po.supplierId,
          purchaseOrderId: po.id,
          productId: po.productId,
          label: input.batchLabel,
          qtyReceived: accepted,
          notes: input.notes ?? null,
        })
        .returning({ id: batches.id });

      // Sebepli/aktörlü denetim izi (§12): PO teslim-alma.
      await tx.insert(auditLog).values({
        action: 'receive',
        actor: 'panel:admin',
        targetType: 'purchase_order',
        targetId: po.id,
        meta: {
          kind: 'po_receive',
          accepted,
          qtyReceived: newReceived,
          qtyOrdered: po.qtyOrdered,
          status: newStatus,
          batchId: batch!.id,
          batchLabel: input.batchLabel,
        },
      });

      return { purchaseOrder: updated!, batchId: batch!.id, accepted };
    });
  }
}
