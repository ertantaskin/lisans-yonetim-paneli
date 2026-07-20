import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  AssignmentResult,
  OrderLineResult,
  DeliveryItem,
} from '@jetlisans/shared';
import { ORDER_HTTP_STATUS, AccountPayloadSchema, parseAccountPayload } from '@jetlisans/shared';
import { NotFoundException } from '@nestjs/common';
import { DB, type Database } from '../db/db.module';
import {
  assignments,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
  products,
  type Order,
  type Site,
} from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { ProductsService } from '../products/products.service';
import { MailService } from '../mail/mail.service';
import { WebhookService } from '../webhook/webhook.service';
import { releaseAllocations } from '../assignment/assign';
import { allocate } from '../assignment/allocate';

/** Sipariş durumu → geri kanal olay tipi (§2). */
function eventFor(status: string): string {
  return status === 'fulfilled'
    ? 'order.fulfilled'
    : status === 'partial'
      ? 'order.partially_fulfilled'
      : 'order.pending_stock';
}

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
    private readonly mail: MailService,
    private readonly webhook: WebhookService,
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
        licenseItemId: licenseItems.id,
        productKind: products.kind,
        payloadSchema: products.payloadSchema,
      })
      .from(assignments)
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(and(eq(assignments.orderId, order.id), eq(assignments.status, 'active')));

    const deliveries: DeliveryItem[] = rows.map((r) => {
      const plain = this.crypto.decrypt(
        r.payloadEnc,
        CryptoService.licenseItemAad(r.licenseItemId),
      );
      const base = {
        assignmentId: r.assignmentId,
        remoteLineId: r.remoteLineId,
        units: r.units,
        validUntil: r.validUntil ? r.validUntil.toISOString() : null,
        kind: r.productKind,
      };
      // Hesap ürünü: şemaya göre alan-alan çöz (müşteri kendi lisansını tam görür).
      const schema =
        r.productKind === 'account' ? AccountPayloadSchema.safeParse(r.payloadSchema) : null;
      if (schema?.success) {
        return { ...base, payload: null, fields: parseAccountPayload(schema.data, plain) };
      }
      // key/code/custom (veya şeması bozuk account): düz string.
      return { ...base, payload: plain, fields: null };
    });

    return { orderId: order.id, status: order.status, deliveries };
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

    let result: CreateOrderResponse;
    try {
      result = await this.db.transaction(async (tx) => {
        // Sipariş kaydı (idempotency_key UNIQUE — yarışta tek kazanır). UNIQUE ihlali
        // transaction'ı abort eder; yakalama transaction DIŞINDA yapılır (aksi halde
        // "current transaction is aborted" → 500).
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
        const order = row!;

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
              policyOverride: line.policyOverride ?? null,
            })
            .returning();
          const orderLine = ol!;

          // Atama — tek/çok kullanımlık (ortak allocate).
          const allocations = await allocate(tx, product, requiredUnits);

          let fulfilledUnits = allocations.reduce((s, a) => s + a.units, 0);

          // all-or-nothing: tamamı hazır değilse hiçbirini teslim etme (§5).
          // releaseAllocations single + multi kapasiteyi geri verir (sızıntı yok).
          if (policy === 'all-or-nothing' && fulfilledUnits < requiredUnits) {
            await releaseAllocations(tx, allocations);
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
    } catch (e) {
      // Eşzamanlı ikiz (idempotency_key UNIQUE ihlali) → mevcut siparişi döndür (tx dışı).
      const [row] = await this.db
        .select()
        .from(orders)
        .where(eq(orders.idempotencyKey, idempotencyKey))
        .limit(1);
      if (row) return this.buildOutcome(await this.loadOrderResult(row));
      throw e;
    }

    // Atama yapıldıysa teslimat mailini kuyruğa al (asenkron, §2/§6).
    if (result.assignments.length > 0) {
      await this.mail.enqueueDelivery(
        result.orderId,
        dto.customerEmail,
        `Siparişiniz hazır — ${dto.remoteOrderId}`,
      );
    }

    // Geri kanal webhook (§2) — WP eklentisi order meta'yı günceller.
    await this.webhook.emit(site.id, result.orderId, eventFor(result.status), {
      status: result.status,
      remoteOrderId: dto.remoteOrderId,
      lines: result.lines,
    });

    return this.buildOutcome(result);
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
