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
import { and, asc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { assignments, licenseItems, orderLines, orders, products, type Site } from '../db/schema';
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
import { FulfillmentService } from '../orders/fulfillment.service';
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
  orderId: string;
  remoteOrderId: string | null;
  lineId: string | null;
  assignmentId: string | null;
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
  order_id: string;
  remote_order_id: string | null;
  line_id: string | null;
  assignment_id: string | null;
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
  ): Promise<{ id: string; status: ReplacementRequest['status']; withinWarranty: boolean }> {
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

    if (dto.assignmentId) {
      // Atamayı sipariş kapsamında çöz → garanti (delivered_at + warranty_days) + satır.
      const [asg] = await this.db
        .select({
          orderId: assignments.orderId,
          lineId: assignments.lineId,
          deliveredAt: assignments.deliveredAt,
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
          withinWarranty = asg.deliveredAt.getTime() + asg.warrantyDays * DAY_MS >= Date.now();
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

    return { id: row!.id, status: row!.status, withinWarranty: row!.withinWarranty };
  }

  /**
   * Admin liste: talep + siparişin remote_order_id'si + YAZIŞMA/SUİSTİMAL özeti; status opsiyonel filtre.
   *
   * Tek sorgu (N+1 YOK):
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
          rr.order_id,
          o.remote_order_id,
          rr.line_id,
          rr.assignment_id,
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
        ORDER BY rr.created_at DESC
        LIMIT 200;
      `,
    );

    const items: AdminReplacementRow[] = rows.map((r) => ({
      id: r.id,
      siteId: r.site_id,
      orderId: r.order_id,
      remoteOrderId: r.remote_order_id,
      lineId: r.line_id,
      assignmentId: r.assignment_id,
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
   * Stok yoksa (added=0) 409 döner ve talep 'approved' YAPILMAZ.
   */
  async approve(id: string, actor: string): Promise<ReplacementRequest> {
    // Yazışmaya "onaylandı" sistem satırı, transaction COMMIT'inden SONRA eklenir (aşağıda):
    // tx İÇİNDE best-effort try/catch güvenli değildir (hatalı ifade tx'i 25P02 ile zehirler) →
    // yazışma kaydı ASLA onayı geri almaz. Kritik yol (advisory-lock + revoke + completeLine) aynen korundu.
    const updated = await this.approveTx(id, actor);
    await this.recordSystemMessage(id, 'Değişim talebi onaylandı, yeni lisans atandı.', actor);
    return updated;
  }

  /** approve()'un TOCTOU-korumalı çekirdeği (davranış değişmedi; yalnız ayrı metoda alındı). */
  private async approveTx(id: string, actor: string): Promise<ReplacementRequest> {
    // TOCTOU koruması: çift-tık/eşzamanlı onayda ikinci çağrı talebi kilitsiz okuyup revoke'u
    // no-op görüyor → completeLine added=0 → SAHTE "Değişim için stok yok" 409. Talep id'sine bağlı
    // pg_advisory_xact_lock + FOR UPDATE re-read ile serileştir (orders.service held-release deseni):
    // ikinci çağrı kilidi bekler, terminal durumu görüp 'Talep zaten çözülmüş' ile erken çıkar.
    // revoke/completeLine mevcut imzalarıyla this.db kullanıyor (tx almıyor); advisory-lock zaten
    // eşzamanlı approve()'ları dışladığı için bu güvenli — kilit statü kararını serileştirir.
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
      // (revoke→completeLine sırası zorunlu; ama stok baştan yoksa müşteriyi boşta bırakmayalım —
      // bu kontrol tamamen izin-verici; completeLine daha katı olsa bile mevcut revoke-sonrası-409
      // davranışına düşeriz, asla daha kötü değil.)
      const [avail] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(licenseItems)
        .innerJoin(orderLines, eq(orderLines.id, req.lineId))
        .where(
          and(
            eq(licenseItems.productId, orderLines.productId),
            eq(licenseItems.status, 'available'),
            sql`${licenseItems.useCount} < ${licenseItems.maxUses}`,
          ),
        );
      if (!avail || Number(avail.n) <= 0) {
        throw new ConflictException('Değişim için stok yok');
      }

      // 1) Eskiyi geri al (single → karantina, multi → kapasite iadesi; audit'e düşer).
      // markLineCanceled=false: hemen ardından completeLine ile MEŞRU yeniden-atama yapılacak;
      // satır 'canceled' işaretlenirse completeLine no-op eder → yanlış "stok yok". (Iade DEĞİL, değişim.)
      // Revoke sonucundan eski key id'sini al (soyağacı için).
      const revoked = await this.adminOrders.revokeAssignment(
        req.assignmentId,
        'replacement',
        actor,
        false,
      );

      // 2) Yenisini ata — satırın açılan yerine 1 birim (atomik atama makinesi).
      const res = await this.fulfillment.completeLine(req.lineId, 1, true);
      if (res.added <= 0) {
        // Stok yok: talep açık kalır (approved yapılmaz), 409.
        throw new ConflictException('Değişim için stok yok');
      }

      // Soyağacı (§3 "eski anahtarlar"): eski→yeni assignment_history + yeni atama id'si (tek yerde).
      const newAssignmentId = await recordReplacementLineage(this.db, {
        lineId: req.lineId,
        oldLicenseItemId: ('licenseItemId' in revoked ? revoked.licenseItemId : null) ?? null,
        reason: 'replacement',
        actor,
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

      // Müşteriye "değişim onaylandı" bildirimi (reject/requestInfo ile simetri). Best-effort +
      // SIRSIZ (yalnız durum) — SMTP hatası onayı BOZMAZ (teslimat maili ayrıca completeLine'da gider).
      await this.mail
        .enqueueReplacementNotice(updated!.orderId, updated!.customerEmail, 'approved', '')
        .catch(() => {});

      return updated!;
    });
  }

  /** Reddet — çözüm notuyla kapat + müşteriye durum bildirimi (yalnız durum+not, sırsız). */
  async reject(id: string, note: string, actor: string): Promise<ReplacementRequest> {
    const req = await this.getOrThrow(id);
    // Idempotent koruma: terminal (approved/rejected) durumdaki talep yeniden kapatılamaz.
    if (req.status !== 'open' && req.status !== 'info_requested') {
      throw new ConflictException('Talep zaten çözülmüş');
    }
    const [updated] = await this.db
      .update(replacementRequests)
      .set({
        status: 'rejected',
        resolutionNote: note,
        resolvedBy: actor,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(replacementRequests.id, id))
      .returning();

    // Bildirim best-effort (SMTP hatası talebi bozmaz).
    await this.mail.enqueueReplacementNotice(
      updated!.orderId,
      updated!.customerEmail,
      'rejected',
      note,
    );
    // Yazışmaya sistem satırı: talebin neden kapandığı thread'de de görünsün (best-effort).
    await this.recordSystemMessage(id, `Talep reddedildi. Gerekçe: ${note}`, actor);
    return updated!;
  }

  /**
   * Ek bilgi iste — müşteriye dönülür, talep açık kalır + durum bildirimi (sırsız).
   * `actor` reject/approve ile tutarlı olsun diye @AdminActor'dan alınır; talep ÇÖZÜLMEDİĞİ için
   * `resolvedBy`'a YAZILMAZ ve şemada "bilgi-istendi-eden" için ayrı kolon yok (migration eklenmedi) →
   * izlenebilirlik/imza tutarlılığı için ileri taşınır (opsiyonel, mevcut çağıranları kırmaz).
   */
  async requestInfo(id: string, note: string, actor?: string): Promise<ReplacementRequest> {
    const req = await this.getOrThrow(id);
    // Idempotent koruma: terminal (approved/rejected) durumdaki talepten bilgi istenemez.
    if (req.status !== 'open' && req.status !== 'info_requested') {
      throw new ConflictException('Talep zaten çözülmüş');
    }
    const [updated] = await this.db
      .update(replacementRequests)
      .set({ status: 'info_requested', resolutionNote: note, updatedAt: new Date() })
      .where(eq(replacementRequests.id, id))
      .returning();

    await this.mail.enqueueReplacementNotice(
      updated!.orderId,
      updated!.customerEmail,
      'info_requested',
      note,
    );
    // "Bilgi istendi" DURUM aksiyonu; sorunun metni yazışmada da görünür (admin mesajı olarak
    // AYRICA yazılmaz — çift kayıt olmasın diye tek sistem satırı).
    await this.recordSystemMessage(id, `Müşteriden ek bilgi istendi: ${note}`, actor);
    return updated!;
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
   * - internal=false ise müşteriye bildirim maili gider (best-effort; SMTP hatası mesajı YUTMAZ).
   */
  async addAdminMessage(
    requestId: string,
    input: { body: string; internal?: boolean },
    actor: string,
  ): Promise<{ message: ReplacementMessageRow; notified: boolean }> {
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

    let notified = false;
    if (!internal) {
      // Mevcut değişim-bildirimi mekanizması yeniden kullanılır (ayrı şablon YOK, §doc):
      // status='message' → MailService.replacementHeadline default dalına düşer
      // ("Talebinizin durumu güncellendi.") + mesaj gövdesi "Not:" olarak eklenir. SIR İÇERMEZ.
      notified = await this.mail
        .enqueueReplacementNotice(req.orderId, req.customerEmail, 'message', body)
        .then(() => true)
        .catch((e: unknown) => {
          this.logger.warn(
            `Destek yanıtı bildirimi gönderilemedi (request=${requestId}): ${errText(e)}`,
          );
          return false;
        });
    }

    return { message, notified };
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

  /** Site kapsamı GEREKTİRMEYEN admin yolu (kapsamlı sürüme delege eder — tek sorgu, tek 404 dili). */
  private async getOrThrow(id: string): Promise<ReplacementRequest> {
    return this.getScopedOrThrow(id);
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
