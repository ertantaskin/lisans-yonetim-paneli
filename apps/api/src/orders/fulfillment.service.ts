import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
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
import { notExpiredCond, releaseAllocations } from '../assignment/assign';
import { insertAssignments } from './assignment-insert';
import { recomputeOrderStatus } from './order-status';
import { fillTarget, lineStatusFor, remainingUnits } from './fill-target';

export interface CompleteResult {
  lineId: string;
  orderId: string;
  requested: number;
  fulfilledBefore: number;
  added: number;
  fulfilledAfter: number;
  status: string;
  /**
   * BU turda OLUŞTURULAN atama id'leri (added=0 ise boş dizi).
   *
   * Soyağacı (assignment_history) için gereklidir: `recordReplacementLineage` eskiden "satırın EN
   * YENİ aktif ataması"nı tahmin ediyordu → aynı satırda eşzamanlı iki değişimde soyağacı YANLIŞ
   * atamaya bağlanabiliyordu. Çağıran artık kendi ürettiği atamanın id'sini KESİN bilir.
   * Opsiyonel (mevcut tüketicileri kırmaz); ana yolda her zaman doldurulur.
   */
  createdAssignmentIds?: string[];
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
   *
   * `exec` (değişim atomikliği): VERİLMEZSE davranış birebir eskisi gibidir — kendi transaction'ını
   * açar, commit eder ve yan etkileri (teslimat maili + geri-kanal webhook) kendisi tetikler.
   * DIŞ BİR TRANSACTION verilirse (`revokeAssignment`'ın `exec` sözleşmesiyle aynı):
   *   - çekirdek o tx içinde SAVEPOINT olarak koşar → revoke + yeniden atama TEK atomik birim olur
   *     (added=0'da çağıran throw edip rollback yaparsa REVOKE DA GERİ ALINIR → müşteri anahtarı canlı kalır),
   *   - yan etkiler ÇALIŞTIRILMAZ; çağıran COMMIT'ten SONRA `emitCompletionEffects(result)` çağırmalıdır.
   *     (Aksi halde ayrı bağlantıdan okunan `orders` satırı henüz commit EDİLMEMİŞ durumu görür →
   *     yanlış webhook olayı; rollback olursa da olmamış bir teslimat için mail/webhook giderdi.)
   */
  async completeLine(
    lineId: string,
    maxUnits?: number,
    isReplacement = false,
    exec?: Database,
  ): Promise<CompleteResult> {
    // Dış tx verildiyse yan etkiler ÇAĞIRANA bırakılır (commit sonrası). Kök db açıkça geçilirse
    // (tx değil) eski yol korunur — sözleşme "açık transaction mı" sorusuna bakar.
    const deferEffects = exec !== undefined && exec !== this.db;
    const runner = exec ?? this.db;
    const result = await runner.transaction(async (tx) => {
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

      // Hedef = qty − canceled_units (fill-target.ts, TEK tanım). `qty` mağaza gerçeğidir ve
      // re-push onu yeniden yazar; operatörün panelden kalıcı iptal ettiği birimler ayrı
      // deftere yazıldığı için re-push onları GERİ AÇAMAZ (H1 bedava-lisans sınıfı kapalı).
      const remaining = remainingUnits(line);
      const toAssign = maxUnits ? Math.min(remaining, maxUnits) : remaining;
      if (toAssign <= 0) {
        return this.noop(line.id, line.orderId, line.qty, line.fulfilledQty, line.status);
      }

      // `tx` ZORUNLU — transaction içinden kök havuzu kullanmak ikinci bir bağlantı ister ve
      // eşzamanlı siparişte havuzu kilitler (bkz. products.getById üzerindeki not).
      const product = await this.products.getById(line.productId, tx);

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
      //
      // F1 (regresyon düzeltmesi): "tümüyle" hedefi ÇAĞRI TİPİNE göre belirlenir. YALNIZ değişim
      // (isReplacement) akışları — revoke + completeLine(lineId, 1, true) — tüm satırı değil, zaten
      // teslim edilmiş `toAssign` birimi tazeler → hedef = min(qty, fulfilled+toAssign); aksi halde
      // kısmen teslim edilmiş (ör. 3/6, #16 re-push) all-or-nothing satırda tek-birim değişim "stok
      // yok" sanılır (taze key serbest, eski key karantinada → müşteri lisansı KALICI kaybeder).
      // NOT (2. denetim düzeltmesi): rölaks YALNIZ isReplacement'te; manuel "N Adet Ata" ucu
      // (POST /admin/fulfillments/:lineId/complete?units=N — revoke YOK) isReplacement=false ile gelir,
      // hedef = qty kalır → all-or-nothing satır kısmen teslim EDİLMEZ (§5 "kısmi teslim yasak" korunur).
      // Taze teslim / releaseHeld (maxUnits yok) da hedef = qty.
      const target =
        isReplacement && maxUnits != null
          ? Math.min(fillTarget(line), line.fulfilledQty + toAssign)
          : fillTarget(line);
      if (policy === 'all-or-nothing' && line.fulfilledQty + added < target) {
        await releaseAllocations(tx, allocations);
        allocations.length = 0;
        added = 0;
      }

      const validUntil = product.validityDays
        ? new Date(Date.now() + product.validityDays * 86_400_000)
        : null;
      // Oluşan atama id'leri sonuca taşınır → soyağacı "en yeni aktif atama" TAHMİNİNE muhtaç kalmaz.
      // PERF: TEK çok-satırlı INSERT (createOrder ile aynı gerekçe — birim başına ayrı
      // gidiş-dönüş, transaction içinde ve kilitler tutulurken). Sıra `allocations`
      // dizisinden gelir; RETURNING'in giriş sırasını koruduğuna GÜVENİLMEZ, eşleme
      // `licenseItemId` üzerinden yapılır (bir dizide aynı kalem iki kez geçmez).
      const deliveredAt = new Date();
      const idByItem = await insertAssignments(
        tx,
        allocations.map((alloc) => ({
          orderId: line.orderId,
          lineId: line.id,
          licenseItemId: alloc.licenseItemId,
          units: alloc.units,
          validUntil,
          deliveredAt,
        })),
      );
      const createdAssignmentIds = allocations.map((a) => idByItem.get(a.licenseItemId)!);

      const fulfilledAfter = line.fulfilledQty + added;
      const status = lineStatusFor({ ...line, fulfilledQty: fulfilledAfter });
      await tx
        .update(orderLines)
        .set({ fulfilledQty: fulfilledAfter, status })
        .where(eq(orderLines.id, line.id));

      if (added > 0) {
        await tx.insert(fulfillmentEvents).values({
          orderId: line.orderId,
          type: 'line_completed',
          // İlerleme HEDEFE göre yazılır (`qty − canceled_units`), ham `qty`'ye göre DEĞİL.
          // Aksi halde panelden 1 birimi iptal edilmiş qty=3'lük bir satırda zaman çizelgesi
          // KALICI "2/3" derken, aynı verinin diğer TÜM yüzeyleri (müşteri teslimatı, mağaza
          // durum yoklaması, "neden bekliyor" tanısı, SLA raporu) "2/2" der — operatör eksik
          // teslimat sanır. Hedefin tek tanımı `fill-target.ts`.
          message: `Satır ${line.remoteLineId}: +${added} atandı (${fulfilledAfter}/${fillTarget(line)})`,
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
        createdAssignmentIds,
      };
    });

    if (!deferEffects) await this.emitCompletionEffects(result);
    return result;
  }

  /**
   * `completeLine` yan etkileri (teslimat/güncelleme maili + geri-kanal webhook) — COMMIT SONRASI.
   *
   * Kendi transaction'ını açan çağrılarda otomatik tetiklenir; DIŞ transaction geçen çağıranlar
   * (değişim akışları) commit'ten sonra KENDİLERİ çağırır. Hiç throw etmez: mail/webhook
   * best-effort'tur, teslimatı DÜŞÜRMEZ.
   */
  async emitCompletionEffects(result: CompleteResult): Promise<void> {
    // KRİTİK: mail ve webhook AYRI try/catch (createOrder deseni). webhook.emit outbox_events
    // satırını queue.add'den ÖNCE yazar → mail enqueue hatası webhook'u ENGELLEMEMELİ; aksi halde
    // 'order.fulfilled' olayı ne WP'ye gider ne /ops dead-letter'dan replay edilebilir (kalıcı kayıp).
    if (result.added > 0) {
      let order: typeof orders.$inferSelect | undefined;
      try {
        [order] = await this.db
          .select()
          .from(orders)
          .where(eq(orders.id, result.orderId))
          .limit(1);
      } catch (err) {
        this.logger.warn(
          `completeLine sonrası sipariş yüklenemedi (order ${result.orderId}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (order) {
        // 1) Teslimat/güncelleme maili — hatası webhook'u ETKİLEMEZ (ayrı blok).
        try {
          await this.mail.enqueueDelivery(
            order.id,
            order.customerEmail,
            `Siparişiniz güncellendi — ${order.remoteOrderId}`,
          );
        } catch (err) {
          this.logger.warn(
            `completeLine sonrası teslimat maili kuyruğa alınamadı (order ${result.orderId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        // 2) Geri kanal webhook — tamamlanma sonrası güncel durum (§2). Bağımsız blok:
        // outbox satırı burada yazılır → mail patlasa bile olay replay edilebilir kalır.
        try {
          const evt =
            order.status === 'fulfilled' ? 'order.fulfilled' : 'order.partially_fulfilled';
          await this.webhook.emit(order.siteId, order.id, evt, {
            status: order.status,
            remoteOrderId: order.remoteOrderId,
          });
        } catch (err) {
          this.logger.warn(
            `completeLine sonrası geri-kanal webhook yazılamadı (order ${result.orderId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
  }

  /**
   * Bir sipariş satırının ürününde ŞU AN atanabilir (available + kapasitesi kalan) lisans SATIRI
   * sayısı. Değişim akışlarının hem ÖN-kontrolü hem de "added=0 gerçekten stok yok muydu?"
   * SONRASI ayrımı için TEK KAYNAK (aynı sorgu iki yerde kopyalanmasın).
   *
   * DİKKAT: eşzamanlı bir atama tarafından `FOR UPDATE SKIP LOCKED` ile KİLİTLENMİŞ satırlar bu
   * sayımda HÂLÂ görünür (kendi anlık görüntümüzde 'available'dırlar) — istenen budur: added=0
   * gelmesine rağmen sayı > 0 ise sebep "stok yok" değil ÇEKİŞMEDİR ("tekrar deneyin").
   *
   * KÜME EŞİTLİĞİ — ZORUNLU İNVARYANT (regresyon dersi): bu sayımın seçtiği küme, GERÇEK atama
   * sorgularının (assignment/assign.ts) seçtiği kümeyle BİREBİR aynı olmalıdır. Aksi halde sayım
   * "stok var" der, atama 0 döner ve çağıran (admin replace / replacements.approve) bunu ÇEKİŞME
   * sanıp SONSUZ "eşzamanlı işlem sürüyor, tekrar deneyin" döngüsü üretir → operatör değişimi
   * hiç tamamlayamaz. Koşullar tek tek atama sorgusundan kopyalanmıştır:
   *   · status='available'                      (her iki atama sorgusu)
   *   · notExpiredCond()                        (stok ömrü dolmuş kalem ATANAMAZ — bu koşul
   *     agregasyonlara eklenirken burada UNUTULMUŞTU; sonsuz döngünün kök nedeni buydu)
   *   · use_count < max_uses  —  consumeMultiUseCapacity ile artık BİREBİR aynı yüklem
   *     (toplu kapasite düşümüne geçilirken eski `use_count + 1 <= max_uses` biçimi de bu
   *     hâle geldi; iki yüklem tamsayıda zaten özdeşti). Tek kullanımlıkta da doğru:
   *     assignAvailableSingleUse use_count'a
   *     DOKUNMAZ, releaseAllocations GREATEST(0, …) ile 0'da tutar → available tek-kullanım
   *     kaleminde daima use_count=0 < max_uses=1. Yani tek-kullanım davranışı birebir korunur.
   * Kasıtlı TEK fark: FOR UPDATE SKIP LOCKED yoktur (yukarıdaki "çekişme" ayrımı bunu ister).
   *
   * `exec`: dış transaction verilebilir (revoke sonrası KENDİ tx'imizin etkisini görmek için).
   */
  async allocatableCountForLine(lineId: string, exec: Database = this.db): Promise<number> {
    const [row] = await exec
      .select({ n: sql<number>`count(*)::int` })
      .from(licenseItems)
      .innerJoin(orderLines, eq(orderLines.id, lineId))
      .where(
        and(
          eq(licenseItems.productId, orderLines.productId),
          eq(licenseItems.status, 'available'),
          // Drizzle sorgu kurucusu tabloyu takma adsız basar → alias = tablo adı.
          notExpiredCond('license_items'),
          sql`${licenseItems.useCount} < ${licenseItems.maxUses}`,
        ),
      );
    return Number(row?.n ?? 0);
  }

  /**
   * +1 BONUS atama (§7 meta box "+1 bonus atama"). Referans satırın ürününden TEK ekstra key'i
   * siparişe ekler — operatör jesti (ör. özür/telafi). Woo qty'sinden BAĞIMSIZ bir hediyedir.
   *
   * KRİTİK (denetim): bonus, referans satırın qty'sini ŞİŞİRMEZ. Bunun yerine AYRI, SENTETİK bir
   * order_line'a (remoteLineId = `bonus:<uuid>` → Woo ASLA bu id'yi göndermez) konur. Böylece
   * reconcileOrder (yalnız remoteLineId ile EŞLEŞEN satırları uzlaştırır) ve syncRefunds (yalnız
   * gelen refund satırlarını işler) bonusu GÖRMEZ → sonraki ilgisiz bir Woo düzenlemesi/iadesi
   * "fazlalık" sanıp bonusu SESSİZCE GERİ ALMAZ. Bonus satırı qty=fulfilled=added (fulfilled ≤ qty
   * invaryantı + reconcile Σ tutar). İptal/iade edilmiş (canceled) referans satıra ve inceleme (held)
   * siparişine bonus verilmez. Yan-etki maili çağıran (siteBonus) tarafında best-effort kuyruğa alınır.
   */
  async bonusAssign(
    refLineId: string,
    actor: string,
  ): Promise<{ lineId: string; orderId: string; added: number }> {
    return this.db.transaction(async (tx) => {
      const [ref] = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.id, refLineId))
        .limit(1)
        .for('update');
      if (!ref) throw new NotFoundException('Sipariş satırı bulunamadı');
      if (ref.canceled) throw new BadRequestException('İptal/iade edilmiş satıra bonus verilemez');
      if (!ref.productId) throw new BadRequestException('Ürünü eşlenmemiş satıra bonus verilemez');

      const [ord] = await tx
        .select({ held: orders.heldForReview })
        .from(orders)
        .where(eq(orders.id, ref.orderId))
        .limit(1);
      if (ord?.held) throw new BadRequestException('İnceleme altındaki siparişe bonus verilemez');

      // `tx` ZORUNLU — havuz kilitlenmesi (bkz. products.getById üzerindeki not).
      const product = await this.products.getById(ref.productId, tx);
      // Ön sipariş/stoksuz kapısı (§11): release_at gelecekteyse bonus atama yapılmaz.
      if (
        product.stockless &&
        product.releaseAt &&
        new Date(product.releaseAt).getTime() > Date.now()
      ) {
        throw new ConflictException('Bonus için stok yok (ön sipariş penceresi)');
      }

      const allocations = await allocate(tx, product, 1);
      const added = allocations.reduce((s, a) => s + a.units, 0);
      if (added < 1) {
        await releaseAllocations(tx, allocations);
        throw new ConflictException('Bonus için stok yok');
      }

      // Sentetik bonus satırı — remoteLineId = `bonus:<orijinWooItemId>:<uuid>`. Woo bu id'yi ASLA
      // göndermez → reconcile/syncRefunds (tam remoteLineId eşleştirir) DOKUNMAZ; ama origin Woo
      // kalemini gömdüğümüz için WP tarafı bonus'u DOĞRU ürün satırının altında gösterebilir
      // (item N için `bonus:N:` önekli atamaları o satıra grupla).
      const [bonusLine] = await tx
        .insert(orderLines)
        .values({
          orderId: ref.orderId,
          productId: ref.productId,
          remoteLineId: `bonus:${ref.remoteLineId}:${randomUUID()}`,
          qty: added,
          fulfilledQty: added,
          status: 'fulfilled',
        })
        .returning({ id: orderLines.id });

      const validUntil = product.validityDays
        ? new Date(Date.now() + product.validityDays * 86_400_000)
        : null;
      for (const alloc of allocations) {
        await tx.insert(assignments).values({
          orderId: ref.orderId,
          lineId: bonusLine!.id,
          licenseItemId: alloc.licenseItemId,
          units: alloc.units,
          validUntil,
          status: 'active',
          deliveredAt: new Date(),
        });
      }

      await tx.insert(fulfillmentEvents).values({
        orderId: ref.orderId,
        type: 'bonus_assigned',
        message: `Bonus atama (+${added}) — ${actor}`,
      });
      await recomputeOrderStatus(tx, ref.orderId);

      return { lineId: bonusLine!.id, orderId: ref.orderId, added };
    });
  }

  /**
   * Stok girişinde tetiklenir (§5). partial-auto ürünlerin bekleyen satırlarını
   * FIFO (öncelik desc, created_at asc) tarar ve stok bitene kadar tamamlar.
   *
   * `maxLines` (perf offload): VERİLMEZSE davranış BİREBİR eskisi gibidir — tüm bekleyen
   * satırlar (stok bitene dek) işlenir; `hasMore` daima false döner. VERİLİRSE en fazla o kadar
   * bekleyen satır işlenir; cap'e takılıp DAHA fazla bekleyen satır kaldıysa `hasMore=true` döner.
   * Böylece çağıran (stok import ucu) HTTP isteğini bloklamadan inline yalnız CAP satır tamamlar,
   * kalanı arka plan kuyruğuna atar (bkz. AutocompleteProcessor). Cap, taze teslimat/atama
   * mantığını, SKIP LOCKED erken-çıkışını, held-atlamayı ve all-or-nothing'i HİÇ değiştirmez —
   * yalnız TEK bir turda kaç satırın taranacağını sınırlar.
   *
   * @returns `completed` = added>0 ile tamamlanan satır sayısı (eski `number` dönüşün karşılığı);
   *   `hasMore` = cap'e takıldı ve işlenmemiş bekleyen satır var (çağıran kalanı arka plana atmalı).
   */
  async autoCompleteProduct(
    productId: string,
    maxLines?: number,
  ): Promise<{ completed: number; hasMore: boolean }> {
    // Ön sipariş kapısı: ürün stoksuz + release_at gelecekteyse stok girmiş olsa bile
    // hiçbir satır tamamlanmaz → boşuna satır taramadan erken çık (completeLine ayrıca savunur).
    const product = await this.products.getById(productId);
    if (
      product.stockless &&
      product.releaseAt &&
      new Date(product.releaseAt).getTime() > Date.now()
    ) {
      return { completed: 0, hasMore: false };
    }

    // Cap sınırı (yalnız pozitif tamsayı): 0/negatif/NaN verilirse sınırsız kabul edilir
    // (yanlış konfig ürünü açıkta bırakmasın). undefined → eski (sınırsız) davranış.
    const cap =
      maxLines != null && Number.isFinite(maxLines) && maxLines > 0
        ? Math.floor(maxLines)
        : null;

    const pendingQuery = this.db
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
      /*
       * TIE-BREAK (orderLines.id) ŞART — bu, teslimat motorunun FIFO penceresidir.
       *
       * Aynı siparişin TÜM satırları tek transaction'da yazılır ve `now()` tx başını
       * döndürdüğü için `created_at` damgaları BİREBİR aynıdır (bu projede ölçüldü: aynı
       * damgayı paylaşan binlerce olay/satır grubu var). Tie-break olmadan:
       *   (a) eşit öncelik + eşit tarihte HANGİ satırın önce teslim edileceği KEYFİ,
       *   (b) `limit(cap+1)` penceresine hangi satırların gireceği KEYFİ → arka plana atılan
       *       kalan küme her turda değişir ve bir satır turlar boyunca sürekli atlanabilir.
       * Yön ayna: sıralama ASC olduğu için tie-break de ASC (bkz. migration 0031 dersi).
       */
      .orderBy(sql`${orderLines.priority} desc`, asc(orderLines.createdAt), asc(orderLines.id));

    // PERF (denetim bulgusu): cap yalnız İŞLEMEYİ sınırlıyordu, ÇEKMEYİ değil — eşleşen TÜM
    // bekleyen satırlar okunup sıralanıyor, sonra ilk 200'ü işleniyordu. Büyük bir backlog'da
    // her arka plan turu aynı tam listeyi baştan çekip yeniden sıralar (O(N²/cap)). Artık
    // SQL de sınırlı; "tavan+1" projenin standart deseni (bkz. audit/quarantine listeleri):
    // fazladan gelen tek satır, kırpma olup olmadığını SESSİZCE değil AÇIKÇA söyler.
    const pending = cap != null ? await pendingQuery.limit(cap + 1) : await pendingQuery;

    let completedLines = 0;
    let processed = 0;
    let hasMore = false;
    for (const { id } of pending) {
      // Cap'e ulaşıldı ve hâlâ işlenmemiş satır VAR → kalanı çağıran arka plana atsın.
      if (cap != null && processed >= cap) {
        hasMore = true;
        break;
      }
      processed++;
      const res = await this.completeLine(id);
      if (res.added > 0) completedLines++;
      if (res.status !== 'fulfilled') {
        // Satır tamamlanmadı. Erken-çıkış açığı (§5): completeLine, allocate'in
        // FOR UPDATE SKIP LOCKED'ı yüzünden eşzamanlı bir tamamlama satırları
        // kilitlediyse added=0 dönebilir — stok bitmediği halde. Bu yüzden yalnız
        // GERÇEK stok tükenişinde dur; stok hâlâ varsa (kilitli/serbest) kalan
        // satırlara devam et, aksi halde bekleyen düşük-öncelikli satırlar açıkta kalır.
        // NOT: stok tükendiğinde hasMore=false kalır — kalanı arka plana atmanın anlamı yok
        // (stok yok); cap'e takılmak ile stok tükenmesi bilinçli olarak AYRI durumlardır.
        if ((await this.productAvailableCount(productId)) <= 0) break;
      }
    }
    return { completed: completedLines, hasMore };
  }

  /**
   * Ürün başına anlık SATILABİLİR kapasite (single: satır; multi: kalan max_uses−use_count).
   *
   * `StockService.availableCount` ile AYNI kavram, AYNI yüklem: status='available' +
   * notExpiredCond (tek kaynak assignment/assign.ts). Süre koşulu buradan eksik kalırsa
   * autoCompleteProduct'ın erken-çıkış kontrolü "stok var" sanır → gerçekte atanamayan
   * (süresi geçmiş) kapasite yüzünden bekleyen TÜM satırlar boşuna taranır (satır başına bir
   * transaction) ve süpürme asla durmaz.
   */
  private async productAvailableCount(productId: string): Promise<number> {
    const [row] = await this.db
      .select({
        count: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(licenseItems)
      .where(
        and(
          eq(licenseItems.productId, productId),
          eq(licenseItems.status, 'available'),
          notExpiredCond('license_items'),
        ),
      );
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
      // Atama yapılmadı → soyağacı bağlanacak taze atama YOK (çağıran boş diziyi güvenle okur).
      createdAssignmentIds: [],
    };
  }
}
