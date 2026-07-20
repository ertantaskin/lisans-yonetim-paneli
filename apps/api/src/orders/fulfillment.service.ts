import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { assignments, fulfillmentEvents, orderLines, orders, products } from '../db/schema';
import { ProductsService } from '../products/products.service';
import { MailService } from '../mail/mail.service';
import { WebhookService } from '../webhook/webhook.service';
import { allocate } from '../assignment/allocate';

export interface CompleteResult {
  lineId: string;
  orderId: string;
  requested: number;
  fulfilledBefore: number;
  added: number;
  fulfilledAfter: number;
  status: string;
}

@Injectable()
export class FulfillmentService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly products: ProductsService,
    private readonly mail: MailService,
    private readonly webhook: WebhookService,
  ) {}

  /**
   * Bir sipariş satırının kalanını (veya N adedini) atar (§5, §13 "Kalanları/N Adet Ata").
   * Turlar idempotent değil ama stok kadar atar; stok yoksa added=0.
   */
  async completeLine(lineId: string, maxUnits?: number): Promise<CompleteResult> {
    const result = await this.db.transaction(async (tx) => {
      const [line] = await tx.select().from(orderLines).where(eq(orderLines.id, lineId)).limit(1);
      if (!line) throw new NotFoundException('Sipariş satırı bulunamadı');
      if (!line.productId) {
        return this.noop(line.id, line.orderId, line.qty, line.fulfilledQty, line.status);
      }

      const remaining = line.qty - line.fulfilledQty;
      const toAssign = maxUnits ? Math.min(remaining, maxUnits) : remaining;
      if (toAssign <= 0) {
        return this.noop(line.id, line.orderId, line.qty, line.fulfilledQty, line.status);
      }

      const product = await this.products.getById(line.productId);
      const allocations = await allocate(tx, product, toAssign);
      const added = allocations.reduce((s, a) => s + a.units, 0);

      const validUntil = product.validityDays
        ? new Date(Date.now() + product.validityDays * 86_400_000)
        : null;
      for (const alloc of allocations) {
        await tx.insert(assignments).values({
          orderId: line.orderId,
          lineId: line.id,
          licenseItemId: alloc.licenseItemId,
          units: alloc.units,
          validUntil,
          status: 'active',
          deliveredAt: new Date(),
        });
      }

      const fulfilledAfter = line.fulfilledQty + added;
      const status =
        fulfilledAfter >= line.qty ? 'fulfilled' : fulfilledAfter > 0 ? 'partial' : 'pending';
      await tx
        .update(orderLines)
        .set({ fulfilledQty: fulfilledAfter, status })
        .where(eq(orderLines.id, line.id));

      if (added > 0) {
        await tx.insert(fulfillmentEvents).values({
          orderId: line.orderId,
          type: 'line_completed',
          message: `Satır ${line.remoteLineId}: +${added} atandı (${fulfilledAfter}/${line.qty})`,
        });
      }

      await this.recomputeOrderStatus(tx, line.orderId);

      return {
        lineId: line.id,
        orderId: line.orderId,
        requested: line.qty,
        fulfilledBefore: line.fulfilledQty,
        added,
        fulfilledAfter,
        status,
      };
    });

    // Yeni atama yapıldıysa teslimat/güncelleme mailini kuyruğa al (§6).
    if (result.added > 0) {
      const [order] = await this.db
        .select()
        .from(orders)
        .where(eq(orders.id, result.orderId))
        .limit(1);
      if (order) {
        await this.mail.enqueueDelivery(
          order.id,
          order.customerEmail,
          `Siparişiniz güncellendi — ${order.remoteOrderId}`,
        );
        // Geri kanal webhook — tamamlanma sonrası güncel durum (§2).
        const evt = order.status === 'fulfilled' ? 'order.fulfilled' : 'order.partially_fulfilled';
        await this.webhook.emit(order.siteId, order.id, evt, {
          status: order.status,
          remoteOrderId: order.remoteOrderId,
        });
      }
    }

    return result;
  }

  /**
   * Stok girişinde tetiklenir (§5). partial-auto ürünlerin bekleyen satırlarını
   * FIFO (öncelik desc, created_at asc) tarar ve stok bitene kadar tamamlar.
   */
  async autoCompleteProduct(productId: string): Promise<number> {
    const pending = await this.db
      .select({ id: orderLines.id })
      .from(orderLines)
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(
        and(
          eq(orderLines.productId, productId),
          inArray(orderLines.status, ['pending', 'partial']),
          eq(products.fulfillmentPolicy, 'partial-auto'),
        ),
      )
      .orderBy(sql`${orderLines.priority} desc`, asc(orderLines.createdAt));

    let completedLines = 0;
    for (const { id } of pending) {
      const res = await this.completeLine(id);
      if (res.added > 0) completedLines++;
      if (res.status !== 'fulfilled') break; // stok bitti → sonraki satırlara gerek yok
    }
    return completedLines;
  }

  /** Siparişin tüm satırlarına bakıp genel durumu günceller. */
  private async recomputeOrderStatus(tx: Database, orderId: string): Promise<void> {
    const lines = await tx
      .select({ status: orderLines.status })
      .from(orderLines)
      .where(eq(orderLines.orderId, orderId));

    const anyFulfilled = lines.some((l) => l.status === 'fulfilled' || l.status === 'partial');
    const anyPending = lines.some((l) => l.status === 'pending' || l.status === 'partial');
    const allFulfilled = lines.every((l) => l.status === 'fulfilled');

    const status = allFulfilled
      ? 'fulfilled'
      : anyFulfilled && anyPending
        ? 'partial'
        : anyFulfilled
          ? 'partial'
          : 'pending';

    await tx.update(orders).set({ status }).where(eq(orders.id, orderId));
    if (status === 'fulfilled') {
      await tx.insert(fulfillmentEvents).values({
        orderId,
        type: 'fulfilled',
        message: 'Sipariş tamamlandı',
      });
    }
  }

  private noop(
    lineId: string,
    orderId: string,
    requested: number,
    fulfilled: number,
    status: string,
  ): CompleteResult {
    return {
      lineId,
      orderId,
      requested,
      fulfilledBefore: fulfilled,
      added: 0,
      fulfilledAfter: fulfilled,
      status,
    };
  }
}
