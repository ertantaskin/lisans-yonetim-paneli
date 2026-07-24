import { Inject, Injectable, Logger } from '@nestjs/common';
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
import { SecurityService } from '../security/security.service';
import { SalesQuotaExceededException } from './sales-quota.exception';

/**
 * Dinamik kota (§8) alt eşik tabanı: 30g-ortalama × çarpan bunun altında kalsa bile eşik
 * bu değerin altına inmez — yeni/düşük-hacimli sitelerde "her sipariş held" yanlış-pozitifini
 * önler (avg30≈0 → eşik 0 tuzağı). Site salesDailyQuota'dan BAĞIMSIZ (o sert tavan ayrı).
 */
const DYNAMIC_MIN_FLOOR = 20;

/** Yerel gün sınırına (gece yarısı) kalan saniye — 429 Retry-After başlığı için (§4). */
function secondsUntilLocalMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000));
}

/** Site-facing toplu durum satırı (#33) — PAYLOAD/KEY YOK, yalnız ilerleme. */
export interface BulkStatusItem {
  remoteOrderId: string;
  status: string;
  /** F4: İnceleme Kuyruğu (held_for_review) bayrağı — WP poll'da terminal/held ayrımı için. */
  held: boolean;
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

/**
 * F2 iç sinyali: advisory-lock altında idempotent ikiz bulundu → (henüz yazım yapmamış) tx'i boş
 * roll-back etmek için fırlatılır; catch bloğu önceden kurulmuş buildOutcome'u DOĞRUDAN döndürür
 * (kota/hold kararına ulaşılmadan). Diğer hatalardan ayırt edilebilmesi için ayrı sınıf.
 */
class DuplicateOrderSignal extends Error {}

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
    // Sert kota aşımını (§5) best-effort security_events'e yazar (gözlemlenebilirlik, §15).
    private readonly security: SecurityService,
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
          // #7 denetim (yarış savunması): iptal/iade edilmiş satırın (canceled) atamasını ASLA
          // döndürme. release/reject yarışı stray bir aktif atama bıraksa bile reddedilen/iade
          // edilen siparişte müşteri canlı key GÖRMEZ (satır canceled → filtrelenir).
          eq(orderLines.canceled, false),
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

    // F4: `held` (heldForReview) alanı — WP eklentisi İnceleme Kuyruğu durumunu (my-account bildirimi/
    // metabox rozeti) bu bayraktan okur. Eklemeli; mevcut alanlar (status/mailStatus/deliveries) değişmez.
    return { orderId: order.id, status: order.status, held: order.heldForReview, mailStatus, deliveries };
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

    const idempotencyKey = `${site.id}:${dto.remoteOrderId}`;

    // #7 denetim B: held-dalı bilgisini tx dışına taşı → commit SONRASI 'quota_review' alarmı
    // (security_event) yazılır (reject yoluyla simetri; held artık sessiz değil).
    let heldMeta: { todayCount: number; threshold: number } | null = null;
    let duplicateOutcome: CreateOrderOutcome | null = null;
    let result: CreateOrderResponse;
    try {
      result = await this.db.transaction(async (tx) => {
        // #20 TOCTOU + #7: site başına advisory-lock — kota SAY-sonra-EKLE yarışını kapatır.
        // YALNIZ bir kota özelliği açıkken alınır (#7 denetim H): kota tamamen kapalı sitelerde
        // (salesDailyQuota=null && !dynamicQuotaEnabled) sipariş oluşturmayı gereksiz yere site-
        // başına serileştirmemek için — o durumda evaluateQuota zaten sayım yapmadan 'allow' döner
        // ve eski paralel davranış korunur. Açıkken kilit commit/rollback'te bırakılır (idempotent
        // retry buraya HİÇ ulaşmaz; yalnız GERÇEKTEN yeni sipariş kotaya sayılır).
        if (site.salesDailyQuota != null || site.dynamicQuotaEnabled) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${site.id}))`);

          // F2: kilit ALTINDA idempotency YENİDEN-kontrolü — kota/hold kararından ÖNCE. İki eşzamanlı
          // aynı-remoteOrderId push'unda 2. istek advisory-lock'u 1.'nin commit+SAYIM'ından SONRA alır;
          // burada mevcut siparişi görürse kotaya/hold'a BAKMADAN idempotent döner → kabul edilmiş bir
          // siparişin ikizine kota sınırında SAHTE 429 verilmez (aksi halde evaluateQuota 1. sipariş
          // sayıldığından reddederdi). Yukarıdaki L212-213 yorumunu ("idempotent retry buraya HİÇ
          // ulaşmaz") gerçekten sağlar; henüz hiçbir yazım yapılmadığından tx boş roll-back edilir.
          const [dup] = await tx
            .select()
            .from(orders)
            .where(and(eq(orders.siteId, site.id), eq(orders.remoteOrderId, dto.remoteOrderId)))
            .limit(1);
          if (dup) {
            duplicateOutcome = this.buildOutcome(await this.loadOrderResult(dup));
            throw new DuplicateOrderSignal();
          }
        }

        // Kota kararı (§5 sert tavan REDDET / §8 dinamik eşik HOLD). Advisory-lock altında.
        const quota = await this.evaluateQuota(tx, site);
        if (quota.action === 'reject') {
          // Sert tavan aşıldı → 429. Retry-After controller'da set edilir; security_event
          // catch'te best-effort yazılır. Tx rollback → sipariş satırı OLUŞMAZ.
          throw new SalesQuotaExceededException(
            quota.todayCount,
            quota.limit,
            secondsUntilLocalMidnight(),
          );
        }

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

        // #7 (§8): dinamik eşik aşıldı → sipariş KABUL ama teslimat manuel onaya alınır
        // (held_for_review). Atama YAPILMAZ; satırlar pending yazılır (eşlemesiz null kalır).
        // autoComplete bu siparişi ATLAR; admin "İnceleme Kuyruğu"nda Onayla/Reddet eder.
        if (quota.action === 'hold') {
          heldMeta = { todayCount: quota.todayCount, threshold: quota.threshold };
          await tx
            .update(orders)
            .set({
              heldForReview: true,
              heldAt: new Date(),
              heldReason: `Dinamik kota incelemesi: bugün ${quota.todayCount} sipariş (eşik ${quota.threshold})`,
            })
            .where(eq(orders.id, order.id));

          const heldLines: OrderLineResult[] = [];
          for (const line of dto.lines) {
            const mapping = await this.products.resolveMapping(
              site.id,
              line.remoteProductId,
              line.remoteVariationId,
            );
            const requiredUnits = mapping ? line.qty * mapping.bundleQty : line.qty;
            await tx.insert(orderLines).values({
              orderId: order.id,
              productId: mapping?.productId ?? null,
              remoteLineId: line.remoteLineId,
              qty: requiredUnits,
              status: 'pending',
              policyOverride: line.policyOverride ?? null,
            });
            heldLines.push({
              remoteLineId: line.remoteLineId,
              status: 'pending',
              requestedQty: requiredUnits,
              fulfilledQty: 0,
            });
          }

          await tx.insert(fulfillmentEvents).values({
            orderId: order.id,
            type: 'held_for_review',
            message: `İncelemeye alındı — bugün ${quota.todayCount} sipariş (dinamik eşik ${quota.threshold})`,
          });

          // status enum'da 'held_for_review' YOK → 'pending' kalır; ayrımı held bayrağı taşır.
          return {
            orderId: order.id,
            status: 'pending',
            assignments: [],
            lines: heldLines,
            held: true,
          } satisfies CreateOrderResponse;
        }

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
      // F2: advisory-lock altında idempotent ikiz bulundu → önceden kurulan yanıtı doğrudan döndür
      // (tx boş roll-back edildi; kota/hold değerlendirilmedi). (Cast: duplicateOutcome closure içinde
      // atandığından TS akış-analizi burada null'a sabitliyor — heldMeta ile aynı desen.)
      const dupOutcome = duplicateOutcome as CreateOrderOutcome | null;
      if (e instanceof DuplicateOrderSignal && dupOutcome) return dupOutcome;
      // Sert kota aşımı → best-effort security_event (dedupe'lu) + 429'u aynen fırlat.
      // Retry-After başlığını controller (reply erişimi orada) set eder.
      if (e instanceof SalesQuotaExceededException) {
        await this.security
          .recordQuotaExceeded(site.id, e.todayCount, e.limit)
          .catch(() => undefined);
        throw e;
      }
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

    // #7 denetim B (§8 "held_for_review + ALARM"): dinamik eşik aşımıyla incelemeye alınan sipariş
    // için 'quota_review' güvenlik olayı (dedupe'lu) → /security + daily-digest görünür. Best-effort:
    // yazamama teslimat/yanıtı ETKİLEMEZ. Yalnız GERÇEK held'te (idempotent retry heldMeta=null).
    // (Tip assertion: heldMeta closure içinde atandığından TS akış-analizi init'e (null) sabitliyor;
    // `as` ile birlik tipi geri kazanılır, sonra if daraltır.)
    const held = heldMeta as { todayCount: number; threshold: number } | null;
    if (held) {
      await this.security
        .recordQuotaHeld(site.id, held.todayCount, held.threshold)
        .catch(() => undefined);
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
    const reason = 'Sipariş adedi düşürüldü (re-push)';
    let revoked = 0;
    for (const a of active) {
      if (revoked >= excessUnits) break;
      const need = excessUnits - revoked;
      if (a.units <= need) {
        // Bu atamanın TAMAMI fazlalığa sığıyor → tam revoke (tek→karantina, multi→kapasite geri).
        // markLineCanceled=false: adedi düşürülen satır AKTİF kalır (iade/iptal değil); ileride adet
        // tekrar artarsa autoComplete meşru şekilde doldurabilmeli — 'canceled' bunu kalıcı bloklardı.
        await this.adminOrders.revokeAssignment(a.id, reason, actor, false);
        revoked += a.units;
      } else {
        // #19 birim-granüler: atama fazladan büyük (multi/MAK'te tek key birden çok birim taşır) →
        // yalnız `need` birimi geri al, atamayı imha ETME. Kapasite tam `need` kadar döner; kalan
        // birim müşteride aktif kalır. Tek-kullanımda a.units=1 ⇒ need≥1 ⇒ bu dala hiç girilmez
        // (eski davranış birebir korunur); yalnız çok-kullanımlıkta over-revoke düzelir.
        await this.adminOrders.revokePartialUnits(a.id, need, reason, actor);
        revoked += need;
      }
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
        // F4: heldForReview groupBy(orders.id) PK'ye fonksiyonel bağımlı → aggregatesiz seçilebilir.
        held: orders.heldForReview,
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
      held: r.held,
      fulfilled: Number(r.fulfilled),
      total: Number(r.total),
    }));
  }

  /**
   * Kota kararı (§5 sert tavan + §8 dinamik eşik). createOrder içinde, site advisory-lock
   * ALTINDA çağrılır (bugünkü sipariş sayısı tutarlı → say-sonra-ekle yarışı yok, #20).
   *
   *   - salesDailyQuota (sert tavan): todayCount ≥ kota → `reject` (429). null = limitsiz.
   *   - dynamicQuotaEnabled (yumuşak): todayCount ≥ eşik → `hold` (incelemeye al, §8/§15).
   *     Eşik = ceil(30g-ortalama günlük × reviewMultiplier), tabanı DYNAMIC_MIN_FLOOR.
   *   - ikisi de geçilirse `allow`. İkisi de açıksa önce sert tavan bakılır (mutlak).
   *
   * Idempotent retry buraya ulaşmaz (yukarıda mevcut sonuç döner) → yalnız gerçek yeni sipariş.
   */
  private async evaluateQuota(
    tx: Database,
    site: Site,
  ): Promise<
    | { action: 'allow' }
    | { action: 'reject'; todayCount: number; limit: number }
    | { action: 'hold'; todayCount: number; threshold: number }
  > {
    // Kota kontrolü gereksizse (ikisi de kapalı) sayım YAPMA — sıcak yol hızlı kalır.
    if (site.salesDailyQuota == null && !site.dynamicQuotaEnabled) return { action: 'allow' };

    const [today] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(orders)
      .where(
        and(eq(orders.siteId, site.id), gte(orders.createdAt, sql`date_trunc('day', now())`)),
      );
    const todayCount = Number(today?.count ?? 0);

    // 1) Sert tavan — aşımda REDDET (429).
    if (site.salesDailyQuota != null && todayCount >= site.salesDailyQuota) {
      return { action: 'reject', todayCount, limit: site.salesDailyQuota };
    }

    // 2) Dinamik eşik — aşımda HOLD (incelemeye al, reddetme). §8: 30g-ortalama × çarpan.
    if (site.dynamicQuotaEnabled) {
      // Taban YALNIZ meşru-teslim edilmiş (fulfilled/partial), held-OLMAYAN, BUGÜN-ÖNCESİ siparişleri
      // sayar → held/reddedilmiş/unmapped bir yükseliş gelecekteki eşiği ŞİŞİRMESİN (saldırgan kendi
      // eşiğini yükseltemez, #7 denetim E). Bölen sabit 30 (genç sitede düşük avg = daha erken hold = güvenli).
      const [recent] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(orders)
        .where(
          and(
            eq(orders.siteId, site.id),
            gte(orders.createdAt, sql`now() - interval '30 days'`),
            sql`${orders.createdAt} < date_trunc('day', now())`,
            eq(orders.heldForReview, false),
            inArray(orders.status, ['fulfilled', 'partial']),
          ),
        );
      const recent30 = Number(recent?.count ?? 0);
      const avgDaily = recent30 / 30;
      // Taban (DYNAMIC_MIN_FLOOR) YALNIZ yetersiz geçmişi olan siteye uygulanır (yeni-site yanlış-
      // pozitif koruması). Yeterli geçmiş varsa §8 "×çarpan"a güven — düşük-hacimli meşru sitede
      // sabit taban ×çarpan hassasiyetini maskelemesin (#7 denetim L). En az 1 (0-eşik tuzağını önle).
      const threshold =
        recent30 >= DYNAMIC_MIN_FLOOR
          ? Math.max(Math.ceil(avgDaily * site.reviewMultiplier), 1)
          : DYNAMIC_MIN_FLOOR;
      if (todayCount >= threshold) {
        return { action: 'hold', todayCount, threshold };
      }
    }

    return { action: 'allow' };
  }

  /** Mevcut siparişin sonucunu (idempotent tekrar için) yeniden kurar. */
  private async loadOrderResult(order: Order): Promise<CreateOrderResponse> {
    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, order.id));
    const asgs = await this.db.select().from(assignments).where(eq(assignments.orderId, order.id));

    const lineById = new Map(lines.map((l) => [l.id, l]));
    return {
      orderId: order.id,
      status: order.status as CreateOrderResponse['status'],
      // #7 denetim K: idempotent re-push (retry/kayıp-yanıt) held bayrağını tutarlı bildirsin →
      // WP eklentisi ilk yanıt kaybolsa da retry'da held işaretini set edebilir (aksi halde
      // yalnız İLK oluşturmada held:true dönüyordu, retry'da düşüyordu).
      held: order.heldForReview,
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
