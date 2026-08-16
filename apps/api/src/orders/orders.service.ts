import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type {
  CreateOrderRequest,
  CreateOrderResponse,
  AssignmentResult,
  OrderLineResult,
  DeliveryItem,
  RenderedGuide,
} from '@lisans/shared';
import {
  ORDER_HTTP_STATUS,
  AccountPayloadSchema,
  parseAccountPayload,
  renderGuide,
} from '@lisans/shared';
import { NotFoundException } from '@nestjs/common';
import { DB, type Database } from '../db/db.module';
import {
  assignments,
  emailLog,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
  productGuides,
  products,
  type Order,
  type Site,
} from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';
import { ProductsService } from '../products/products.service';
import { MailService } from '../mail/mail.service';
import { WebhookService } from '../webhook/webhook.service';
import { releaseAllocations } from '../assignment/assign';
import { insertAssignments } from './assignment-insert';
import { allocate } from '../assignment/allocate';
import { recomputeOrderStatus } from './order-status';
import { lineStatusFor } from './fill-target';
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

    // PERF: order lookup'tan sonraki 4 sorgu birbirinden BAĞIMSIZ (aralarında veri bağımlılığı yok)
    // → ardışık await yerine TEK Promise.all ile paralel çalıştır. Bu uç WP my-account/metabox
    // render'ında 5sn timeout ile SENKRON çağrılıyor; round-trip'i 4→1 sıraya indirmek render
    // bloklamasını düşürür. Sorgu şekilleri ve dönüş nesnesi AYNEN korunur (yalnız zamanlama değişir).
    const [rows, mailStatus, aggRows, flagRows, guideRows] = await Promise.all([
      // (1) Aktif atama satırları — payload SQL seviyesinde okunur, canceled/expiry savunma filtreli.
      this.db
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
          /*
           * §7 kurulum rehberi — YALNIZ KİMLİK. Gövde bilerek BU sorguda taşınmaz.
           *
           * İlk sürüm rehberin gövdesini de bu LEFT JOIN'e koyuyordu; sonuç satır başına
           * TEKRARLANIYORDU. 50 anahtarlı bir siparişte 4.000 karakterlik metin 50 kez
           * (≈200 KB) PG'den uygulamaya taşınıyordu — üstelik bu uç yalnız sayfa render'ında
           * değil, mağazanın CANLI YOKLAMASINDA da (8-60 sn'de bir, payload'sız durum özeti
           * için) çağrılıyor. Gövde artık aşağıdaki (5) numaralı BAĞIMSIZ sorgudan tekil
           * olarak gelir: ek round-trip YOK (aynı Promise.all), taşınan veri sabit.
           */
          guideId: products.guideId,
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
        )
        // SIRA: müşteri anahtarları STOĞA GİRİŞ sırasında görsün. ORDER BY hiç yoktu →
        // Postgres satırları planın uygun gördüğü sırada döndürüyordu; birden çok anahtarlı
        // siparişte My Account listesi her yenilemede farklı sıralanabiliyordu. `seq`
        // (ekleme sırası) hem burada hem mailde hem admin sipariş detayında AYNI yönde
        // kullanılır → müşteri, mail ve operatör aynı listeyi görür. (WP meta box'ı birincil
        // olarak `deliveredAt DESC` sıralar — kısmi teslimatta son parti üstte; eşitlikte o da
        // `seq` kullanır, yani tek teslimatlı olağan siparişte sıra aynıdır.)
        .orderBy(licenseItems.seq),
      // (2) Mail durumu (#32): siparişin EN GÜNCEL email_log satırının status'u (sent|failed|
      // queued|sending|…). WP "Sorun mu var?" ipucu için — PAYLOAD/KEY sızmaz, yalnız durum. Yoksa null.
      this.latestMailStatus(order.id),
      // (3) §7 kısmi ilerleme: teslim/toplam BİRİM (satır toplamı, iptal satır hariç).
      this.db
        .select({
          // TOPLAM = teslim edilmesi GEREKEN birim (hedef) = qty − canceled_units. Ham qty
          // kullanılırsa panelden kalıcı iptal edilen birim müşteriye "eksik teslimat" gibi
          // görünür (2/3) — oysa o birim hiç teslim edilmeyecek (fill-target.ts ile aynı tanım).
          total: sql<number>`coalesce(sum(greatest(${orderLines.qty} - ${orderLines.canceledUnits}, 0)), 0)`,
          fulfilled: sql<number>`coalesce(sum(${orderLines.fulfilledQty}), 0)`,
        })
        .from(orderLines)
        .where(and(eq(orderLines.orderId, order.id), eq(orderLines.canceled, false))),
      // (4) §7 durum bayrakları: tek geçişte suspended + expiredHidden (FILTER'lı).
      this.db
        .select({
          suspended: sql<number>`count(*) filter (where ${assignments.status} = 'suspended')`,
          // "Süresi doldu" bilgilendirmesi (§7/§11). Durum kümesi active + EXPIRED olmalı:
          // bayrak yalnız 'active' aransa, ExpiryService sweep'i (5 dk'da bir) tam bu satırları
          // 'expired' yaptığı ANDA kayboluyordu → bayrak KALICI durumu değil, sweep'in GECİKTİĞİ
          // ≤5 dakikalık pencereyi anlatıyordu. Sonuç: süresi dolan müşteri My Account'ta BOŞ
          // liste + SIFIR açıklama görüyor, sipariş ise 'fulfilled' duruyordu ("siparişim
          // kayboldu" talebi). 'expired' KALICI durumdur; 'active' ise yalnız sweep gecikmesini
          // kapsar — ikisi birlikte pencereden bağımsız DOĞRU cevabı verir.
          // `on_expiry='hide' AND valid_until < now()` koşulu kümeyi zaten daraltıyor:
          // 'keep' ürünler ve süresi geçmemiş atamalar sayılmaz.
          expiredHidden: sql<number>`count(*) filter (where ${assignments.status} in ('active','expired') and ${products.onExpiry} = 'hide' and ${assignments.validUntil} is not null and ${assignments.validUntil} < now())`,
        })
        .from(assignments)
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .innerJoin(products, eq(orderLines.productId, products.id))
        .where(eq(assignments.orderId, order.id)),
      /*
       * (5) §7 kurulum rehberleri — siparişin ÜRÜNLERİNDEN türetilir, atamalardan DEĞİL.
       *
       * `rows`a bağlı OLMADIĞI için aynı Promise.all'da paralel koşar (ek round-trip yok) ve
       * her rehber gövdesi TEK KEZ taşınır. `distinct` şart: aynı rehbere bağlı birden çok
       * satır varsa (çok kalemli sipariş) tekrar üretirdi.
       *
       * Kapsam BİLEREK sipariş satırlarıdır: teslim edilmemiş (pending) bir satırın rehberi de
       * gelir. Zararsızdır — yanıttaki kalemler `guideId` ile bağlanır, bağlanmayan rehber
       * eklentide hiç render edilmez; buna karşılık kısmi teslimatta sonradan gelen anahtar
       * için ikinci bir istek gerekmez.
       */
      this.db
        .selectDistinct({
          id: productGuides.id,
          title: productGuides.title,
          body: productGuides.body,
        })
        .from(orderLines)
        .innerJoin(products, eq(orderLines.productId, products.id))
        .innerJoin(productGuides, eq(products.guideId, productGuides.id))
        .where(and(eq(orderLines.orderId, order.id), eq(orderLines.canceled, false))),
    ]);
    const [agg] = aggRows;
    const [flags] = flagRows;

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
        // Rehberin yalnız KİMLİĞİ kaleme yazılır; metni `guides` dizisinde bir kez durur.
        guideId: r.guideId,
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

    /*
     * §7 kurulum/etkinleştirme rehberleri.
     *
     * Render (mini-biçimleme → güvenli HTML) PANELDE, tek uygulamayla yapılır: eklenti
     * ikinci bir ayrıştırıcı taşımaz (iki uygulama er geç ayrışır ve aynı metin iki
     * yüzeyde farklı görünür — bu projede tekrarlayan bir hata sınıfı).
     *
     * SIRA: `selectDistinct` sıra GARANTİ ETMEZ (Postgres hash-aggregate kullanabilir) →
     * başlığa göre sıralanır. Sırasız bırakılsaydı aynı sipariş her yenilemede rehberleri
     * farklı sırada gösterebilirdi (bu panelde "LIMIT'li her ORDER BY'ın tie-break'i olmalı"
     * dersinin aynısı; burada LIMIT yok ama kararsızlık aynı şekilde görünür).
     */
    const guides: RenderedGuide[] = guideRows
      .map((g) => renderGuide({ id: g.id, title: g.title, body: g.body }))
      .sort((a, b) => a.title.localeCompare(b.title, 'tr'));

    // F4: `held` (heldForReview) alanı — WP eklentisi İnceleme Kuyruğu durumunu (my-account bildirimi/
    // metabox rozeti) bu bayraktan okur. Eklemeli; mevcut alanlar (status/mailStatus/deliveries) değişmez.
    return {
      orderId: order.id,
      status: order.status,
      held: order.heldForReview,
      mailStatus,
      deliveries,
      guides,
      fulfilled: Number(agg?.fulfilled ?? 0),
      total: Number(agg?.total ?? 0),
      suspended: Number(flags?.suspended ?? 0) > 0,
      expiredHidden: Number(flags?.expiredHidden ?? 0) > 0,
    };
  }

  /** Siparişin en güncel teslimat maili durumu (#32) — yoksa null. */
  private async latestMailStatus(orderId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ status: emailLog.status })
      .from(emailLog)
      .where(eq(emailLog.orderId, orderId))
      // TIE-BREAK (id DESC) ŞART: aynı sipariş için birden çok mail kaydı TEK transaction'da
      // yazılabilir (teslimat + bildirim) ve `now()` tx başını döndürdüğü için createdAt
      // damgaları BİREBİR aynı olur → tie-break'siz LIMIT 1 KEYFİ satır seçer ve WP eklentisine
      // giden mail durumu iki çağrıda farklı çıkar. Yön AYNA olmalı (DESC + DESC).
      .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
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
            // `tx` GEÇİLMEK ZORUNDA: tx bir bağlantı tutarken kök havuzdan sorgu istemek,
            // advisory-lock bekleyen diğer isteklerle birlikte havuzu kilitler (bkz. loadOrderResult).
            duplicateOutcome = this.buildOutcome(await this.loadOrderResult(dup, tx));
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
            // `tx` ZORUNLU: transaction içinden kök havuzu (this.db) kullanmak İKİNCİ bir
            // bağlantı ister ve 10 eşzamanlı siparişte havuzu kilitler (bkz. products.getById).
            const mapping = await this.products.resolveMapping(
              site.id,
              line.remoteProductId,
              line.remoteVariationId,
              tx,
            );
            const requiredUnits = mapping ? line.qty * mapping.bundleQty : line.qty;
            await tx.insert(orderLines).values({
              orderId: order.id,
              productId: mapping?.productId ?? null,
              remoteLineId: line.remoteLineId,
              remoteProductId: line.remoteProductId,
              remoteVariationId: line.remoteVariationId ?? null,
              remoteName: line.remoteName ?? null,
              qty: requiredUnits,
              // Held satırda da ölçek anlık görüntüsü (0025) — onaylanınca aynı birim uzayında
              // teslim edilir, iade/resync yolları eşleme değişse de yanlış ölçekle hesaplamaz.
              bundleQty: mapping?.bundleQty ?? null,
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
          // `tx` ZORUNLU — havuz kilitlenmesi (bkz. products.getById üzerindeki not).
          const mapping = await this.products.resolveMapping(
            site.id,
            line.remoteProductId,
            line.remoteVariationId,
            tx,
          );

          if (!mapping) {
            // Eşleme yok — sipariş kaybolmaz, satır product_id=null pending kalır (§4).
            await tx.insert(orderLines).values({
              orderId: order.id,
              productId: null,
              remoteLineId: line.remoteLineId,
              remoteProductId: line.remoteProductId,
              remoteVariationId: line.remoteVariationId ?? null,
              remoteName: line.remoteName ?? null,
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

          // `tx` ZORUNLU — havuz kilitlenmesi (bkz. products.getById üzerindeki not).
          const product = await this.products.getById(mapping.productId, tx);
          const requiredUnits = line.qty * mapping.bundleQty;
          const policy = line.policyOverride ?? product.fulfillmentPolicy;

          const [ol] = await tx
            .insert(orderLines)
            .values({
              orderId: order.id,
              productId: mapping.productId,
              remoteLineId: line.remoteLineId,
              remoteProductId: line.remoteProductId,
              remoteVariationId: line.remoteVariationId ?? null,
              remoteName: line.remoteName ?? null,
              qty: requiredUnits,
              // Ölçeği SATIRA yaz (0025): eşleme sonradan değişse/silinse bile bu siparişin
              // birim uzayı sabit kalır → iade/resync yolları qty'yi yanlış ölçekte hesaplayıp
              // teslim edilmiş anahtarları geri almaz.
              bundleQty: mapping.bundleQty,
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

          // PERF: TEK çok-satırlı INSERT. Eskiden atanan HER BİRİM için ayrı INSERT…RETURNING
          // atılıyordu (tek-kullanımlık üründe allocate() kalem başına bir Allocation döndürür):
          // qty=500'lük bir satır 500 seri gidiş-dönüş demekti — hepsi transaction İÇİNDE, satır
          // kilitleri tutulurken ve havuzun (max 10) bir bağlantısı rezerveyken; kota açık sitede
          // ayrıca `pg_advisory_xact_lock(site)` altında, yani aynı mağazanın diğer siparişleri de
          // o süre boyunca serileşiyordu. Toplu yazım bu kod tabanının zaten kullandığı desendir
          // (stok import, supplier_claim_items) ve `consumeMultiUseCapacity` için AYNI maliyet
          // ölçülüp düzeltilmişti — tek-kullanımlık dal o düzeltmenin dışında kalmıştı.
          //
          // Chunk'lama, eşleme kuralı ve tutarlılık invaryantı TEK YERDE: `assignment-insert.ts`
          // (completeLine ile paylaşılır — iki kopya tutmak bu projede sapma üretir).
          const deliveredAt = new Date();
          const idByItem = await insertAssignments(
            tx,
            allocations.map((alloc) => ({
              orderId: order.id,
              lineId: orderLine.id,
              licenseItemId: alloc.licenseItemId,
              units: alloc.units,
              validUntil,
              deliveredAt,
            })),
          );
          for (const alloc of allocations) {
            assignmentResults.push({
              // `!` güvenli: `insertAssignments` her tahsis için bir kayıt okunduğunu
              // doğruluyor, aksi halde fırlatıyor (sipariş tamamen geri alınır).
              assignmentId: idByItem.get(alloc.licenseItemId)!,
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
        // Best-effort korunur ama SESSİZ DEĞİL (denetim C3): bu olay kota aşımının panelde
        // görünen TEK izidir; yutulursa mağaza 429 yerken /security ve günlük özet boş kalır.
        await this.security
          .recordQuotaExceeded(site.id, e.todayCount, e.limit)
          .catch((err: unknown) =>
            this.logger.warn(
              `Kota aşımı güvenlik olayı yazılamadı (site=${site.id}, count=${e.todayCount}): ${String(err)}`,
            ),
          );
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
      // Yazım yutulursa §8'in "hold sessizdi" boşluğu GERİ AÇILIR: sipariş incelemeye alınır,
      // müşteri bekler, panelde alarm çıkmaz. Best-effort davranış korunur, arıza görünür olur.
      await this.security
        .recordQuotaHeld(site.id, held.todayCount, held.threshold)
        .catch((err: unknown) =>
          this.logger.warn(
            `İnceleme (quota_review) güvenlik olayı yazılamadı (site=${site.id}, order=${result.orderId}): ${String(err)}`,
          ),
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
  /**
   * Satırın MAĞAZA adedi → PANEL birimi ölçeği (bundleQty).
   *
   * Sıra bilinçlidir:
   *   1. Eşlemesiz satır (`productId` NULL) → 1. `qty` mağaza birimindedir; ölçeklemek
   *      "çift ölçekleme"ye yol açardı (satır sonradan `linkLine` ile bağlanınca bir kez daha
   *      çarpılır → müşteriye hakkından fazla lisans).
   *   2. Satırın ANLIK GÖRÜNTÜSÜ (`bundleQty`, 0025) → teslimat anındaki gerçek ölçek.
   *   3. Canlı eşleme (eski satırlar için geriye dönük yol).
   *   4. Hiçbiri yoksa `null` → ölçek BİLİNMİYOR. Çağıran qty'ye DOKUNMAMALIDIR: eşleme
   *      kaldırıldığında ölçeği sessizce 1 saymak, teslim edilmiş CANLI anahtarları
   *      "aşırı teslim" sanıp iade YOKKEN geri alır (§2 ihlali).
   */
  private async resolveLineScale(
    siteId: string,
    line: { productId: string | null; bundleQty: number | null },
    remote: { remoteProductId: string; remoteVariationId?: string | null },
    // Transaction içinden çağrılır → kendi bağlantısını AÇMAMALI (havuz kilitlenmesi;
    // bkz. products.getById üzerindeki not).
    exec: Database = this.db,
  ): Promise<number | null> {
    if (!line.productId) return 1;
    if (line.bundleQty != null && line.bundleQty > 0) return line.bundleQty;
    const mapping = await this.products.resolveMapping(
      siteId,
      remote.remoteProductId,
      remote.remoteVariationId ?? null,
      exec,
    );
    return mapping?.bundleQty ?? null;
  }

  private async reconcileOrder(
    site: Site,
    order: Order,
    dto: CreateOrderRequest,
  ): Promise<CreateOrderOutcome | null> {
    // DENETİM M1 (para / §2-§3 bütünlüğü): eskiden bu gövde advisory-lock'suz + çok-transaction'lıydı.
    // İki eşzamanlı qty-azaltan re-push (WP'nin Action Scheduler + hook çift-tetiği — syncRefunds F1
    // düzeltmesinin gerekçesiyle AYNI sınıf) BAYAT fulfilledQty okuyup fazlalık birimleri İKİ KEZ geri
    // alabiliyor → müşterinin İADE ETMEDİĞİ CANLI anahtarlar karantinaya YANIYOR + partial-auto taze
    // stokla dolduruyordu. Artık TÜM azalış/qty-yazımı, sipariş advisory kilidinin (hashtext(order.id)
    // — syncRefunds/revokeOrderForSite/linkLine ile AYNI ad alanı) altında TEK transaction'da ve satır
    // kilitleri döngüden ÖNCE alınarak (kilit sırası: advisory→assignments→order_lines) koşar; qty
    // kilit altında TAZE okunur → say-sonra-yaz yarışı kapanır, çapraz-yol (reconcile↔syncRefunds)
    // serileşir. ARTIŞ dolumu (completeLine) kendi satır-kilidiyle serileştiğinden commit SONRASI
    // çalışır (linkLine→completeLine deseni) — advisory kilidini dolum süresince tutmaz.
    const increasedPartialAuto: string[] = [];
    const changedLineIds: string[] = [];
    // C3: mevcut siparişe SONRADAN eklenen (eşleşmeyen) kalemler — reconcileOrder onları teslim etmez.
    const unmatchedNewLines: string[] = [];
      /** fullSync ile silindiği anlaşılan satırlar (görünür olay için). */
      const removedLineIds: string[] = [];

    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${order.id}))`);
      // Kilit sırası (proje sözleşmesi): advisory → assignments → order_lines → orders. Siparişin
      // tüm atama + satır kilitleri döngüden ÖNCE alınır (ABBA deadlock önlenir; syncRefunds deseni).
      await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(eq(assignments.orderId, order.id))
        .orderBy(asc(assignments.id))
        .for('update');
      await tx
        .select({ id: orderLines.id })
        .from(orderLines)
        .where(eq(orderLines.orderId, order.id))
        .orderBy(asc(orderLines.id))
        .for('update');

      for (const dtoLine of dto.lines) {
        // Satırı TAZE oku (kilit altında) — remoteLineId ile eşle.
        const [line] = await tx
          .select()
          .from(orderLines)
          .where(
            and(eq(orderLines.orderId, order.id), eq(orderLines.remoteLineId, dtoLine.remoteLineId)),
          )
          .limit(1);
        if (!line) {
          // C3: mevcut siparişe SONRADAN eklenen kalem. reconcileOrder yalnız EŞLEŞEN satırları
          // uzlaştırır (yeni satırı yalnız ilk createOrder yolu insert+atar). Sessiz yok saymak
          // izsiz eksik-teslimat üretiyordu → operatör görebilsin diye aşağıda uyarı olayı yazılır.
          unmatchedNewLines.push(dtoLine.remoteLineId);
          continue;
        }
        if (line.canceled) continue; // İade/iptal terminal satır — DOKUNMA (§2).

        // Yeni gerekli birim = mağaza adedi × ÖLÇEK. Ölçek satırın anlık görüntüsünden (0025) →
        // yoksa canlı eşlemeden; eşlemesiz satırda 1 (qty MAĞAZA birimindedir).
        const scale = await this.resolveLineScale(site.id, line, dtoLine, tx);
        if (scale == null) {
          // Ölçek çözülemedi (eşleme kaldırılmış + anlık görüntü yok): qty'ye DOKUNMA. Aksi halde
          // bundleQty sessizce 1 sayılır → müşterinin CANLI anahtarları iade YOKKEN geri alınırdı.
          this.logger.warn(
            `Satır ölçeği çözülemedi (eşleme kaldırılmış, anlık görüntü yok) — qty korunuyor: ` +
              `line=${line.id} order=${order.id} remoteProduct=${dtoLine.remoteProductId}`,
          );
          continue;
        }
        const newQty = dtoLine.qty * scale;
        if (newQty === line.qty) continue; // (c) değişiklik yok.

        if (newQty > line.qty) {
          // (a) Artış: qty'yi yükselt; DOLUM commit SONRASI (completeLine kendi satır kilidiyle
          // serileşir → advisory kilidini dolum süresince tutmaya gerek yok, ABBA/kilit-uzatma riski yok).
          await tx.update(orderLines).set({ qty: newQty }).where(eq(orderLines.id, line.id));
          // Panelde KALICI iptal edilmiş birim varsa, mağaza adedi geri yükselse bile o birimler
          // DOLDURULMAZ (hedef = qty − canceled_units, fill-target.ts) — H1 bedava-lisans sınıfı.
          // Bu sessiz kalmasın: operatör "mağaza 3 diyor ama 2 teslim edildi" farkını görebilmeli.
          if ((line.canceledUnits ?? 0) > 0) {
            await tx.insert(fulfillmentEvents).values({
              orderId: order.id,
              type: 'order_edited',
              message:
                `Mağaza adedi ${line.qty} → ${newQty} yükseldi, ancak bu satırda panelden kalıcı ` +
                `iptal edilmiş ${line.canceledUnits} birim var; o birimler yeni anahtarla ` +
                `doldurulmaz. Gerçekten teslim edilmesi gerekiyorsa iptali gözden geçirin.`,
            });
          }
          if (line.productId) {
            // `tx` ZORUNLU — havuz kilitlenmesi (bkz. products.getById üzerindeki not).
            const product = await this.products.getById(line.productId, tx);
            const policy = line.policyOverride ?? product.fulfillmentPolicy;
            if (policy === 'partial-auto') increasedPartialAuto.push(line.id);
          }
        } else {
          // (b) Azalış: aşırı-teslim varsa (fulfilled > yeni qty) fazlayı AYNI tx'te (kilit altında)
          // geri al, sonra qty düş. revokeExcess artık tx'i (exec) alır → nested SAVEPOINT olarak koşar.
          if (line.fulfilledQty > newQty) {
            await this.revokeExcess(tx, site, line.id, line.fulfilledQty - newQty);
          }
          // ÇİFT SAYIM ÖNLEME: mağaza adedi D kadar DÜŞTÜYSE, mağaza o iptali kendi kaydına
          // işlemiş demektir → panelin `canceled_units` defterinden en fazla D birim düşülür.
          // Aksi halde aynı iptal iki kez sayılır (hem qty azalır hem defter dolu kalır) ve
          // hedef gereğinden küçük çıkıp müşterinin ÖDEDİĞİ hak sessizce kısılırdı.
          const drop = line.qty - newQty;
          const nextCanceled = Math.max(0, (line.canceledUnits ?? 0) - drop);
          await tx
            .update(orderLines)
            .set({
              qty: newQty,
              ...(nextCanceled !== (line.canceledUnits ?? 0) ? { canceledUnits: nextCanceled } : {}),
            })
            .where(eq(orderLines.id, line.id));
        }
        changedLineIds.push(line.id);
      }

      /*
       * MAĞAZADA SİLİNEN KALEM (§2) — yalnız `fullSync` işaretli push'ta.
       *
       * Mağaza "bu siparişin ŞU ANKİ TÜM kalemleri" dediyse, panelde olup gelmeyen satır
       * SİLİNMİŞ demektir. Eskiden hiçbir dal bunu ele almıyordu: satır `fulfilled`,
       * atamaları `active` kalıyor ve müşteri artık satın almadığı lisansları kullanmaya
       * devam ediyordu. Adet 3→1 hâli zaten doğruydu (revokeExcess); eksik olan 3→0'dı.
       *
       * SEMANTİK = İADE (adet-düşür değil): satır terminal (`canceled`) yapılır ve MAK/multi
       * kapasitesi havuza DÖNMEZ — harcanmış aktivasyon yeniden satılamaz (§2). `revokeExcess`
       * fazlalığı `line.fulfilledQty` kadar geri alır; burada hedef 0 olduğu için TÜMÜ.
       *
       * Bayrak YOKSA bu blok HİÇ çalışmaz → eski (güvenli) davranış korunur.
       */
      if (dto.fullSync === true) {
        const sent = new Set(dto.lines.map((l) => l.remoteLineId));
        const panelLines = await tx
          .select()
          .from(orderLines)
          .where(and(eq(orderLines.orderId, order.id), eq(orderLines.canceled, false)));
        for (const line of panelLines) {
          if (sent.has(line.remoteLineId)) continue;
          // Bonus satırları mağazada HİÇ yoktur (sentetik `bonus:` öneki) → silinmiş sayılmaz.
          if (line.remoteLineId.startsWith('bonus:')) continue;

          if (line.fulfilledQty > 0) {
            await this.revokeExcess(tx, site, line.id, line.fulfilledQty);
          }
          // `canceled` TERMİNAL işarettir (order_line_status enum'unda 'canceled' YOK — iptal
          // ayrı bir bayrakla taşınır, mevcut iade yollarıyla aynı desen). `qty`'ye DOKUNULMAZ:
          // mağaza gerçeği olarak kalır ve iptal edilen birimler `canceled_units` defterine
          // yazılır (revokeExcess bunu zaten yapar) — hedef `qty − canceled_units` ile 0 olur.
          await tx
            .update(orderLines)
            .set({ canceled: true })
            .where(eq(orderLines.id, line.id));
          removedLineIds.push(line.remoteLineId);
          changedLineIds.push(line.id);
        }
        if (removedLineIds.length > 0) {
          await tx.insert(fulfillmentEvents).values({
            orderId: order.id,
            type: 'order_edited',
            message:
              `Mağazada SİLİNEN ${removedLineIds.length} kalem uzlaştırıldı: ${removedLineIds.join(', ')}. ` +
              'Teslim edilmiş lisanslar geri alındı (iade semantiği — MAK kapasitesi havuza dönmez).',
          });
        }
      }

      // C3: eşleşmeyen yeni kalem varsa GÖRÜNÜR iz bırak (sessiz eksik-teslimat yerine). adet
      // değişmese bile yazılır → operatör "eklenen kalem işlenmedi" sinyalini sipariş detayında görür.
      if (unmatchedNewLines.length > 0) {
        await tx.insert(fulfillmentEvents).values({
          orderId: order.id,
          type: 'order_edited',
          message:
            `Siparişe sonradan eklenen ${unmatchedNewLines.length} kalem panelde İŞLENMEDİ ` +
            `(re-push yeni kalemi teslim etmez): ${unmatchedNewLines.join(', ')}. Gerekirse mağazadan yeniden senkronlayın.`,
        });
        this.logger.warn(
          `reconcileOrder: eşleşmeyen yeni kalem(ler) order=${order.id}: ${unmatchedNewLines.join(',')}`,
        );
      }

      if (changedLineIds.length === 0) return; // Hiç adet değişmedi → idempotent yol (tx boş).

      // Değişen satır + sipariş durumunu AYNI tx'te yeniden hesapla + edit izi.
      for (const lineId of changedLineIds) {
        const [l] = await tx.select().from(orderLines).where(eq(orderLines.id, lineId)).limit(1);
        if (!l) continue;
        // C3: durum HAM `qty` ile değil HEDEFLE (`qty − canceled_units`) türetilir — tek tanım
        // `fill-target.ts`. Yukarıdaki azalış dalı defteri uzlaştırdıktan sonra bile hedef qty'den
        // küçük kalabilir (kısmen iptal edilmiş satır); ham karşılaştırma o satırı SONSUZA DEK
        // 'partial' bırakıyordu → sipariş kalıcı 'partial', WP'de "eksik teslimat" görünür ve
        // satır her stok girişinde boşuna taranır.
        const status = lineStatusFor({
          qty: l.qty,
          canceledUnits: l.canceledUnits,
          fulfilledQty: l.fulfilledQty,
        });
        await tx.update(orderLines).set({ status }).where(eq(orderLines.id, lineId));
      }
      await recomputeOrderStatus(tx, order.id);
      await tx.insert(fulfillmentEvents).values({
        orderId: order.id,
        type: 'order_edited',
        message: `Sipariş adedi güncellendi (re-push) — ${changedLineIds.length} satır`,
      });
    });

    if (changedLineIds.length === 0) return null; // Hiç adet değişmedi → idempotent yol.

    // ARTIŞ dolumu (commit SONRASI): partial-auto satırlarda stok elverdiğince farkı kapat.
    // completeLine kendi tx'i + satır FOR UPDATE'iyle over-delivery'yi önler (linkLine→completeLine deseni).
    for (const lineId of increasedPartialAuto) {
      await this.fulfillment.completeLine(lineId);
    }

    const [fresh] = await this.db.select().from(orders).where(eq(orders.id, order.id)).limit(1);
    return this.buildOutcome(await this.loadOrderResult(fresh ?? order));
  }

  /**
   * Bir satırın AKTİF atamalarını (en yeni önce) `excessUnits` birim karşılanana dek geri alır
   * (#16 azalış). ÇAĞIRANIN advisory-kilitli transaction'ı (`exec`) İÇİNDE koşar → aktif küme TAZE
   * ve kilitli okunur, revoke'lar nested SAVEPOINT olarak aynı bağlantı/kilitlerde gider (DENETİM M1).
   * Sayaç YALNIZ GERÇEK revoke'ta ilerler: revokeAssignment idempotent `{already:true}` (no-op) dönerse
   * (yarışta başka yol revoke etmiş) fazladan atama geri almamak için sayılmaz (over-revoke düzeltmesi).
   */
  private async revokeExcess(
    exec: Database,
    site: Site,
    lineId: string,
    excessUnits: number,
  ): Promise<void> {
    // (Denetim H1 sınıfı — adversaryel sweep) active + suspended: askıdaki atama da fulfilledQty'ye
    // dahildir ve CANLI hak taşır (sonradan "Geri aç" ile aktifleşir). Adet-düşür yolu yalnız
    // active geri alsaydı, fazlalık yalnız suspended'dayken hiç geri alınamaz → satır over-fulfilled
    // kalır ve suspended atama sağ kalır → geri açılınca adedi düşürülen siparişte bedava lisans.
    // revokeAssignment/revokePartialUnits ikisi de suspended'ı işler (H1 düzeltmesiyle).
    //
    // markLineCanceled=false: adedi düşürülen satır AKTİF kalır (adet yeniden artarsa doldurulabilir).
    //
    // returnMultiCapacity=**false** (DÜZELTİLDİ — §2 ihlaliydi): burası "adet-düşür = iade DEĞİL"
    // gerekçesiyle kapasiteyi havuza GERİ VERİYORDU, oysa MAĞAZA İADESİ bu yola da düşüyor:
    // WP `collect_lines` push'a NET adet (brüt − iade) yazar, yani bir iade `/refund` işi yerine
    // (ör. o iş 3 denemede kalıcı başarısız olduysa, ya da admin aynı istekte kalem düzenlediyse)
    // `resync` → `POST /v1/orders` → `reconcileOrder` azalış dalı → BURASI olarak uzlaşabilir.
    // O durumda `syncRefunds` `use_count`'u KORURKEN (§2: "iadede MAK hakkı havuza dönmez") bu yol
    // düşürüyordu → HARCANMIŞ aktivasyonlar tekrar satılabilir hâle geliyordu (sessiz aşırı-satış).
    // Teslimattan SONRA adedin düşmesi MAK için iadeyle fiziksel olarak aynıdır — hangi yoldan
    // geldiğini ayırt edemeyiz, bu yüzden §2'nin ihtiyatlı kuralı iki yolda da uygulanır.
    // Satırın yeniden doldurulması taze anahtarla yapılır (eski MAK anahtarına kapasite iade
    // etmek gerekmez) — AMA bu ancak HAVUZDA STOK VARSA mümkündür. Kabul edilen yan etki:
    // ürünün tek anahtarı varsa ve o tükendiyse, `qty 5→3` sonrası `3→5` artışı DOLDURULAMAZ ve
    // satır `partial 3/5` kalır (operatör stok girer, tamamlama motoru devralır). Bu §2'nin
    // bilinçli ihtiyatlı yönüdür: harcanmış aktivasyonu yeniden satmaktansa eksik teslim edip
    // insan müdahalesi beklemek tercih edilir.
    // SIRA ÖNEMLİ — hangi anahtarın öleceğini bu belirler:
    //  1) ÖNCE askıdakiler: `suspended` atama zaten devre dışı bırakılmış (operatör bilerek
    //     kapatmış). Fazlalığı ondan düşmek, müşterinin KULLANDIĞI canlı bir anahtarı
    //     öldürmekten her zaman daha az zararlıdır. Eskiden sıra yalnız tarihe bakıyordu →
    //     kısmi iadede canlı anahtar ölüp askıdaki sağ kalabiliyordu.
    //  2) sonra en YENİ atama (eski teslimatlar korunur),
    //  3) son olarak `id` — tie-break ŞART: bir siparişin atamaları TEK transaction'da
    //     yazıldığı için `created_at` damgaları BİREBİR aynıdır; tie-break'siz sıralamada
    //     hangi anahtarın geri alınacağı keyfi olur ve iki koşuda değişebilir.
    const active = await exec
      .select({ id: assignments.id, units: assignments.units })
      .from(assignments)
      .where(and(eq(assignments.lineId, lineId), inArray(assignments.status, ['active', 'suspended'])))
      .orderBy(
        sql`(${assignments.status} = 'suspended') desc`,
        desc(assignments.createdAt),
        desc(assignments.id),
      );

    const actor = `site:${site.domain ?? site.id}`;
    const reason = 'Sipariş adedi düşürüldü (re-push)';
    let revoked = 0;
    for (const a of active) {
      if (revoked >= excessUnits) break;
      const need = excessUnits - revoked;
      if (a.units <= need) {
        // Bu atamanın TAMAMI fazlalığa sığıyor → tam revoke (tek→karantina, multi→kapasite geri).
        // markLineCanceled=false: adedi düşürülen satır AKTİF kalır (ileride adet artarsa doldurulabilir).
        const res = await this.adminOrders.revokeAssignment(a.id, reason, actor, false, exec, false);
        // Yalnız GERÇEK revoke sayılır — idempotent {already:true} no-op fazladan atama geri aldırmaz.
        if (!('already' in res)) revoked += a.units;
      } else {
        // #19 birim-granüler: atama fazladan büyük (multi/MAK) → yalnız `need` birimi geri al, imha etme.
        // Tek-kullanımda a.units=1 ⇒ need≥1 ⇒ bu dala hiç girilmez.
        const res = await this.adminOrders.revokePartialUnits(a.id, need, reason, actor, exec, false);
        revoked += res.revoked; // gerçekten geri alınan birim (atama aktif değilse 0)
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
        // İptal (canceled) satırlar ilerlemeye GİRMEZ — getDeliveries'in aynı amaçlı toplamı da
        // onları eliyordu; filtre burada yokken WP'nin yokladığı "teslim/toplam" ile müşterinin
        // My Account'ta gördüğü ilerleme çelişiyordu (payda iptal edilen adedi içeriyordu).
        // WHERE değil FILTER: satırlarının HEPSİ iptal edilmiş sipariş yanıttan düşmemeli
        // (WP o siparişi de yokluyor; 0/0 dönmesi doğru cevaptır).
        fulfilled: sql<number>`coalesce(sum(${orderLines.fulfilledQty}) filter (where ${orderLines.canceled} = false), 0)::int`,
        total: sql<number>`coalesce(sum(greatest(${orderLines.qty} - ${orderLines.canceledUnits}, 0)) filter (where ${orderLines.canceled} = false), 0)::int`,
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

  /**
   * Mevcut siparişin sonucunu (idempotent tekrar için) yeniden kurar.
   *
   * `exec`: bir TRANSACTION İÇİNDEN çağrılıyorsa o transaction'ın executor'ı MUTLAKA geçilmelidir
   * (products.getById / resolveMapping ile aynı sözleşme). postgres.js'te `transaction()` bir
   * bağlantıyı rezerve eder; gövdeden kök havuza (`this.db`) sorgu atmak İKİNCİ bir bağlantı ister.
   * Havuz max:10 iken kilit altındaki tx'ler bağlantıları tutarken bu talep dairesel beklemeye
   * dönüşür (bu kod tabanında createOrder ve supplier-claims'te k6 ile ÖLÇÜLDÜ: tam havuz açlığı,
   * /v1/health dahil her şey bağlantısız). Tx DIŞINDAKİ çağıranlar varsayılanla devam eder.
   */
  private async loadOrderResult(
    order: Order,
    exec: Pick<Database, 'select'> = this.db,
  ): Promise<CreateOrderResponse> {
    const lines = await exec.select().from(orderLines).where(eq(orderLines.orderId, order.id));
    const asgs = await exec.select().from(assignments).where(eq(assignments.orderId, order.id));

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
