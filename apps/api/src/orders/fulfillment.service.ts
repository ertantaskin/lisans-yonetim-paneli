import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import {
  assignments,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
  products,
} from '../db/schema';
import { ProductsService } from '../products/products.service';
import { MailService } from '../mail/mail.service';
import { WebhookService } from '../webhook/webhook.service';
import { allocate } from '../assignment/allocate';
import { releaseAllocations } from '../assignment/assign';
import { recomputeOrderStatus } from './order-status';

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
  private readonly logger = new Logger(FulfillmentService.name);

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
      // Satırı kilitle — eşzamanlı tamamlamalar (admin çift-tık, iki stok import'u,
      // çoğaltılmış API replica'ları) serileşir; aşırı teslimat (fazla key) önlenir.
      const [line] = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.id, lineId))
        .limit(1)
        .for('update');
      if (!line) throw new NotFoundException('Sipariş satırı bulunamadı');
      // İade/iptal edilmiş satır otomatik/elle YENIDEN TESLIM edilmez (§2) — taze key ile
      // yeniden doldurulup iade edilen müşteriye bedava lisans gitmesini engeller.
      if (line.canceled) {
        return this.noop(line.id, line.orderId, line.qty, line.fulfilledQty, line.status);
      }
      if (!line.productId) {
        return this.noop(line.id, line.orderId, line.qty, line.fulfilledQty, line.status);
      }
      // #7 (§8): incelemeye alınmış (held_for_review) siparişin satırı OTOMATİK atanmaz.
      // Admin releaseHeld önce bayrağı temizler, SONRA completeLine çağırır (release bayrak
      // KAPALIYKEN çalışır). autoComplete de held siparişleri sorgudan hariç tutar; bu
      // savunma job gecikse/yarışsa bile held payload'ının erken sızmasını engeller.
      const [ord] = await tx
        .select({ held: orders.heldForReview })
        .from(orders)
        .where(eq(orders.id, line.orderId))
        .limit(1);
      if (ord?.held) {
        return this.noop(line.id, line.orderId, line.qty, line.fulfilledQty, line.status);
      }

      const remaining = line.qty - line.fulfilledQty;
      const toAssign = maxUnits ? Math.min(remaining, maxUnits) : remaining;
      if (toAssign <= 0) {
        return this.noop(line.id, line.orderId, line.qty, line.fulfilledQty, line.status);
      }

      const product = await this.products.getById(line.productId);

      // Ön sipariş/stoksuz kapısı (§11): release_at gelecekteyse stok girmiş olsa bile
      // atama YAPMA (erken teslim engellenir). createOrder'daki kapıyla aynı invaryant;
      // autoCompleteProduct (stok girişi) ve manuel "Kalanları Ata" bu yolu kullanır.
      if (
        product.stockless &&
        product.releaseAt &&
        new Date(product.releaseAt).getTime() > Date.now()
      ) {
        return this.noop(line.id, line.orderId, line.qty, line.fulfilledQty, line.status);
      }

      // Efektif politika (satır override > ürün). all-or-nothing satırda kısmi teslim YASAK (§5).
      const policy = line.policyOverride ?? product.fulfillmentPolicy;
      const allocations = await allocate(tx, product, toAssign);
      let added = allocations.reduce((s, a) => s + a.units, 0);

      // all-or-nothing: satır TÜMÜYLE karşılanamıyorsa hiçbir şey teslim etme — kapasiteyi geri
      // ver (createOrder'daki aynı invaryant). Bu, releaseHeld (İnceleme onayı) ve reconcile gibi
      // completeLine çağıranlarının da all-or-nothing garantisini korumasını sağlar (#7 denetim D).
      if (policy === 'all-or-nothing' && line.fulfilledQty + added < line.qty) {
        await releaseAllocations(tx, allocations);
        allocations.length = 0;
        added = 0;
      }

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

      const orderStatus = await recomputeOrderStatus(tx, line.orderId);
      if (orderStatus === 'fulfilled') {
        await tx.insert(fulfillmentEvents).values({
          orderId: line.orderId,
          type: 'fulfilled',
          message: 'Sipariş tamamlandı',
        });
      }

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

    // Yeni atama yapıldıysa teslimat/güncelleme mailini kuyruğa al (§6). Atama zaten commit
    // edildi; enqueue best-effort — kuyruk/DB hatası teslimatı DÜŞÜRMEZ (createOrder deseni).
    if (result.added > 0) {
      try {
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
          const evt =
            order.status === 'fulfilled' ? 'order.fulfilled' : 'order.partially_fulfilled';
          await this.webhook.emit(order.siteId, order.id, evt, {
            status: order.status,
            remoteOrderId: order.remoteOrderId,
          });
        }
      } catch (err) {
        this.logger.warn(
          `completeLine sonrası mail/webhook kuyruğa alınamadı (order ${result.orderId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return result;
  }

  /**
   * Stok girişinde tetiklenir (§5). partial-auto ürünlerin bekleyen satırlarını
   * FIFO (öncelik desc, created_at asc) tarar ve stok bitene kadar tamamlar.
   */
  async autoCompleteProduct(productId: string): Promise<number> {
    // Ön sipariş kapısı: ürün stoksuz + release_at gelecekteyse stok girmiş olsa bile
    // hiçbir satır tamamlanmaz → boşuna satır taramadan erken çık (completeLine ayrıca savunur).
    const product = await this.products.getById(productId);
    if (
      product.stockless &&
      product.releaseAt &&
      new Date(product.releaseAt).getTime() > Date.now()
    ) {
      return 0;
    }

    const pending = await this.db
      .select({ id: orderLines.id })
      .from(orderLines)
      .innerJoin(products, eq(orderLines.productId, products.id))
      // #7 (§8): incelemeye alınmış siparişleri sweep'ten HARİÇ tut — teslimat manuel onaya
      // bağlı (held_for_review). Admin releaseHeld ile bayrağı temizleyince normal akışa döner.
      .innerJoin(orders, eq(orderLines.orderId, orders.id))
      .where(
        and(
          eq(orderLines.productId, productId),
          inArray(orderLines.status, ['pending', 'partial']),
          // İade/iptal edilmiş satırları HARİÇ TUT — yeniden teslim edilmez (§2).
          eq(orderLines.canceled, false),
          eq(orders.heldForReview, false),
          // Efektif politika: satır override > ürün. Yalnız partial-auto oto-tamamlanır.
          sql`coalesce(${orderLines.policyOverride}, ${products.fulfillmentPolicy}) = 'partial-auto'`,
        ),
      )
      .orderBy(sql`${orderLines.priority} desc`, asc(orderLines.createdAt));

    let completedLines = 0;
    for (const { id } of pending) {
      const res = await this.completeLine(id);
      if (res.added > 0) completedLines++;
      if (res.status !== 'fulfilled') {
        // Satır tamamlanmadı. Erken-çıkış açığı (§5): completeLine, allocate'in
        // FOR UPDATE SKIP LOCKED'ı yüzünden eşzamanlı bir tamamlama satırları
        // kilitlediyse added=0 dönebilir — stok bitmediği halde. Bu yüzden yalnız
        // GERÇEK stok tükenişinde dur; stok hâlâ varsa (kilitli/serbest) kalan
        // satırlara devam et, aksi halde bekleyen düşük-öncelikli satırlar açıkta kalır.
        if ((await this.productAvailableCount(productId)) <= 0) break;
      }
    }
    return completedLines;
  }

  /** Ürün başına anlık 'available' kapasite (single: satır; multi: kalan max_uses−use_count). */
  private async productAvailableCount(productId: string): Promise<number> {
    const [row] = await this.db
      .select({
        count: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(licenseItems)
      .where(and(eq(licenseItems.productId, productId), eq(licenseItems.status, 'available')));
    return Number(row?.count ?? 0);
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
