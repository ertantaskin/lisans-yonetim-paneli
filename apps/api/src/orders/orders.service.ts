import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
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
  emailLog,
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
import { recomputeOrderStatus } from './order-status';
import { FulfillmentService } from './fulfillment.service';
import { AdminOrdersService } from './admin-orders.service';

/** Site-facing toplu durum satırı (#33) — PAYLOAD/KEY YOK, yalnız ilerleme. */
export interface BulkStatusItem {
  remoteOrderId: string;
  status: string;
  fulfilled: number;
  total: number;
}

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
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly products: ProductsService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly webhook: WebhookService,
    // Re-push uzlaştırma (#16) mevcut atama/revoke akışlarını YENİDEN KULLANIR —
    // çift satış/kilit invaryantları tek yerde kalsın diye kendi kopyasını yazmaz.
    private readonly fulfillment: FulfillmentService,
    private readonly adminOrders: AdminOrdersService,
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
        onExpiry: products.onExpiry,
      })
      .from(assignments)
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(
        and(
          eq(assignments.orderId, order.id),
          eq(assignments.status, 'active'),
          // Savunma amaçlı süre filtresi: expiry job gecikse bile onExpiry='hide'
          // ürünün süresi geçmiş payload'ı SIZMAZ. 'keep' ürün süre sonrası da görünür.
          or(
            isNull(assignments.validUntil),
            gt(assignments.validUntil, sql`now()`),
            eq(products.onExpiry, 'keep'),
          ),
        ),
      );

    const now = Date.now();
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
        expired: r.validUntil ? r.validUntil.getTime() < now : false,
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

    // Mail durumu (#32): siparişin EN GÜNCEL email_log satırının status'u (sent|failed|
    // queued|sending|…). WP "Sorun mu var?" ipucu için — PAYLOAD/KEY sızmaz, yalnız durum.
    // Kayıt yoksa null. Savunma-filtresi/expired mantığı yukarıda korunur.
    const mailStatus = await this.latestMailStatus(order.id);

    return { orderId: order.id, status: order.status, mailStatus, deliveries };
  }

  /** Siparişin en güncel teslimat maili durumu (#32) — yoksa null. */
  private async latestMailStatus(orderId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ status: emailLog.status })
      .from(emailLog)
      .where(eq(emailLog.orderId, orderId))
      .orderBy(desc(emailLog.createdAt))
      .limit(1);
    return row?.status ?? null;
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
      // Sipariş düzenleme (#16): re-push satır adedini değiştirmişse uzlaştır. Adet
      // AYNIYSA reconcileOrder null döner → klasik idempotent (değişmeden) yanıt korunur.
      const reconciled = await this.reconcileOrder(site, existing[0], dto);
      return reconciled ?? this.buildOutcome(await this.loadOrderResult(existing[0]));
    }

    // Satış kotası ön-kontrolü (§5) — idempotency lookup'ından SONRA. Aynı
    // idempotency key ile gelen tekrar istekler yukarıda mevcut sonucu döner ve
    // buraya HİÇ ulaşmaz → kabul edilmiş bir sipariş kotaya TAKILMADAN idempotent
    // döner. Yalnız GERÇEKTEN yeni sipariş kotaya sayılır. (SalesQuotaGuard'dan
    // buraya taşındı — guard idempotency'den önce çalıştığı için retry'ları 429'luyordu.)
    await this.enforceSalesQuota(site);

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

          // Stoksuz/ön sipariş kapısı (§11): ürün stockless ve release_at gelecekteyse,
          // stok gelmiş olsa bile release_at'ten ÖNCE atama YAPILMAZ — satır pending
          // kalır (kısmi/pending akışı bozulmaz, yalnız erken teslim engellenir).
          const releaseGated =
            product.stockless &&
            product.releaseAt != null &&
            new Date(product.releaseAt).getTime() > Date.now();

          // Atama — tek/çok kullanımlık (ortak allocate). Release kapısı açıksa atama yok.
          const allocations = releaseGated ? [] : await allocate(tx, product, requiredUnits);

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

    // Teslimat yan etkileri transaction COMMIT sonrası — her biri AYRI try/catch.
    // Geçici bir enqueue hatası (Redis/kuyruk erişimi) ana yanıtı (201/207/202)
    // DÜŞÜRMEMELİ: sipariş+atama zaten kalıcı; hata loglanıp YUTULUR.
    if (result.assignments.length > 0) {
      // Atama yapıldıysa teslimat mailini kuyruğa al (asenkron, §2/§6).
      try {
        await this.mail.enqueueDelivery(
          result.orderId,
          dto.customerEmail,
          `Siparişiniz hazır — ${dto.remoteOrderId}`,
        );
      } catch (err) {
        this.logger.error(
          `Teslimat maili kuyruğa alınamadı (order=${result.orderId}) — yanıt etkilenmedi: ${String(err)}`,
        );
      }
    }

    // Geri kanal webhook (§2) — WP eklentisi order meta'yı günceller. webhook.emit
    // outbox'a YAZDIKTAN sonra kuyruğa alır; enqueue düşse bile outbox kaydı kalır
    // ve /ops replay ile yeniden gönderilebilir (olay kaybolmaz).
    try {
      await this.webhook.emit(site.id, result.orderId, eventFor(result.status), {
        status: result.status,
        remoteOrderId: dto.remoteOrderId,
        lines: result.lines,
      });
    } catch (err) {
      this.logger.error(
        `Geri kanal webhook kuyruğa alınamadı (order=${result.orderId}) — outbox'tan replay edilebilir: ${String(err)}`,
      );
    }

    return this.buildOutcome(result);
  }

  /**
   * Sipariş düzenleme / re-push uzlaştırma (#16). Aynı site+sipariş tekrar geldiğinde
   * (idempotency eşleşmesi) satır ADEDİ değişmişse mevcut atama/revoke akışlarıyla farkı
   * kapatır. HİÇBİR satır değişmemişse `null` döner → çağıran klasik idempotent yanıtı
   * verir (normal ilk-push ve değişmeyen tekrar davranışı ASLA bozulmaz).
   *
   *   (a) yeni qty > mevcut → line.qty yükselt, farkı ata (partial-auto ⇒ completeLine ile
   *       otomatik; diğer politikalar ⇒ pending kalır, elle "Kalanları Ata").
   *   (b) yeni qty < mevcut ve fulfilledQty > yeni qty → fazla AKTİF atamaları mevcut
   *       idempotent revoke akışıyla (revokeAssignment: tek→karantina, multi→kapasite geri)
   *       geri al, line.qty=yeni qty.
   *   (c) aynı qty → no-op.
   *
   * Yalnız remoteLineId ile EŞLEŞEN mevcut satırlar uzlaştırılır; yeni satır ekleme/tam
   * satır silme bilinçli kapsam dışı (WP re-push adet güncellemesi senaryosu).
   */
  private async reconcileOrder(
    site: Site,
    order: Order,
    dto: CreateOrderRequest,
  ): Promise<CreateOrderOutcome | null> {
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
    const lineByRemote = new Map(lines.map((l) => [l.remoteLineId, l]));

    const changedLineIds: string[] = [];

    for (const dtoLine of dto.lines) {
      const line = lineByRemote.get(dtoLine.remoteLineId);
      if (!line) continue; // Eşleşmeyen (yeni) satır — güvenli yoksay.

      // Yeni gerekli birim = qty × bundleQty (eşlemesiz satırda bundle yok, qty=birim).
      const mapping = line.productId
        ? await this.products.resolveMapping(
            site.id,
            dtoLine.remoteProductId,
            dtoLine.remoteVariationId,
          )
        : null;
      const newQty = dtoLine.qty * (mapping?.bundleQty ?? 1);

      if (newQty === line.qty) continue; // (c) değişiklik yok.

      if (newQty > line.qty) {
        // (a) Artış: önce line.qty yükselt (completeLine kalanı = qty−fulfilled ile hesaplar).
        await this.db.update(orderLines).set({ qty: newQty }).where(eq(orderLines.id, line.id));
        if (line.productId) {
          const product = await this.products.getById(line.productId);
          const policy = line.policyOverride ?? product.fulfillmentPolicy;
          // Yalnız partial-auto otomatik atanır — mevcut fulfillment mantığı (allocate +
          // SKIP LOCKED + kapasite) stok elverdiğince farkı (ve varsa eski pending'i) kapatır.
          if (policy === 'partial-auto') {
            await this.fulfillment.completeLine(line.id);
          }
        }
      } else {
        // (b) Azalış: aşırı-teslim varsa (fulfilled > yeni qty) fazlayı geri al, sonra qty düş.
        if (line.fulfilledQty > newQty) {
          await this.revokeExcess(site, line.id, line.fulfilledQty - newQty);
        }
        await this.db.update(orderLines).set({ qty: newQty }).where(eq(orderLines.id, line.id));
      }

      changedLineIds.push(line.id);
    }

    if (changedLineIds.length === 0) return null; // Hiç adet değişmedi → idempotent yol.

    // Değişen satır + sipariş durumunu tek transaction'da yeniden hesapla + edit izi.
    await this.db.transaction(async (tx) => {
      for (const lineId of changedLineIds) {
        const [l] = await tx.select().from(orderLines).where(eq(orderLines.id, lineId)).limit(1);
        if (!l) continue;
        const status =
          l.fulfilledQty >= l.qty ? 'fulfilled' : l.fulfilledQty > 0 ? 'partial' : 'pending';
        await tx.update(orderLines).set({ status }).where(eq(orderLines.id, lineId));
      }
      await recomputeOrderStatus(tx, order.id);
      await tx.insert(fulfillmentEvents).values({
        orderId: order.id,
        type: 'order_edited',
        message: `Sipariş adedi güncellendi (re-push) — ${changedLineIds.length} satır`,
      });
    });

    const [fresh] = await this.db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    return this.buildOutcome(await this.loadOrderResult(fresh ?? order));
  }

  /**
   * Bir satırın AKTİF atamalarını (en yeni önce) `excessUnits` birim karşılanana dek
   * mevcut idempotent revoke akışıyla geri alır (#16 azalış). revokeAssignment lisansı
   * karantinaya/kapasiteye döndürür, satır sayacını düşer — çift satış/hak invaryantı korunur.
   */
  private async revokeExcess(site: Site, lineId: string, excessUnits: number): Promise<void> {
    const active = await this.db
      .select({ id: assignments.id, units: assignments.units })
      .from(assignments)
      .where(and(eq(assignments.lineId, lineId), eq(assignments.status, 'active')))
      .orderBy(desc(assignments.createdAt));

    const actor = `site:${site.domain ?? site.id}`;
    let revoked = 0;
    for (const a of active) {
      if (revoked >= excessUnits) break;
      await this.adminOrders.revokeAssignment(a.id, 'Sipariş adedi düşürüldü (re-push)', actor);
      revoked += a.units;
    }
  }

  /**
   * Site-facing toplu durum (#33). Yalnız site.id kapsamındaki siparişler için ilerleme
   * (status + Σ fulfilled_qty + Σ qty) döner — PAYLOAD/KEY YOK. WP eklentisi çok siparişi
   * tek çağrıda yoklar. Kapsam dışı / bulunamayan remoteOrderId yanıtta yer almaz.
   */
  async bulkStatus(site: Site, remoteOrderIds: string[]): Promise<BulkStatusItem[]> {
    if (remoteOrderIds.length === 0) return [];

    const rows = await this.db
      .select({
        remoteOrderId: orders.remoteOrderId,
        status: orders.status,
        fulfilled: sql<number>`coalesce(sum(${orderLines.fulfilledQty}), 0)::int`,
        total: sql<number>`coalesce(sum(${orderLines.qty}), 0)::int`,
      })
      .from(orders)
      .leftJoin(orderLines, eq(orderLines.orderId, orders.id))
      .where(and(eq(orders.siteId, site.id), inArray(orders.remoteOrderId, remoteOrderIds)))
      .groupBy(orders.id);

    return rows.map((r) => ({
      remoteOrderId: r.remoteOrderId,
      status: r.status,
      fulfilled: Number(r.fulfilled),
      total: Number(r.total),
    }));
  }

  /**
   * Günlük satış kotası ön-kontrolü (§5). Site salesDailyQuota tanımlıysa bugünkü
   * (created_at >= date_trunc('day', now())) sipariş sayısını sayar; kota dolmuşsa
   * 429 (TOO_MANY_REQUESTS) fırlatır ve çekirdek atama akışına girilmez. Kota null →
   * limitsiz. SalesQuotaGuard ile birebir aynı pencere/eşik; farkı yalnız çağrı yeri:
   * idempotency lookup'ından SONRA çağrılır (idempotent retry kotaya takılmaz).
   */
  private async enforceSalesQuota(site: Site): Promise<void> {
    // Kota tanımsız (null) → limitsiz, kontrol yok.
    if (site.salesDailyQuota == null) return;

    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(eq(orders.siteId, site.id), gte(orders.createdAt, sql`date_trunc('day', now())`)),
      );

    const todayCount = row?.count ?? 0;
    if (todayCount >= site.salesDailyQuota) {
      throw new HttpException('Günlük satış kotası aşıldı', HttpStatus.TOO_MANY_REQUESTS);
    }
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
