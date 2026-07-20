import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  AssignmentResult,
  OrderLineResult,
} from '@jetlisans/shared';
import { ORDER_HTTP_STATUS } from '@jetlisans/shared';
import { NotFoundException } from '@nestjs/common';
import { DB, type Database } from '../db/db.module';
import {
  assignments,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
  type Order,
  type Site,
} from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { ProductsService } from '../products/products.service';
import {
  assignAvailableSingleUse,
  consumeMultiUseCapacity,
  releaseToAvailable,
} from '../assignment/assign';

export interface CreateOrderOutcome {
  httpStatus: number;
  body: CreateOrderResponse;
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly products: ProductsService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * Müşteri teslimat ekranı (§7): YALNIZ aktif atamalar, payload SQL seviyesinde
   * çözülür. revoked/suspended atamalar burada hiç dönmez ("frontend gizleme" değil).
   * Site scope zorunlu — başka sitenin siparişi görünmez.
   */
  async getDeliveries(site: Site, orderId: string) {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.siteId, site.id)))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const rows = await this.db
      .select({
        assignmentId: assignments.id,
        remoteLineId: orderLines.remoteLineId,
        units: assignments.units,
        validUntil: assignments.validUntil,
        payloadEnc: licenseItems.payloadEnc,
      })
      .from(assignments)
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .where(and(eq(assignments.orderId, order.id), eq(assignments.status, 'active')));

    return {
      orderId: order.id,
      status: order.status,
      deliveries: rows.map((r) => ({
        assignmentId: r.assignmentId,
        remoteLineId: r.remoteLineId,
        units: r.units,
        validUntil: r.validUntil ? r.validUntil.toISOString() : null,
        payload: this.crypto.decrypt(r.payloadEnc),
      })),
    };
  }

  /**
   * Sipariş bildirimi (§2, §4). Atomik atama + idempotency + kısmi teslimat.
   * Tüm işlem tek transaction'da: FOR UPDATE SKIP LOCKED kilitleri sipariş
   * commit'lenene kadar tutulur → çifte satış imkânsız, kısmi teslimat tutarlı.
   */
  async createOrder(site: Site, dto: CreateOrderRequest): Promise<CreateOrderOutcome> {
    // Idempotency: aynı site+sipariş tekrar gelirse mevcut sonucu döndür (§4).
    const existing = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.siteId, site.id), eq(orders.remoteOrderId, dto.remoteOrderId)))
      .limit(1);
    if (existing[0]) {
      return this.buildOutcome(await this.loadOrderResult(existing[0]));
    }

    const idempotencyKey = `${site.id}:${dto.remoteOrderId}`;

    const result = await this.db.transaction(async (tx) => {
      // Sipariş kaydı (idempotency_key UNIQUE — yarışta tek kazanır).
      let order: Order;
      try {
        const [row] = await tx
          .insert(orders)
          .values({
            siteId: site.id,
            remoteOrderId: dto.remoteOrderId,
            customerEmail: dto.customerEmail,
            status: 'pending',
            idempotencyKey,
          })
          .returning();
        order = row!;
      } catch {
        // Eşzamanlı ikizde UNIQUE ihlali → mevcut siparişi döndür.
        const [row] = await tx
          .select()
          .from(orders)
          .where(eq(orders.idempotencyKey, idempotencyKey))
          .limit(1);
        return this.loadOrderResult(row!);
      }

      await tx.insert(fulfillmentEvents).values({
        orderId: order.id,
        type: 'order_received',
        message: `${dto.lines.length} satır bildirildi`,
      });

      const assignmentResults: AssignmentResult[] = [];
      const lineResults: OrderLineResult[] = [];
      let anyFulfilled = false;
      let anyMappedPending = false;
      let anyUnmapped = false;

      for (const line of dto.lines) {
        const mapping = await this.products.resolveMapping(
          site.id,
          line.remoteProductId,
          line.remoteVariationId,
        );

        if (!mapping) {
          // Eşleme yok — sipariş kaybolmaz, satır product_id=null pending kalır (§4).
          await tx.insert(orderLines).values({
            orderId: order.id,
            productId: null,
            remoteLineId: line.remoteLineId,
            qty: line.qty,
            status: 'pending',
          });
          lineResults.push({
            remoteLineId: line.remoteLineId,
            status: 'pending',
            requestedQty: line.qty,
            fulfilledQty: 0,
          });
          anyUnmapped = true;
          continue;
        }

        const product = await this.products.getById(mapping.productId);
        const requiredUnits = line.qty * mapping.bundleQty;
        const policy = line.policyOverride ?? product.fulfillmentPolicy;

        const [ol] = await tx
          .insert(orderLines)
          .values({
            orderId: order.id,
            productId: mapping.productId,
            remoteLineId: line.remoteLineId,
            qty: requiredUnits,
            status: 'pending',
          })
          .returning();
        const orderLine = ol!;

        // Atama — tek/çok kullanımlık.
        const allocations =
          product.usageMode === 'multi'
            ? await this.allocateMulti(tx, mapping.productId, requiredUnits)
            : await this.allocateSingle(tx, mapping.productId, requiredUnits);

        let fulfilledUnits = allocations.reduce((s, a) => s + a.units, 0);

        // all-or-nothing: tamamı hazır değilse hiçbirini teslim etme (§5).
        if (policy === 'all-or-nothing' && fulfilledUnits < requiredUnits) {
          await releaseToAvailable(
            tx,
            allocations.map((a) => a.licenseItemId),
          );
          allocations.length = 0;
          fulfilledUnits = 0;
        }

        const validUntil = product.validityDays
          ? new Date(Date.now() + product.validityDays * 86_400_000)
          : null;

        for (const alloc of allocations) {
          const [asg] = await tx
            .insert(assignments)
            .values({
              orderId: order.id,
              lineId: orderLine.id,
              licenseItemId: alloc.licenseItemId,
              units: alloc.units,
              validUntil,
              status: 'active',
              deliveredAt: new Date(),
            })
            .returning();
          assignmentResults.push({
            assignmentId: asg!.id,
            remoteLineId: line.remoteLineId,
            units: alloc.units,
            validUntil: validUntil ? validUntil.toISOString() : null,
          });
        }

        const lineStatus =
          fulfilledUnits >= requiredUnits
            ? 'fulfilled'
            : fulfilledUnits > 0
              ? 'partial'
              : 'pending';
        await tx
          .update(orderLines)
          .set({ fulfilledQty: fulfilledUnits, status: lineStatus })
          .where(eq(orderLines.id, orderLine.id));

        if (fulfilledUnits >= requiredUnits) anyFulfilled = true;
        else {
          anyMappedPending = true;
          if (fulfilledUnits > 0) anyFulfilled = true;
        }

        lineResults.push({
          remoteLineId: line.remoteLineId,
          status: lineStatus,
          requestedQty: requiredUnits,
          fulfilledQty: fulfilledUnits,
        });
      }

      // Sipariş durumu.
      const orderStatus = anyFulfilled
        ? anyMappedPending || anyUnmapped
          ? 'partial'
          : 'fulfilled'
        : anyUnmapped && !anyMappedPending
          ? 'unmapped'
          : 'pending';
      await tx.update(orders).set({ status: orderStatus }).where(eq(orders.id, order.id));

      await tx.insert(fulfillmentEvents).values({
        orderId: order.id,
        type:
          orderStatus === 'fulfilled'
            ? 'fulfilled'
            : orderStatus === 'partial'
              ? 'partially_fulfilled'
              : 'pending_stock',
        message: `Durum: ${orderStatus}`,
      });

      return {
        orderId: order.id,
        status: orderStatus,
        assignments: assignmentResults,
        lines: lineResults,
      } satisfies CreateOrderResponse;
    });

    return this.buildOutcome(result);
  }

  /** Tek kullanımlık atama: her satır 1 unit. */
  private async allocateSingle(
    tx: Database,
    productId: string,
    units: number,
  ): Promise<Array<{ licenseItemId: string; units: number }>> {
    const ids = await assignAvailableSingleUse(tx, productId, units);
    return ids.map((id) => ({ licenseItemId: id, units: 1 }));
  }

  /** Çok kullanımlık atama: kapasite key'ler arasında dağıtılır, key başına gruplanır. */
  private async allocateMulti(
    tx: Database,
    productId: string,
    units: number,
  ): Promise<Array<{ licenseItemId: string; units: number }>> {
    const byKey = new Map<string, number>();
    for (let i = 0; i < units; i++) {
      const id = await consumeMultiUseCapacity(tx, productId, 1);
      if (!id) break;
      byKey.set(id, (byKey.get(id) ?? 0) + 1);
    }
    return [...byKey.entries()].map(([licenseItemId, u]) => ({ licenseItemId, units: u }));
  }

  /** Mevcut siparişin sonucunu (idempotent tekrar için) yeniden kurar. */
  private async loadOrderResult(order: Order): Promise<CreateOrderResponse> {
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
    const asgs = await this.db.select().from(assignments).where(eq(assignments.orderId, order.id));

    const lineById = new Map(lines.map((l) => [l.id, l]));
    return {
      orderId: order.id,
      status: order.status as CreateOrderResponse['status'],
      assignments: asgs.map((a) => ({
        assignmentId: a.id,
        remoteLineId: lineById.get(a.lineId)?.remoteLineId ?? '',
        units: a.units,
        validUntil: a.validUntil ? a.validUntil.toISOString() : null,
      })),
      lines: lines.map((l) => ({
        remoteLineId: l.remoteLineId,
        status: l.status,
        requestedQty: l.qty,
        fulfilledQty: l.fulfilledQty,
      })),
    };
  }

  private buildOutcome(body: CreateOrderResponse): CreateOrderOutcome {
    const httpStatus =
      body.status === 'fulfilled'
        ? ORDER_HTTP_STATUS.fullyFulfilled // 201
        : body.status === 'partial'
          ? ORDER_HTTP_STATUS.partialFulfillment // 207
          : ORDER_HTTP_STATUS.pendingStock; // 202
    return { httpStatus, body };
  }
}
