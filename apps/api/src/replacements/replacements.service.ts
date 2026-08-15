import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { assignments, orderLines, orders, products, type Site } from '../db/schema';
// Bu modül henüz index.ts barrel'ına eklenmedi (orkestratör ekler) → doğrudan dosyadan al.
import {
  replacementMessages,
  replacementRequests,
  replacementStatusEnum,
  type ReplacementRequest,
} from '../db/schema/replacementRequests';
import { securityEvents, type SecurityEvent } from '../db/schema/securityEvents';
import { RateLimitService } from '../common/rate-limit.service';
import { MailService } from '../mail/mail.service';
import { AdminOrdersService } from '../orders/admin-orders.service';
import { FulfillmentService, type CompleteResult } from '../orders/fulfillment.service';
import { recordReplacementLineage } from '../orders/assignment-history';

const DAY_MS = 86_400_000;

/* ------------------------------------------------------------------------------------------------
 * SUİSTİMAL SINIRLARI (§13/§15) — Redis sabit-pencere (RateLimitService: dağıtık + restart-dayanıklı).
 *
 * Amaç: destek yazışması bir spam/DoS kanalına dönüşmesin ve tek müşteri sınırsız "değişim talebi"
 * açıp operatör kuyruğunu boğmasın. §15 gereği OTOMATİK ENGELLEME/ASKIYA ALMA YOK — aşım yalnız
 * 429 ile geri çevrilir + güvenlik olayı olarak İŞARETLENİR; yaptırımı insan verir.
 * ---------------------------------------------------------------------------------------------- */

/** Tek talep içinde mesaj seli: 10 mesaj / 10 dk. */
const MSG_PER_REQUEST_MAX = 10;
const MSG_PER_REQUEST_WINDOW_SEC = 600;
/** Site+müşteri genelinde mesaj seli (talep değiştirerek sınırı atlamayı kapatır): 30 / saat. */
const MSG_PER_CUSTOMER_MAX = 30;
const MSG_PER_CUSTOMER_WINDOW_SEC = 3600;
/**
 * Yazışma OKUMA seli (site-facing): 120 istek / dk / site. Müşteri "Sorun Bildir" ekranında
 * yazışmayı yeniler; normal kullanımda dakikada birkaç istek olur. Admin yolu KAPSAM DIŞI.
 */
const MSG_READ_PER_SITE_MAX = 120;
const MSG_READ_WINDOW_SEC = 60;
/** Talep AÇMA seli: 5 talep / 24 saat / (site + müşteri e-postası). */
const CREATE_PER_CUSTOMER_MAX = 5;
const CREATE_PER_CUSTOMER_WINDOW_SEC = 86_400;

/** Yazışmada tek seferde dönen en fazla mesaj (uçtan uca sayfalama gerekmiyor; kuyruk kısa kalır). */
const MESSAGE_PAGE_LIMIT = 500;

/** Müşteriye gösterilen nötr yazar adı — operatör kimliği mağaza tarafına SIZMAZ. */
const SUPPORT_DISPLAY_NAME = 'Destek Ekibi';

/** Suistimal işaretinin dedupe penceresi (aynı site+e-posta için saatte en çok bir olay). */
const ABUSE_DEDUPE_WINDOW = sql`interval '1 hour'`;

/**
 * Hız sınırı aşımı → 429 + `Retry-After`. Controller `retryAfterSec`'ten başlığı set eder
 * (orders/sales-quota.exception.ts deseni). Sabit pencerede kalan süre bilinmediğinden
 * `retryAfterSec` pencere UZUNLUĞUDUR — yani güvenli (üst sınır) bir tahmindir.
 */
export class ReplacementRateLimitException extends HttpException {
  constructor(
    message: string,
    readonly retryAfterSec: number,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export interface CreateReplacementInput {
  remoteOrderId: string;
  reason: string;
  assignmentId?: string;
}

/** Yazışma mesajı (admin + site yanıtlarının ORTAK şekli; sır ASLA içermez). */
export interface ReplacementMessageRow {
  id: string;
  requestId: string;
  authorType: 'admin' | 'customer' | 'system';
  authorName: string;
  body: string;
  internal: boolean;
  createdAt: Date;
}

/**
 * Admin listesi/detayı için talep + siparişin remote_order_id'si + yazışma/suistimal özeti.
 * Yazışma alanları tek sorguda (LATERAL + gruplu alt sorgu) gelir — N+1 YOK.
 */
export interface AdminReplacementRow {
  id: string;
  siteId: string;
  /**
   * Talebin geldiği mağazanın alan adı (site silinmişse null). Çok siteli kurulumda mağaza
   * sipariş no'ları ÇAKIŞIR (#1024 iki farklı sitede olabilir) → operatör kararı (onayla/reddet)
   * mağaza bağlamı olmadan veremez; kuyruk bunu göstermeli (denetim bulgusu).
   */
  siteDomain: string | null;
  orderId: string;
  remoteOrderId: string | null;
  lineId: string | null;
  assignmentId: string | null;
  /**
   * Talebin ilgili olduğu PANEL ürünü (satırdan, yoksa atamanın lisans kaleminden çözülür).
   * "Onayla" aynı üründen taze lisans atamaya çalışır → operatör hangi üründe stok gerektiğini
   * karar ANINDA görmeli (eskiden 409 "stok yok" ile sonradan öğreniyordu). Çözülemezse null.
   */
  productId: string | null;
  productName: string | null;
  productSku: string | null;
  /**
   * Ürünün kullanım modu (`single` | `multi`). MAK/çok kullanımlı üründe değişim akışı
   * REDDEDİLİR (kapasite aynı paylaşımlı anahtara döner) — destek ekranı "Onayla" düğmesini
   * bu bilgiyle kapatır. `null` = bilinmiyor ⇒ UI kapı UYGULAMAZ (yetkili kapı API`de).
   */
  usageMode: string | null;
  customerEmail: string;
  reason: string;
  status: ReplacementRequest['status'];
  withinWarranty: boolean;
  resolutionNote: string | null;
  createdAt: Date;
  /** Yazışmadaki toplam mesaj sayısı (iç notlar DAHİL — admin görünümü). */
  messageCount: number;
  /** Son mesajın zamanı (yazışma yoksa null). */
  lastMessageAt: Date | null;
  /** Son mesajı kim yazdı (iç not da sayılır — "en son ne oldu" bilgisi). */
  lastMessageAuthorType: 'admin' | 'customer' | 'system' | null;
  /**
   * Müşterinin son mesajından SONRA adminin MÜŞTERİYE GÖRÜNEN yanıtı yok → "yanıt bekliyor".
   * İç not (internal=true) yanıt SAYILMAZ: müşteri hâlâ cevapsızdır.
   */
  unansweredByAdmin: boolean;
  /** Bu e-postanın son 90 gündeki toplam talep sayısı (suistimal göstergesi; eylem YOK). */
  customerRequestCount90d: number;
}

/** rawRows dönüşü — Postgres kolon adları (snake_case) camelCase'e elle eşlenir. */
interface AdminReplacementSqlRow {
  id: string;
  site_id: string;
  site_domain: string | null;
  order_id: string;
  remote_order_id: string | null;
  line_id: string | null;
  assignment_id: string | null;
  product_id: string | null;
  product_name: string | null;
  product_sku: string | null;
  usage_mode: string | null;
  customer_email: string;
  reason: string;
  status: ReplacementRequest['status'];
  within_warranty: boolean;
  resolution_note: string | null;
  created_at: Date;
  message_count: number;
  last_message_at: Date | null;
  last_message_author_type: string | null;
  unanswered_by_admin: boolean;
  customer_request_count_90d: number;
}

/** author_type serbest metin kolonu → tipli birlik (bilinmeyen değer 'system'e düşer). */
function toAuthorType(raw: string | null): ReplacementMessageRow['authorType'] {
  return raw === 'admin' || raw === 'customer' ? raw : 'system';
}

/**
 * Değişim/garanti talepleri (§13). Site-facing oluşturma + admin çözüm akışı.
 * Onayda MEVCUT atama makinesini kullanır (revoke + completeLine) — atomik atama
 * mantığı yeniden yazılmaz.
 */
@Injectable()
export class ReplacementsService {
  private readonly logger = new Logger(ReplacementsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly adminOrders: AdminOrdersService,
    private readonly fulfillment: FulfillmentService,
    private readonly mail: MailService,
    /**
     * Hız sınırı (suistimal koruması). Nest DI'da HER ZAMAN enjekte edilir (RateLimitModule
     * @Global; çözülemezse uygulama BOOT'ta patlar → sessiz "sınırsız" mod imkânsız). `?`
     * yalnız servisi elle `new`leyen entegrasyon testleri derlenmeye devam etsin diye var.
     */
    private readonly rateLimit?: RateLimitService,
  ) {}

  /**
   * Site-facing talep oluşturma. Site imzadan çözülür (HmacGuard). Sipariş
   * (siteId, remoteOrderId) ile bulunur; yoksa 404. assignmentId verildiyse
   * garanti penceresi hesaplanır ve lineId atamadan türetilir.
   */
  async create(
    site: Site,
    dto: CreateReplacementInput,
  ): Promise<{
    id: string;
    status: ReplacementRequest['status'];
    withinWarranty: boolean;
    /**
     * EKLEMELİ bilgi alanı (mevcut sözleşme KIRILMADI): `withinWarranty=false`ın sebebi
     * "garanti süresi doldu" mu, yoksa "garanti sürüyor ama LİSANSIN ömrü bitti" mi?
     * İkisi operasyonel olarak farklıdır; DB'ye yazılmaz (şema değişikliği gerekmez).
     */
    licenseExpired: boolean;
  }> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.siteId, site.id), eq(orders.remoteOrderId, dto.remoteOrderId)))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    // SUİSTİMAL: talep açma sınırı. Kimlik SİPARİŞTEN çözülen e-posta (istemci gövdesinden DEĞİL)
    // → müşteri farklı sipariş/talep deneyerek sınırı atlayamaz. Sipariş bulunamadan sayaç
    // harcanmaz (404 yolu bütçe yemez). Garanti penceresi/kapsam kontrolleri AŞAĞIDA, değişmedi.
    await this.enforceLimit({
      key: `replacement:create:${site.id}:${this.emailKey(order.customerEmail)}`,
      limit: CREATE_PER_CUSTOMER_MAX,
      windowSec: CREATE_PER_CUSTOMER_WINDOW_SEC,
      message:
        'Çok fazla değişim talebi açtınız. Mevcut talebiniz üzerinden yazmaya devam edebilir ' +
        'veya 24 saat sonra yeni talep açabilirsiniz.',
      siteId: site.id,
      email: order.customerEmail,
      detail: `Değişim talebi açma sınırı aşıldı (${CREATE_PER_CUSTOMER_MAX}/24s) — olası suistimal`,
      scope: 'replacement_create',
    });

    let lineId: string | null = null;
    // Yalnız bu siparişe ait olduğu DOĞRULANAN atama id'si saklanır; yabancı/bulunamayan
    // referans (başka site/sipariş) DB'ye HİÇ yazılmaz → null kalır (lineId=null ile tutarlı).
    let assignmentId: string | null = null;
    let withinWarranty = false;
    /** Garanti penceresi sürüyor AMA lisansın geçerlilik süresi dolmuş (O7b) — yalnız bilgi. */
    let licenseExpired = false;

    if (dto.assignmentId) {
      // Atamayı sipariş kapsamında çöz → garanti (delivered_at + warranty_days) + satır.
      const [asg] = await this.db
        .select({
          orderId: assignments.orderId,
          lineId: assignments.lineId,
          deliveredAt: assignments.deliveredAt,
          // O7(b): lisansın KENDİ geçerlilik bitişi (süreli hesap, §11). Garanti hesabı bunu
          // hesaba katmıyordu — aşağıdaki gerekçeye bakın.
          validUntil: assignments.validUntil,
          warrantyDays: products.warrantyDays,
        })
        .from(assignments)
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .innerJoin(products, eq(orderLines.productId, products.id))
        .where(eq(assignments.id, dto.assignmentId))
        .limit(1);

      // Yalnız bu siparişe ait atamayı bağla (siteler/siparişler arası referans sızmaz).
      if (asg && asg.orderId === order.id) {
        assignmentId = dto.assignmentId;
        lineId = asg.lineId;
        if (asg.deliveredAt && asg.warrantyDays && asg.warrantyDays > 0) {
          const inWarrantyWindow =
            asg.deliveredAt.getTime() + asg.warrantyDays * DAY_MS >= Date.now();
          // Lisansın ÖMRÜ garanti penceresinden kısa olabilir (`validity_days` < `warranty_days`).
          // Örnek gerçek arıza: validity_days=30, on_expiry='keep', warranty_days=365 → müşteri
          // 2 ay sonra talep açar; panel YEŞİL "Garanti içi" basardı, oysa ortada bir KUSUR yok,
          // lisans süresi dolmuştur. Onaylanınca completeLine taze atamaya `now + 30 gün` yazar →
          // BEDAVA 30 gün, 12 ay boyunca tekrarlanabilir. `hide` tarafında akış TESADÜFEN doğru
          // sonuç veriyordu (sweep atamayı 'expired' yapar, değişim reddedilir) — yani AYNI iş
          // kuralı iki ürün ayarında iki farklı sonuç üretiyordu. Süresi geçmiş lisans artık
          // "garanti içi" SAYILMAZ; talep yine AÇILIR ve kuyruğa düşer (karar operatörde, §15).
          const stillValid = asg.validUntil === null || asg.validUntil.getTime() >= Date.now();
          withinWarranty = inWarrantyWindow && stillValid;
          // Kuyrukta ayırt edilebilsin: "garanti içi ama lisans süresi dolmuş" hâli, hiç garantisi
          // olmayan talepten farklıdır (operatör bunu okumadan "kusurlu" sanıp onaylayabilir).
          licenseExpired = inWarrantyWindow && !stillValid;
        }
      }
    }

    const [row] = await this.db
      .insert(replacementRequests)
      .values({
        siteId: site.id,
        orderId: order.id,
        lineId,
        assignmentId,
        customerEmail: order.customerEmail,
        reason: dto.reason,
        status: 'open',
        withinWarranty,
      })
      .returning();

    return {
      id: row!.id,
      status: row!.status,
      withinWarranty: row!.withinWarranty,
      licenseExpired,
    };
  }

  /**
   * Admin liste: talep + siparişin remote_order_id'si + MAĞAZA/ÜRÜN bağlamı + YAZIŞMA/SUİSTİMAL
   * özeti; status opsiyonel filtre.
   *
   * Tek sorgu (N+1 YOK):
   *  - sites/order_lines/assignments/license_items/products: PK eşitliği üzerinden LEFT JOIN —
   *    mağaza alan adı + ürün (ad/SKU) kararın verildiği ekrana taşınır (ek istek YOK).
   *  - LATERAL #1: talebin mesaj sayacı + son mesaj zamanı + "son müşteri" / "son GÖRÜNÜR admin yanıtı"
   *    zaman damgaları (FILTER'lı agregat) → `unansweredByAdmin` SQL'de hesaplanır.
   *  - LATERAL #2: son mesajın yazar tipi (created_at,id DESC LIMIT 1 — deterministik).
   *  - Gruplu alt sorgu: 90 günlük e-posta başına talep sayısı; satır-başına korele alt sorgu
   *    DEĞİL, tek geçişte gruplanıp hash-join edilir (200 satırda 200 tarama olmaz).
   */
  async list(status?: string): Promise<{ items: AdminReplacementRow[] }> {
    // F5: doğrulanmamış ?status= (`as never` cast'iyle) pg-enum karşılaştırmasına ulaşıp
    // "invalid input value for enum" → 500 üretiyordu. Üyeliği sorgudan ÖNCE doğrula: verilmiş
    // ama geçersizse boş liste. Ham SQL'de enum yerine `status::text` ile karşılaştırılır →
    // sürücünün parametreyi `text` göndermesi enum operatör hatası üretemez.
    const match = status ? replacementStatusEnum.enumValues.find((v) => v === status) : undefined;
    if (status && !match) return { items: [] };
    const statusWhere = match ? sql`AND rr.status::text = ${match}` : sql``;

    const rows = await rawRows<AdminReplacementSqlRow>(
      this.db,
      sql`
        SELECT
          rr.id,
          rr.site_id,
          s.domain AS site_domain,
          rr.order_id,
          o.remote_order_id,
          rr.line_id,
          rr.assignment_id,
          p.id AS product_id,
          p.name AS product_name,
          p.sku AS product_sku,
          p.usage_mode::text AS usage_mode,
          rr.customer_email,
          rr.reason,
          rr.status,
          rr.within_warranty,
          rr.resolution_note,
          rr.created_at,
          coalesce(m.message_count, 0)::int AS message_count,
          m.last_message_at,
          la.author_type AS last_message_author_type,
          (
            m.last_customer_at IS NOT NULL
            AND (m.last_admin_public_at IS NULL OR m.last_customer_at > m.last_admin_public_at)
          ) AS unanswered_by_admin,
          coalesce(c.cnt90, 0)::int AS customer_request_count_90d
        FROM replacement_requests rr
        LEFT JOIN orders o ON o.id = rr.order_id
        -- Mağaza bağlamı (çok siteli kurulumda sipariş no'ları çakışır).
        LEFT JOIN sites s ON s.id = rr.site_id
        -- Ürün çözümü: ÖNCE sipariş satırı (kesin kaynak), yoksa atamanın lisans kalemi.
        -- Hepsi PK/indeksli eşitlik JOIN'i (satır sayısı ≤200) → N+1 yok, ek tarama yok.
        LEFT JOIN order_lines ol ON ol.id = rr.line_id
        LEFT JOIN assignments a ON a.id = rr.assignment_id
        LEFT JOIN license_items li ON li.id = a.license_item_id
        LEFT JOIN products p ON p.id = coalesce(ol.product_id, li.product_id)
        LEFT JOIN LATERAL (
          SELECT
            count(*)::int AS message_count,
            max(rm.created_at) AS last_message_at,
            max(rm.created_at) FILTER (WHERE rm.author_type = 'customer') AS last_customer_at,
            max(rm.created_at) FILTER (
              WHERE rm.author_type = 'admin' AND rm.internal = false
            ) AS last_admin_public_at
          FROM replacement_messages rm
          WHERE rm.request_id = rr.id
        ) m ON true
        LEFT JOIN LATERAL (
          SELECT rm.author_type
          FROM replacement_messages rm
          WHERE rm.request_id = rr.id
          ORDER BY rm.created_at DESC, rm.id DESC
          LIMIT 1
        ) la ON true
        LEFT JOIN (
          SELECT customer_email, count(*)::int AS cnt90
          FROM replacement_requests
          WHERE created_at >= now() - interval '90 days'
          GROUP BY customer_email
        ) c ON c.customer_email = rr.customer_email
        WHERE true ${statusWhere}
        -- Tie-break (id) ŞART: liste 200 ile TAVANLI ve kırpılma operatöre uyarı olarak
        -- gösteriliyor; eşit created_at'te pencereye hangi taleplerin gireceği tie-break
        -- olmadan keyfi olurdu (aynı ekran her yenilemede farklı talep gösterebilir).
        ORDER BY rr.created_at DESC, rr.id DESC
        LIMIT 200;
      `,
    );

    const items: AdminReplacementRow[] = rows.map((r) => ({
      id: r.id,
      siteId: r.site_id,
      siteDomain: r.site_domain ?? null,
      orderId: r.order_id,
      remoteOrderId: r.remote_order_id,
      lineId: r.line_id,
      assignmentId: r.assignment_id,
      productId: r.product_id ?? null,
      productName: r.product_name ?? null,
      productSku: r.product_sku ?? null,
      usageMode: r.usage_mode ?? null,
      customerEmail: r.customer_email,
      reason: r.reason,
      status: r.status,
      withinWarranty: r.within_warranty,
      resolutionNote: r.resolution_note,
      createdAt: r.created_at,
      messageCount: Number(r.message_count ?? 0),
      lastMessageAt: r.last_message_at,
      lastMessageAuthorType: r.last_message_author_type
        ? toAuthorType(r.last_message_author_type)
        : null,
      unansweredByAdmin: r.unanswered_by_admin === true,
      customerRequestCount90d: Number(r.customer_request_count_90d ?? 0),
    }));

    return { items };
  }

  /**
   * Değişimi onayla: eski atamayı geri al + yenisini ata (§13). MEVCUT makine:
   * revokeAssignment (eskiyi karantina/kapasite iadesi) + completeLine(lineId, 1).
   * Stok yoksa (added=0) 409 döner, talep 'approved' YAPILMAZ ve REVOKE DA GERİ ALINIR
   * (tek transaction) → müşterinin mevcut anahtarı canlı kalır.
   */
  async approve(id: string, actor: string): Promise<ReplacementRequest> {
    // Yazışmaya "onaylandı" sistem satırı + müşteri bildirimi + teslimat maili/webhook, transaction
    // COMMIT'inden SONRA çalışır (aşağıda): tx İÇİNDE best-effort try/catch güvenli değildir (hatalı
    // ifade tx'i 25P02 ile zehirler) ve rollback edilen bir onay için bildirim gitmemelidir.
    // Kritik yol (advisory-lock + revoke + completeLine) TEK transaction'da atomik koşar.
    const { updated, completion } = await this.approveTx(id, actor);

    // 1) Teslimat/güncelleme maili + geri-kanal webhook — completeLine dış tx ile çağrıldığı için
    // yan etkilerini KENDİ tetiklemedi; sözleşme gereği commit sonrası burada tetiklenir.
    await this.fulfillment.emitCompletionEffects(completion).catch((e: unknown) => {
      this.logger.warn(`Değişim sonrası teslimat yan etkileri tetiklenemedi (${id}): ${errText(e)}`);
    });
    // 2) Müşteriye "değişim onaylandı" bildirimi (reject/requestInfo ile simetri). Best-effort +
    // SIRSIZ (yalnız durum) — SMTP hatası onayı BOZMAZ. Eskiden sonuç TAMAMEN yutuluyordu
    // (`.catch(() => {})`): kuyruğa alınamayan bildirim hiçbir yerde iz bırakmıyordu.
    await this.enqueueNotice(
      `Değişim onayı bildirimi (${id})`,
      updated.orderId,
      updated.customerEmail,
      'approved',
      '',
    );
    await this.recordSystemMessage(id, 'Değişim talebi onaylandı, yeni lisans atandı.', actor);
    return updated;
  }

  /**
   * approve()'un TOCTOU-korumalı ve ATOMİK çekirdeği.
   *
   * ATOMİKLİK (denetim bulgusu): revoke + completeLine ARTIK dış tx'te (SAVEPOINT) koşar. Eskiden
   * ikisi de kendi transaction'ında bağımsız COMMIT ediyordu → added<=0'da atılan 409 eski anahtarı
   * KARANTİNADA bırakıyor, müşteri lisansını kaybediyordu (satır canceled/held ise KALICI).
   * Şimdi throw ⇒ tüm tx rollback ⇒ eski atama aynen aktif kalır.
   *
   * Kilit edinim sırası diğer yollarla TUTARLIDIR (ABBA deadlock açılmaz):
   *   advisory('replacement:<id>') → replacement_requests → assignments → order_lines → orders.
   */
  private async approveTx(
    id: string,
    actor: string,
  ): Promise<{ updated: ReplacementRequest; completion: CompleteResult }> {
    // TOCTOU koruması: çift-tık/eşzamanlı onayda ikinci çağrı talebi kilitsiz okuyup revoke'u
    // no-op görüyor → completeLine added=0 → SAHTE "Değişim için stok yok" 409. Talep id'sine bağlı
    // pg_advisory_xact_lock + FOR UPDATE re-read ile serileştir (orders.service held-release deseni):
    // ikinci çağrı kilidi bekler, terminal durumu görüp 'Talep zaten çözülmüş' ile erken çıkar.
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'replacement:' + id}))`);
      // Kilit altında YENİDEN oku (FOR UPDATE) → statü kararı serileşir.
      const [req] = await tx
        .select()
        .from(replacementRequests)
        .where(eq(replacementRequests.id, id))
        .limit(1)
        .for('update');
      if (!req) throw new NotFoundException('Değişim talebi bulunamadı');
      // Idempotent koruma: yalnız açık/bilgi-istenen talep işlenir. Terminal (approved/rejected)
      // durumda tekrar çağrı taze stok tüketmez — çifte değişim imkânsız.
      if (req.status !== 'open' && req.status !== 'info_requested') {
        throw new ConflictException('Talep zaten çözülmüş');
      }
      if (!req.assignmentId || !req.lineId) {
        throw new BadRequestException('Talep bir atama/satıra bağlı değil');
      }

      // ATAMANIN DURUMU (denetim bulgusu): aynı atamaya İKİNCİ bir talep açılmış olabilir (ilk
      // değişim yapıldı → atama artık 'revoked'/terminal). Eskiden bu hâl doğrudan revoke no-op'una
      // ve added=0 → YANILTICI "Değişim için stok yok" 409'una düşüyordu. FOR UPDATE ile kilitle
      // (kilit sırası: replacement_requests → assignments → order_lines → orders) ve AÇIK mesajla reddet.
      const [asg] = await tx
        .select({ status: assignments.status })
        .from(assignments)
        .where(eq(assignments.id, req.assignmentId))
        .limit(1)
        .for('update');
      if (!asg) throw new NotFoundException('Talebe bağlı atama bulunamadı');
      if (asg.status !== 'active') {
        throw new ConflictException(
          'Bu lisans zaten değiştirilmiş/iptal edilmiş — yeni bir değişim uygulanamaz.',
        );
      }

      // Çok-kullanımlı (MAK) ürünlerde otomatik değişim ANLAMLI DEĞİL: revoke kapasiteyi aynı
      // paylaşımlı anahtara iade eder → completeLine onu tekrar seçer (no-op, aynı kusurlu key).
      // Sessizce "onaylandı" demek yerine açıkça reddet; MAK sorunları elle işlenir (audit bulgusu).
      const [prod] = await tx
        .select({ usageMode: products.usageMode })
        .from(orderLines)
        .innerJoin(products, eq(products.id, orderLines.productId))
        .where(eq(orderLines.id, req.lineId))
        .limit(1);
      if (prod?.usageMode === 'multi') {
        throw new BadRequestException(
          'Çok-kullanımlı (MAK) üründe otomatik değişim desteklenmez — elle işleyin.',
        );
      }

      // 0) Stok ön-kontrolü: satırın ürününde uygun stok YOKSA eskiyi REVOKE ETMEDEN 409 dön.
      // (revoke→completeLine sırası zorunlu; ama stok baştan yoksa boşuna revoke/rollback yapmayalım.)
      // TEK KAYNAK: fulfillment.allocatableCountForLine — aynı sayım aşağıdaki "added=0 neden?"
      // ayrımında da kullanılır (iki kopya sorgu sapmasın).
      if ((await this.fulfillment.allocatableCountForLine(req.lineId, tx)) <= 0) {
        throw new ConflictException('Değişim için stok yok');
      }

      // 1) Eskiyi geri al (single → karantina, multi → kapasite iadesi; audit'e düşer).
      // markLineCanceled=false: hemen ardından completeLine ile MEŞRU yeniden-atama yapılacak;
      // satır 'canceled' işaretlenirse completeLine no-op eder → yanlış "stok yok". (Iade DEĞİL, değişim.)
      // tx GEÇİLİR: aynı bağlantıda SAVEPOINT olarak koşar → aşağıdaki throw revoke'u da geri alır.
      // Revoke sonucundan eski key id'sini al (soyağacı için).
      const revoked = await this.adminOrders.revokeAssignment(
        req.assignmentId,
        'replacement',
        actor,
        false,
        tx,
      );

      // 2) Yenisini ata — satırın açılan yerine 1 birim (atomik atama makinesi), AYNI tx'te.
      const res = await this.fulfillment.completeLine(req.lineId, 1, true, tx);
      if (res.added <= 0) {
        // added=0 "stok yok" DEMEK DEĞİLDİR: allocate FOR UPDATE SKIP LOCKED kullanır → eşzamanlı
        // bir atama satırları kilitlediyse stok VARKEN de 0 döner (fulfillment.service belgeliyor).
        // Operatöre gerçeği söyle; her iki hâlde de tx ROLLBACK olur → revoke geri alınır, müşterinin
        // anahtarı canlı kalır ve talep 'approved' YAPILMAZ.
        const stillAvailable = await this.fulfillment.allocatableCountForLine(req.lineId, tx);
        throw new ConflictException(
          stillAvailable > 0
            ? 'Lisans şu anda atanamadı (eşzamanlı işlem sürüyor) — lütfen tekrar deneyin.'
            : 'Değişim için stok yok',
        );
      }

      // Soyağacı (§3 "eski anahtarlar"): eski→yeni assignment_history + yeni atama id'si (tek yerde).
      // Yeni atama id'si completeLine sonucundan KESİN gelir — "satırın en yeni aktif ataması"
      // tahmini, aynı satırda eşzamanlı ikinci bir değişimde YANLIŞ atamaya bağlanabiliyordu.
      const newAssignmentId = await recordReplacementLineage(tx, {
        lineId: req.lineId,
        oldLicenseItemId: ('licenseItemId' in revoked ? revoked.licenseItemId : null) ?? null,
        reason: 'replacement',
        actor,
        newAssignmentId: res.createdAssignmentIds?.[0] ?? null,
      });

      const [updated] = await tx
        .update(replacementRequests)
        .set({
          status: 'approved',
          newAssignmentId: newAssignmentId ?? null,
          resolvedBy: actor,
          resolvedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(replacementRequests.id, id))
        .returning();

      return { updated: updated!, completion: res };
    });
  }

  /** Reddet — çözüm notuyla kapat + müşteriye durum bildirimi (yalnız durum+not, sırsız). */
  async reject(id: string, note: string, actor: string): Promise<ReplacementRequest> {
    // approve() ile AYNI serileştirme (denetim bulgusu): eskiden kilitsiz oku-değiştir-yaz idi →
    // eşzamanlı onay + ret yarışında ret, 'approved' durumunu EZEBİLİYORDU (lisans değişti ama
    // talep 'rejected' göründü). Aynı advisory anahtar ('replacement:<id>') approve/reject/
    // requestInfo'yu tek sıraya dizer; ayrıca UPDATE'e statü koşulu gömülüdür (0 satır → 409).
    const updated = await this.transitionStatus(id, {
      status: 'rejected',
      resolutionNote: note,
      resolvedBy: actor,
      resolvedAt: new Date(),
      updatedAt: new Date(),
    });

    // Bildirim best-effort (SMTP hatası talebi bozmaz) — kuyruğa alınamazsa SESSİZ kalmaz (warn).
    await this.enqueueNotice(
      `Talep reddi bildirimi (${id})`,
      updated.orderId,
      updated.customerEmail,
      'rejected',
      note,
    );
    // Yazışmaya sistem satırı: talebin neden kapandığı thread'de de görünsün (best-effort).
    await this.recordSystemMessage(id, `Talep reddedildi. Gerekçe: ${note}`, actor);
    return updated;
  }

  /**
   * Ek bilgi iste — müşteriye dönülür, talep açık kalır + durum bildirimi (sırsız).
   * `actor` reject/approve ile tutarlı olsun diye @AdminActor'dan alınır; talep ÇÖZÜLMEDİĞİ için
   * `resolvedBy`'a YAZILMAZ ve şemada "bilgi-istendi-eden" için ayrı kolon yok (migration eklenmedi) →
   * izlenebilirlik/imza tutarlılığı için ileri taşınır (opsiyonel, mevcut çağıranları kırmaz).
   */
  async requestInfo(id: string, note: string, actor?: string): Promise<ReplacementRequest> {
    // reject() ile aynı serileştirme — eşzamanlı onayın 'approved' durumunu ezmesi kapatıldı.
    const updated = await this.transitionStatus(id, {
      status: 'info_requested',
      resolutionNote: note,
      updatedAt: new Date(),
    });

    await this.enqueueNotice(
      `Ek bilgi talebi bildirimi (${id})`,
      updated.orderId,
      updated.customerEmail,
      'info_requested',
      note,
    );
    // "Bilgi istendi" DURUM aksiyonu; sorunun metni yazışmada da görünür (admin mesajı olarak
    // AYRICA yazılmaz — çift kayıt olmasın diye tek sistem satırı).
    await this.recordSystemMessage(id, `Müşteriden ek bilgi istendi: ${note}`, actor);
    return updated;
  }

  /**
   * ATAMA GEREKTİRMEYEN durum geçişleri (reject / requestInfo) için ortak, YARIŞA KAPALI yol.
   *
   * approve() deseni: advisory-lock (aynı anahtar → onay/ret/bilgi-iste tek sıraya girer) +
   * FOR UPDATE re-read + UPDATE'e gömülü statü koşulu (0 satır ⇒ 409). Böylece "oku → karar ver →
   * yaz" arasında araya giren bir onay EZİLMEZ. Atama/stok makinesine DOKUNMAZ (yalnız statü).
   */
  private async transitionStatus(
    id: string,
    values: Partial<typeof replacementRequests.$inferInsert> & {
      status: ReplacementRequest['status'];
    },
  ): Promise<ReplacementRequest> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'replacement:' + id}))`);
      const [req] = await tx
        .select()
        .from(replacementRequests)
        .where(eq(replacementRequests.id, id))
        .limit(1)
        .for('update');
      if (!req) throw new NotFoundException('Değişim talebi bulunamadı');
      // Idempotent koruma: terminal (approved/rejected) durumdaki talep yeniden kapatılamaz.
      if (req.status !== 'open' && req.status !== 'info_requested') {
        throw new ConflictException('Talep zaten çözülmüş');
      }
      const [updated] = await tx
        .update(replacementRequests)
        .set(values)
        .where(
          and(
            eq(replacementRequests.id, id),
            inArray(replacementRequests.status, ['open', 'info_requested']),
          ),
        )
        .returning();
      // Savunma derinliği: kilide rağmen (ör. gelecekte kilitsiz bir yol eklenirse) durum
      // değişmişse sessizce EZME — 409 at.
      if (!updated) throw new ConflictException('Talep zaten çözülmüş');
      return updated;
    });
  }

  /* ============================================================================================
   * YAZIŞMA (thread) — §13. Admin ↔ müşteri mesajları. Yazar kimliği KİMLİKTEN gelir
   * (admin oturumu / site HMAC), gövdeden DEĞİL → müşteri "admin" gibi yazamaz.
   * ========================================================================================== */

  /**
   * Talebin mesajlarını kronolojik döndürür.
   *
   * @param opts.includeInternal true YALNIZ admin yolunda; false ise iç notlar SERVİS
   *   KATMANINDA süzülür (controller'a bırakılmaz → yeni bir çağıran yanlışlıkla sızdıramaz).
   *   Ayrıca müşteri görünümünde admin/sistem YAZAR ADI maskelenir — operatörün kimliği
   *   (kullanıcı adı/e-posta, audit aktörü) mağaza üzerinden müşteriye SIZMAZ.
   * @param opts.siteId verilirse talep O SİTEYE ait olmalı; değilse 404 (çapraz-site erişim
   *   varlık bilgisi bile sızdırmaz — 403 değil 404).
   */
  async listMessages(
    requestId: string,
    opts: { includeInternal: boolean; siteId?: string },
  ): Promise<{ messages: ReplacementMessageRow[] }> {
    await this.getScopedOrThrow(requestId, opts.siteId);

    // Site-facing (mağaza/müşteri) OKUMA yolu da hız sınırlı olmalı: yazma ucu sınırlıydı ama
    // okuma sınırsızdı → tek müşteri yazışmayı saniyede onlarca kez çekip DB'yi yorabilirdi
    // (denetim bulgusu). Admin yolunda (`siteId` yok) sınır UYGULANMAZ — panel operatörü kısıtlanmaz.
    // `enforceLimit` KULLANILMAZ: o yol aşımı "suistimal olayı" olarak da kaydeder ve müşteri
    // e-postası ister — okuma seli bir güvenlik olayı değil, yalnız gürültüdür. Sade 429 yeter.
    if (opts.siteId && this.rateLimit) {
      const ok = await this.rateLimit.hit(
        `replacement:msg:read:${opts.siteId}`,
        MSG_READ_PER_SITE_MAX,
        MSG_READ_WINDOW_SEC,
      );
      if (!ok) {
        throw new ReplacementRateLimitException(
          'Çok sık yazışma sorgusu — lütfen biraz sonra tekrar deneyin.',
          MSG_READ_WINDOW_SEC,
        );
      }
    }

    const where = opts.includeInternal
      ? eq(replacementMessages.requestId, requestId)
      : and(
          eq(replacementMessages.requestId, requestId),
          eq(replacementMessages.internal, false),
        );

    const rows = await this.db
      .select({
        id: replacementMessages.id,
        requestId: replacementMessages.requestId,
        authorType: replacementMessages.authorType,
        authorName: replacementMessages.authorName,
        body: replacementMessages.body,
        internal: replacementMessages.internal,
        createdAt: replacementMessages.createdAt,
      })
      .from(replacementMessages)
      .where(where)
      .orderBy(asc(replacementMessages.createdAt), asc(replacementMessages.id))
      .limit(MESSAGE_PAGE_LIMIT);

    return {
      messages: rows.map((r) => {
        const authorType = toAuthorType(r.authorType);
        // Müşteri görünümü (includeInternal=false): admin/sistem satırlarında yazar adı nötr
        // "Destek Ekibi" — actor (admin kullanıcı adı/e-postası) mağaza tarafına dönmez.
        const authorName =
          !opts.includeInternal && authorType !== 'customer' ? SUPPORT_DISPLAY_NAME : r.authorName;
        return { ...r, authorType, authorName };
      }),
    };
  }

  /**
   * Admin mesajı ekler (panelden "cevap ver").
   *
   * - Talep yoksa 404. KAPALI (approved/rejected) talepte de yazılabilir — izlenebilirlik;
   *   sonradan gelen açıklama/özür kaybolmasın.
   * - STATÜ DEĞİŞTİRMEZ: 'open' talebe müşteriye yazmak onu 'info_requested' YAPMAZ. Durum
   *   geçişi ayrı, bilinçli bir aksiyondur (POST :id/request-info) — mesaj yazmak yanlışlıkla
   *   talebin durumunu (ve müşteriye giden durum dilini) değiştirmemeli.
   * - internal=false ise müşteriye bildirim maili KUYRUĞA ALINIR (best-effort; SMTP hatası
   *   mesajı YUTMAZ). Yanıttaki bayrak "gönderildi" DEĞİL "kuyruğa alındı" anlamındadır —
   *   gerçek gönderim sonucu email_log satırındadır (sent/failed) ve /ops dead-letter'da görünür.
   */
  async addAdminMessage(
    requestId: string,
    input: { body: string; internal?: boolean },
    actor: string,
  ): Promise<{
    message: ReplacementMessageRow;
    /**
     * Bildirim KUYRUĞA ALINDI mı? (iç not ise false — mail hiç üretilmez.)
     * DİKKAT: "müşteriye ulaştı" GARANTİSİ DEĞİLDİR; gerçek gönderim durumu email_log'dadır.
     */
    notificationQueued: boolean;
    /** Kuyruğa alınamadıysa insan-okur sebep (sır içermez); aksi halde tanımsız. */
    notificationError?: string;
    /** @deprecated Eski alan adı — `notificationQueued` ile AYNI değeri taşır (kontrat kırılmasın). */
    notified: boolean;
  }> {
    const req = await this.getScopedOrThrow(requestId);
    const body = input.body.trim();
    if (!body) throw new BadRequestException('Mesaj boş olamaz');
    const internal = input.internal === true;

    const message = await this.insertMessage(requestId, {
      authorType: 'admin',
      authorName: actor,
      body,
      internal,
    });

    let queued = false;
    let notificationError: string | undefined;
    if (!internal) {
      // Mevcut değişim-bildirimi mekanizması yeniden kullanılır (ayrı şablon YOK, §doc):
      // status='message' → MailService.replacementHeadline default dalına düşer
      // ("Talebinizin durumu güncellendi.") + mesaj gövdesi "Not:" olarak eklenir. SIR İÇERMEZ.
      //
      // BAYRAK KAYNAĞI (denetim bulgusu): enqueueReplacementNotice artık ASLA fırlatmaz, sonucu
      // `{ queued }` ile döndürür → eski `.then(() => true)` deseni kuyruğa ALINAMAYAN bildirimde
      // de DAİMA true veriyordu (yanlış "bildirildi"). Bayrak yalnız dönen `queued` alanından
      // türetilir (enqueueNotice tek nokta: warn + sebep).
      const res = await this.enqueueNotice(
        `Destek yanıtı bildirimi (request=${requestId})`,
        req.orderId,
        req.customerEmail,
        'message',
        body,
      );
      queued = res.queued;
      notificationError = res.error;
    }

    // `notified` geriye dönük alias'tır; anlamı "kuyruğa alındı"dır (bkz. dönüş tipi dokümanı).
    return { message, notificationQueued: queued, notificationError, notified: queued };
  }

  /**
   * Müşteri mesajı ekler (site-facing, HMAC). Yazar tipi DAİMA 'customer' — site gövdeyle
   * 'admin' iddia edemez. Talep çağıran siteye ait değilse 404.
   *
   * STATÜ DEĞİŞTİRMEZ (approve/reject/requestInfo dışında durum geçişi yoktur): müşteri yanıtı
   * 'info_requested' talebi kendiliğinden 'open'a çekmez — bunun yerine admin listesinde
   * `unansweredByAdmin` bayrağı yanar (yeni durum-geçiş yolu = yeni kilit/guard yükü, §DERS).
   */
  async addCustomerMessage(
    site: Site,
    requestId: string,
    rawBody: string,
  ): Promise<{ message: ReplacementMessageRow }> {
    const req = await this.getScopedOrThrow(requestId, site.id);
    const body = rawBody.trim();
    if (!body) throw new BadRequestException('Mesaj boş olamaz');

    // SUİSTİMAL: iki katmanlı sınır. (a) tek talepte sel, (b) müşteri talep değiştirerek (a)'yı
    // atlamasın diye site+e-posta genelinde saatlik tavan. Kimlik talebin KAYITLI e-postası.
    await this.enforceLimit({
      key: `replacement:msg:req:${requestId}`,
      limit: MSG_PER_REQUEST_MAX,
      windowSec: MSG_PER_REQUEST_WINDOW_SEC,
      message: 'Bu talebe çok sık mesaj gönderdiniz. Lütfen kısa süre sonra tekrar deneyin.',
      siteId: site.id,
      email: req.customerEmail,
      detail: `Destek mesajı sınırı aşıldı (talep başına ${MSG_PER_REQUEST_MAX}/10dk) — olası suistimal`,
      scope: 'replacement_message_request',
    });
    await this.enforceLimit({
      key: `replacement:msg:cust:${site.id}:${this.emailKey(req.customerEmail)}`,
      limit: MSG_PER_CUSTOMER_MAX,
      windowSec: MSG_PER_CUSTOMER_WINDOW_SEC,
      message: 'Saatlik mesaj sınırına ulaştınız. Lütfen daha sonra tekrar deneyin.',
      siteId: site.id,
      email: req.customerEmail,
      detail: `Destek mesajı sınırı aşıldı (müşteri başına ${MSG_PER_CUSTOMER_MAX}/saat) — olası suistimal`,
      scope: 'replacement_message_customer',
    });

    const message = await this.insertMessage(requestId, {
      authorType: 'customer',
      // Görünen ad sabit: site gövdeden ad/kimlik enjekte edemez (spoof yüzeyi kapalı).
      authorName: 'Müşteri',
      body,
      internal: false,
    });
    return { message };
  }

  /**
   * Müşteriye giden DURUM bildirimini kuyruğa alır — TEK NOKTA (onay/ret/bilgi-iste/cevap).
   *
   * `MailService.enqueueReplacementNotice` sözleşme gereği ASLA fırlatmaz; sonucu `{ queued }`
   * ile döndürür. Bayrağı promise'in ÇÖZÜLMESİNDEN türetmek (eski `.then(() => true)` deseni)
   * kuyruğa ALINAMAYAN bildirimi "bildirildi" gibi gösteriyordu — bildirim sessizce kayboluyordu
   * (denetim bulgusu). Burada sonuç OKUNUR; başarısızlık logger.warn ile görünür olur ve çağıran
   * admin aksiyonu (onay/ret) BOZULMAZ (best-effort, §13).
   *
   * ANLAM SINIRI: dönen `queued=true` yalnız "kuyruğa alındı" demektir — "müşteriye ulaştı"
   * DEĞİL. Gerçek gönderim sonucu email_log satırındadır (sent/failed) ve başarısızsa /ops
   * "Başarısız İşler" ekranında görünür.
   */
  private async enqueueNotice(
    context: string,
    orderId: string,
    toEmail: string,
    status: string,
    note?: string | null,
  ): Promise<{ queued: boolean; error?: string }> {
    const res = await this.mail
      .enqueueReplacementNotice(orderId, toEmail, status, note)
      // Sözleşme dışı (beklenmeyen) bir hata da admin aksiyonunu bozmamalı — ikinci savunma hattı.
      .catch((e: unknown) => ({ queued: false, emailLogId: null, error: errText(e) }));
    if (res.queued !== true) {
      const reason = res.error ?? 'bilinmeyen sebep';
      this.logger.warn(
        `${context}: müşteri bildirimi KUYRUĞA ALINAMADI (order=${orderId}): ${reason}`,
      );
      return { queued: false, error: reason };
    }
    return { queued: true };
  }

  /** Sistem satırı (durum değişimi izi). Best-effort: yazışma kaydı asıl aksiyonu ASLA bozmaz. */
  private async recordSystemMessage(
    requestId: string,
    body: string,
    actor?: string,
  ): Promise<void> {
    try {
      await this.insertMessage(requestId, {
        authorType: 'system',
        authorName: actor?.trim() || 'Sistem',
        body,
        // Sistem satırı müşteriye de görünür (şeffaf durum izi) — sır içermez.
        internal: false,
      });
    } catch (e) {
      this.logger.warn(`Sistem mesajı yazılamadı (request=${requestId}): ${errText(e)}`);
    }
  }

  private async insertMessage(
    requestId: string,
    values: {
      authorType: ReplacementMessageRow['authorType'];
      authorName: string;
      body: string;
      internal: boolean;
    },
  ): Promise<ReplacementMessageRow> {
    const [row] = await this.db
      .insert(replacementMessages)
      .values({
        requestId,
        authorType: values.authorType,
        authorName: values.authorName.slice(0, 200),
        body: values.body,
        internal: values.internal,
      })
      .returning();
    return { ...row!, authorType: toAuthorType(row!.authorType) };
  }

  /* ============================================================================================
   * SUİSTİMAL KORUMASI — hız sınırı + güvenlik işareti (§15: yalnız işaretle, ENGELLEME YOK).
   * ========================================================================================== */

  /**
   * Sabit-pencere sınırını uygular; aşımda güvenlik olayı yazar (best-effort) ve 429 fırlatır.
   * Sınır servisi enjekte edilmemişse (yalnız elle-new'lenen testler) sınır UYGULANMAZ.
   */
  private async enforceLimit(opts: {
    key: string;
    limit: number;
    windowSec: number;
    message: string;
    siteId: string;
    email: string;
    detail: string;
    scope: string;
  }): Promise<void> {
    if (!this.rateLimit) return;
    if (await this.rateLimit.hit(opts.key, opts.limit, opts.windowSec)) return;

    await this.recordAbuseEvent(opts.siteId, opts.email, opts.detail, {
      scope: opts.scope,
      limit: opts.limit,
      windowSec: opts.windowSec,
    }).catch((e: unknown) => {
      this.logger.warn(`Suistimal olayı yazılamadı: ${errText(e)}`);
    });

    throw new ReplacementRateLimitException(opts.message, opts.windowSec);
  }

  /**
   * Hız sınırı aşımını `security_events`'e işaretler (dedupe: aynı site+e-posta için 1 saat).
   *
   * NOT: SecurityService.recordEvent PRIVATE olduğundan (ve o dosya bu dalganın kapsamı dışında)
   * kayıt buradan, AYNI desende yazılır. Tür olarak MEVCUT jenerik 'anomaly' kullanılır —
   * yeni tür eklenmez (admin /security ekranındaki etiket sözlüğü bozulmasın). Dedupe subject
   * (e-posta) ile daraltıldığından SecurityService'in kendi site-bazlı 'anomaly' dedupe'unu
   * en fazla 1 saat geciktirir; olay kaybolmaz. §15: OTOMATİK ENGELLEME/ASKIYA ALMA YOK.
   */
  private async recordAbuseEvent(
    siteId: string,
    email: string,
    detail: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const dup = await this.db
      .select({ id: securityEvents.id })
      .from(securityEvents)
      .where(
        and(
          eq(securityEvents.type, 'anomaly'),
          eq(securityEvents.siteId, siteId),
          eq(securityEvents.subject, email),
          sql`${securityEvents.createdAt} >= now() - ${ABUSE_DEDUPE_WINDOW}`,
        ),
      )
      .limit(1);
    if (dup.length > 0) return;

    await this.db.insert(securityEvents).values({
      type: 'anomaly',
      severity: 'warning',
      siteId,
      subject: email,
      detail,
      meta: meta as SecurityEvent['meta'],
    });
  }

  /**
   * Hız-sınırı anahtarında düz e-posta TUTULMAZ: KVKK/gizlilik gereği kısa sha256 özeti
   * kullanılır (Redis dökümünde müşteri e-postaları listelenemez). Küçük harfe indirger →
   * "Ali@x.com" ile "ali@x.com" aynı kovaya düşer (sınır büyük/küçük harfle atlatılamaz).
   */
  private emailKey(email: string): string {
    return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24);
  }

  /**
   * Talebi getirir; `siteId` verilmişse talebin O SİTEYE ait olduğunu ZORUNLU kılar.
   * Çapraz-site erişimde 404 (403 değil) → başka sitenin talep id'sinin VARLIĞI bile sızmaz.
   */
  private async getScopedOrThrow(id: string, siteId?: string): Promise<ReplacementRequest> {
    const [row] = await this.db
      .select()
      .from(replacementRequests)
      .where(
        siteId
          ? and(eq(replacementRequests.id, id), eq(replacementRequests.siteId, siteId))
          : eq(replacementRequests.id, id),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Değişim talebi bulunamadı');
    return row;
  }
}

/** Hata metnini güvenli çıkarır (log satırı için). */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
