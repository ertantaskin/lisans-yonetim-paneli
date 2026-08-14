import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type Redis from 'ioredis';
import { recomputeOrderStatus } from './order-status';
import { lineStatusFor, remainingUnits } from './fill-target';
import { recordReplacementLineage } from './assignment-history';
import { buildStoreAdminUrl } from './store-admin-url';
import { FulfillmentService } from './fulfillment.service';
import { DB, type Database } from '../db/db.module';
import {
  assignmentHistory,
  assignments,
  auditLog,
  batches,
  emailLog,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
  orderStatusEnum,
  products,
  purchaseOrders,
  siteProductMappings,
  sites,
  stockAdjustments,
  supplierClaimItems,
  supplierClaims,
  suppliers,
  type Site,
} from '../db/schema';
// Barrel'a eklenmedi (replacements modülüyle aynı desen) → doğrudan dosyadan al.
import { replacementRequests } from '../db/schema/replacementRequests';
import {
  AccountPayloadSchema,
  maskAccountFields,
  maskSecret,
  parseAccountPayload,
  type PayloadField,
} from '@lisans/shared';
import { CryptoService } from '../crypto/crypto.service';
import { notExpiredCond } from '../assignment/assign';
import { REDIS } from '../redis/redis.module';
import { MailService } from '../mail/mail.service';

/**
 * Payload'ı maskeler — SABİT genişlikli gövde + yalnız son 4 hane (reveal ayrı/loglu iş).
 * Uzunluk/segment yapısı sızmaz (§8). Tek kaynak: shared `maskSecret`.
 */
export function mask(plain: string): string {
  return maskSecret(plain);
}

/**
 * Bir atamanın maskeli gösterimini üretir. Hesap ürününde alan-alan maskeler (secret
 * alanlar maskeli, kullanıcı adı gibi alanlar açık) → JSON yapısı/parola kuyruğu sızmaz.
 * key/code/custom'da tek maskeli string döner.
 */
function maskPayload(
  plain: string,
  kind: string,
  payloadSchema: unknown,
): { maskedPayload: string; maskedFields: PayloadField[] | null } {
  if (kind === 'account') {
    const parsed = AccountPayloadSchema.safeParse(payloadSchema);
    if (parsed.success) {
      const masked = maskAccountFields(parseAccountPayload(parsed.data, plain));
      return {
        maskedPayload: masked.map((f) => `${f.label}: ${f.value}`).join(' · '),
        maskedFields: masked,
      };
    }
  }
  return { maskedPayload: mask(plain), maskedFields: null };
}

/**
 * Mağaza admin sipariş linki artık TEK KAYNAKTAN gelir (`./store-admin-url`) — daha önce bu
 * dosyada ve stock.service'te İKİ AYRI kopya vardı ve davranışları farklıydı (origin türetimi).
 * Mevcut tüketiciler (testler dahil) bu modülden import etmeye devam edebilsin diye re-export.
 */
export { buildStoreAdminUrl };

/**
 * Bonus atamalar AYRI sentetik satırda durur (`bonus:<origWooItemId>:<uuid>`, eski format
 * `bonus:<uuid>`). Bu yardımcı satırın AİT OLDUĞU mağaza kalemini çözer → WP meta box /
 * panel, bonus'u doğru ürün kaleminin altında gruplayabilir (önek ayrıştırma tekrarı yok).
 * Orijin gömülü değilse (eski format) satırın kendi id'si döner.
 */
export function resolveOriginRemoteLineId(remoteLineId: string): string {
  if (!remoteLineId.startsWith('bonus:')) return remoteLineId;
  const rest = remoteLineId.slice('bonus:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return remoteLineId; // eski `bonus:<uuid>` → orijin bilinmiyor
  return rest.slice(0, sep);
}

/** Satır bonus (sentetik, mağaza tarafında karşılığı olmayan) mı? */
export function isBonusRemoteLineId(remoteLineId: string): boolean {
  return remoteLineId.startsWith('bonus:');
}

/**
 * Bir sipariş satırının NEDEN beklediğinin makine-okunur tanısı (§13 "bekleyen satır mantığı"):
 * operatör "teslim edilmedi" yerine EYLEME dönük sebebi görür. Öncelik terminal/blokaj sırası:
 * iptal → inceleme → eşlemesiz → ön-sipariş penceresi → stok yok → all-or-nothing eksiği.
 */
export type PendingReason =
  | 'unmapped'
  | 'no_stock'
  | 'held'
  | 'canceled'
  | 'release_gated'
  | 'all_or_nothing'
  | null;

/**
 * Karantina listesi süzgeçleri (§13 "listeyi tedarikçiye ilet"). Hepsi opsiyonel — parametresiz
 * çağrı eski davranışı birebir korur (son 500 ölü anahtar, en yeni önce).
 * CSV/Excel üretimi API'DE YAPILMAZ; uç yalnız JSON döner (biçimlendirme admin tarafında).
 */
export interface QuarantineQuery {
  /** Ürün adı/SKU, müşteri e-postası, mağaza sipariş no, parti etiketi, tedarikçi adı (ILIKE). */
  search?: string;
  status?: 'quarantined' | 'voided';
  productId?: string;
  supplierId?: string;
  /**
   * ISO tarih/zaman — birleşik `quarantinedAt` üzerinden süzülür. SQL'de SAĞLAM BİR ÜST KÜME
   * (superset) ön-filtresi uygulanır (pencere doğru döneme kayar), kesin süzme okuma sonrası
   * yapılır — bkz. listQuarantine içindeki "SQL ÖN-FİLTRESİ" notu.
   */
  from?: string;
  to?: string;
  /**
   * TEDARİKÇİYE BİLDİRİM DURUMU (§12 değişim fişi).
   *   `none` → henüz hiçbir fişe girmemiş (ya da girip REDDEDİLİP havuza dönmüş) kalemler.
   *            "Bekleyenler" sekmesinin ve Z raporu adaylarının tanımı budur.
   *   `open`  → hâlihazırda bir fişte olan kalemler (bildirilmiş).
   *   `any`   → süzme yok. **VARSAYILAN** — parametresiz çağrı eski davranışı birebir korur.
   */
  claimed?: 'none' | 'open' | 'any';
  /** Varsayılan 500, üst sınır 5000. */
  limit?: number;
  /**
   * Denetim aktörü. Karantina listesi ölü anahtarların DÜZ METNİNİ toplu döndürür (tedarikçiye
   * değişim talebi için dışa aktarılır) — "reveal audit'e düşer" DEĞİŞMEZ kuralı bu yol için de
   * geçerlidir. Verilmezse 'admin' yazılır.
   */
  actor?: string;
  /**
   * Düz-metin görme yetkisi (denetim A1/M1). owner (veya auth KAPALI) → TAM anahtar; owner-OLMAYAN
   * admin → maskeli önizleme (key: son-4; account: yalnız secret-olmayan alanlar). Sipariş detayı /
   * envanter maskesiyle simetrik. reveal audit'i YALNIZ gerçek düz-metin döndüğünde (reveal=true) yazılır.
   */
  reveal?: boolean;
  /**
   * ANAHTAR ÖNİZLEMESİ ÜRETİLSİN Mİ? **Varsayılan `true`** — parametresiz/eski çağrılar
   * (fiş kesme, dışa aktarma) davranışını birebir korur.
   *
   * PERF (denetim): `keyPreview` satır BAŞINA bir AES-GCM `decrypt` demektir ve bu tek Node
   * event loop'unda SENKRON koşar (login scrypt'inde düzeltilen sınıfın aynısı — AYNI süreç
   * sipariş teslimatını servis ediyor). Havuz ekranı listeyi `limit=5000` ile açtığında bu
   * on binlerce çözme işlemi eder; oysa o ekran anahtarın kendisini GÖSTERMEZ (yalnız sayar
   * ve gruplar). `preview=false` verildiğinde çözme HİÇ koşmaz ve alan `null` döner —
   * satırların SAYISI, SIRASI ve diğer TÜM alanları birebir aynı kalır.
   */
  preview?: boolean;
}

@Injectable()
export class AdminOrdersService {
  private readonly logger = new Logger(AdminOrdersService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  /**
   * Loglu reveal (§17): maskeli lisansın tam payload'ını gösterir, audit'e düşer.
   * Hesap ürününde alanları (fields) da çözülmüş değerlerle döner.
   */
  async reveal(
    assignmentId: string,
    actor: string,
  ): Promise<{ payload: string; fields: PayloadField[] | null }> {
    const [row] = await this.db
      .select({
        payloadEnc: licenseItems.payloadEnc,
        licenseItemId: licenseItems.id,
        productKind: products.kind,
        payloadSchema: products.payloadSchema,
      })
      .from(assignments)
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!row) throw new NotFoundException('Atama bulunamadı');

    await this.db.insert(auditLog).values({
      action: 'reveal',
      actor,
      targetType: 'assignment',
      targetId: assignmentId,
      meta: { licenseItemId: row.licenseItemId, kind: row.productKind },
    });

    const plain = this.crypto.decrypt(
      row.payloadEnc,
      CryptoService.licenseItemAad(row.licenseItemId),
    );
    const schema =
      row.productKind === 'account' ? AccountPayloadSchema.safeParse(row.payloadSchema) : null;
    const fields = schema?.success ? parseAccountPayload(schema.data, plain) : null;
    return { payload: plain, fields };
  }

  /**
   * Geri alınabilir gizleme (§4). Müşteri görünümünde "inceleme altında".
   *
   * KRİTİK (denetim H1-sınıfı): YALNIZ active↔suspended geçişine izin verilir. Aksi halde bir
   * revoked/replaced/expired atama `suspend=false` ile YENİDEN 'active' yapılabilir → iade edilmiş
   * (karantina) veya değişimle geri alınmış (kusurlu) key MÜŞTERİYE TEKRAR teslim edilirdi
   * (§2 "iade edilen hak dönmez" ihlali + over-deliver / reconcile Σunits≠fulfilledQty). Durum
   * koşulu UPDATE WHERE'ine gömülü → atomik (eşzamanlı revoke ile yarışta da terminal atama
   * yeniden aktifleşmez).
   */
  async suspend(assignmentId: string, suspend: boolean, actor: string, reason?: string) {
    const [asg] = await this.db
      .select({ status: assignments.status })
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!asg) throw new NotFoundException('Atama bulunamadı');
    if (asg.status !== 'active' && asg.status !== 'suspended') {
      throw new BadRequestException(
        'Yalnız aktif veya askıdaki atama askıya alınabilir/geri açılabilir',
      );
    }

    const target = suspend ? 'suspended' : 'active';
    const updated = await this.db
      .update(assignments)
      .set({ status: target })
      .where(
        and(
          eq(assignments.id, assignmentId),
          inArray(assignments.status, ['active', 'suspended']),
        ),
      )
      .returning({ id: assignments.id });
    if (updated.length === 0) {
      // Yarışta terminal duruma geçmiş (revoke/expire) → yeniden aktifleştirme reddedilir.
      throw new BadRequestException('Atama durumu değişti; işlem uygulanamadı');
    }
    await this.db.insert(auditLog).values({
      action: suspend ? 'suspend' : 'unsuspend',
      actor,
      targetType: 'assignment',
      targetId: assignmentId,
      // "Kim + neden" (§8): sebep opsiyoneldir (askıya alma çoğu zaman refleks bir işlem), ama
      // verildiyse iz KAYBOLMAZ — sipariş detayındaki denetim izinde görünür.
      meta: reason ? { reason } : undefined,
    });
    return { assignmentId, status: target };
  }

  /**
   * Admin PROAKTİF değişim (§4 /assignments/:id/replace): kusurlu bir key'i müşteri "Sorun
   * Bildir" açmadan aynı üründen TAZE key ile değiştirir. Değişim makinesi (revoke false +
   * completeLine) — iade DEĞİL, satır 'canceled' işaretlenmez → yeniden-atama meşru. Eski key
   * karantinaya gider (satışa dönmez, §2); eski→yeni soyağacı assignment_history'ye yazılır.
   *
   * MAK/çok-kullanımlı ürün otomatik değişimi desteklenmez (paylaşımlı anahtar — elle);
   * stok yoksa eski atama KORUNUR (revoke edilmeden 409) — müşteri boşta kalmaz. replacements.approve
   * ile aynı güvence.
   */
  async replaceAssignment(assignmentId: string, reason: string, actor: string) {
    // TOCTOU koruması (denetim bulgusu): stok ön-kontrolü ile taze atama arasında BAŞKA bir
    // değişim aynı ürünün son anahtarını kapabiliyordu → eski atama zaten revoke edilmiş olduğu
    // için 409 atılıyor ve müşteri lisansını KALICI kaybediyordu. Aynı ürün üzerindeki
    // değişimleri advisory-lock ile serileştir (replacements.approve deseni). Kilit ÖNCE alınır,
    // ön-kontrol ve revoke+atama kilit altında koşar.
    //
    // ATOMİKLİK (denetim bulgusu): revoke ve completeLine ARTIK bu tx'i (`tx`) kullanır — eskiden
    // ikisi de KENDİ transaction'ında bağımsız commit ediyordu, bu yüzden added=0'da atılan 409
    // eski anahtarı KARANTİNADA bırakıyordu (müşteri lisansını kaybediyordu). Tek tx içinde
    // throw ⇒ rollback ⇒ revoke da geri alınır ⇒ müşterinin anahtarı CANLI kalır.
    const { result, completion } = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'replace:' + assignmentId}))`);
      return this.replaceAssignmentLocked(assignmentId, reason, actor, tx);
    });
    // Yan etkiler (teslimat maili + geri-kanal webhook) COMMIT SONRASI: tx içinde tetiklenselerdi
    // ayrı bağlantıdan henüz commit EDİLMEMİŞ sipariş durumu okunur (yanlış webhook olayı) ve
    // rollback halinde OLMAMIŞ bir teslimat duyurulmuş olurdu.
    await this.fulfillment.emitCompletionEffects(completion);
    return result;
  }

  /**
   * `replaceAssignment` çekirdeği — ÇAĞIRAN advisory-lock'u almış ve `tx`'i geçmiş olmalıdır.
   * TÜM okuma/yazmalar (revoke + completeLine + soyağacı + audit) AYNI transaction'da koşar;
   * herhangi bir aşamada throw ⇒ hepsi geri alınır. Yan etkiler çağırana (commit sonrası) bırakılır.
   */
  private async replaceAssignmentLocked(
    assignmentId: string,
    reason: string,
    actor: string,
    tx: Database,
  ) {
    const [row] = await tx
      .select({
        status: assignments.status,
        lineId: assignments.lineId,
        licenseItemId: assignments.licenseItemId,
        productId: orderLines.productId,
        usageMode: products.usageMode,
      })
      .from(assignments)
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!row) throw new NotFoundException('Atama bulunamadı');
    if (row.status !== 'active') {
      throw new BadRequestException('Yalnız aktif atama değiştirilebilir');
    }
    if (row.usageMode === 'multi') {
      throw new BadRequestException(
        'Çok-kullanımlı (MAK) üründe otomatik değişim desteklenmez — elle işleyin.',
      );
    }

    // Stok ön-kontrolü: eskiyi REVOKE ETMEDEN önce uygun available stok var mı? (replacements deseni)
    // TEK KAYNAK: fulfillment.allocatableCountForLine (aynı sayım "added=0" ayrımında da kullanılır).
    if ((await this.fulfillment.allocatableCountForLine(row.lineId, tx)) <= 0) {
      throw new ConflictException('Değişim için stok yok');
    }

    // 1) Eskiyi geri al — markLineCanceled=false (iade DEĞİL; satır yeniden atanabilir kalır).
    // tx GEÇİLİR → SAVEPOINT olarak koşar; sonraki bir throw revoke'u da geri alır.
    const revoked = await this.revokeAssignment(assignmentId, reason, actor, false, tx);
    if ('already' in revoked) {
      // Yarışta başka bir yol (iade/eşzamanlı değişim) atamayı zaten geri almış → değişim uygulanmaz.
      throw new ConflictException('Atama durumu değişti; değişim uygulanmadı');
    }
    // 2) Taze key ata (atomik atama makinesi) — AYNI tx içinde.
    const res = await this.fulfillment.completeLine(row.lineId, 1, true, tx);
    if (res.added <= 0) {
      // added=0 "stok yok" DEMEK DEĞİLDİR: allocate FOR UPDATE SKIP LOCKED kullanır → eşzamanlı bir
      // atama satırları kilitlediyse stok VARKEN de 0 döner. Operatöre GERÇEĞİ söyle.
      const stillAvailable = await this.fulfillment.allocatableCountForLine(row.lineId, tx);
      throw new ConflictException(
        stillAvailable > 0
          ? 'Lisans şu anda atanamadı (eşzamanlı işlem sürüyor) — lütfen tekrar deneyin.'
          : 'Değişim için stok yok',
      );
    }
    // 3) Soyağacı: eski→yeni assignment_history + newAssignmentId (§3 "eski anahtarlar").
    // Yeni atama id'si completeLine sonucundan KESİN gelir (satırın "en yeni aktif ataması"
    // tahmini eşzamanlı ikinci bir değişimde yanlış atamayı seçebilirdi).
    const newAssignmentId = await recordReplacementLineage(tx, {
      lineId: row.lineId,
      oldLicenseItemId: row.licenseItemId,
      reason,
      actor,
      newAssignmentId: res.createdAssignmentIds?.[0] ?? null,
    });
    await tx.insert(auditLog).values({
      action: 'replace',
      actor,
      targetType: 'assignment',
      targetId: assignmentId,
      meta: { op: 'admin_replace', oldLicenseItemId: row.licenseItemId, newAssignmentId, reason },
    });
    return {
      result: { oldAssignmentId: assignmentId, newAssignmentId, status: 'replaced' as const },
      completion: res,
    };
  }

  /** Teslimat mailini tekrar gönder — 60sn debounce (§13). Kim tetikledi audit'e düşer. */
  async resend(orderId: string, actor = 'panel:admin'): Promise<{ queued: boolean }> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const key = `resend:${orderId}`;
    const set = await this.redis.set(key, '1', 'EX', 60, 'NX');
    if (set !== 'OK') {
      throw new BadRequestException('Çok sık — 60 saniye içinde tekrar gönderilemez');
    }
    await this.mail.enqueueDelivery(
      order.id,
      order.customerEmail,
      `Siparişiniz — ${order.remoteOrderId}`,
    );
    // §8 izlenebilirlik: müşteriye lisans İÇEREN mail yeniden gönderildi — kim yaptı iz kalsın.
    // best-effort: audit yazımı zaten kuyruğa alınmış maili geri almaz, isteği patlatmamalı.
    try {
      await this.db.insert(auditLog).values({
        action: 'resend',
        actor,
        targetType: 'order',
        targetId: orderId,
      });
    } catch {
      /* audit yazımı başarısız → mail yine de kuyrukta */
    }
    return { queued: true };
  }

  async list(status?: string) {
    // MAĞAZA BAĞLAMI: sipariş listesi de çok sitelidir → domain + kanal tipi JOIN ile döner
    // (pending kuyruğuyla AYNI sözleşme; ekranlar arasında tutarlı kolon). Sır kolonu seçilmez.
    const selection = { ...getTableColumns(orders), siteDomain: sites.domain, siteType: sites.type };
    if (!status) {
      return this.db
        .select(selection)
        .from(orders)
        .leftJoin(sites, eq(sites.id, orders.siteId))
        .orderBy(desc(orders.createdAt))
        .limit(200);
    }
    // F5: doğrulanmamış ?status= değeri (`as never` cast'iyle) pg-enum karşılaştırmasına ulaşıp
    // "invalid input value for enum" → 500 üretiyordu. Enum üyeliğini SORGUDAN ÖNCE doğrula: geçerli
    // değilse boş sonuç (tip 'find' ile daraltılır → eq'de cast gerekmez, üyelik tip düzeyinde zorlanır).
    const match = orderStatusEnum.enumValues.find((v) => v === status);
    if (!match) return [];
    return this.db
      .select(selection)
      .from(orders)
      .leftJoin(sites, eq(sites.id, orders.siteId))
      .where(eq(orders.status, match))
      .orderBy(desc(orders.createdAt))
      .limit(200);
  }

  /**
   * Bekleyen Teslimatlar ana ekranı (§13): henüz TAMAMLANMAMIŞ siparişler.
   *
   * 'unmapped' de DAHİLDİR (kullanıcı şikâyeti): mağaza ürünü panele eşlenmemişse sipariş
   * `unmapped` durumunda kalır — teslim edilecek satırı vardır ama operatörün EYLEM alması
   * gerekir (ürünü eşle → bekleyen satırı çöz). Eskiden yalnız pending/partial listelendiği
   * için bu siparişler "Bekleyen Teslimatlar" ekranında HİÇ GÖRÜNMÜYOR, operatör panelde
   * hiçbir iz bulamıyordu. Terminal durumlar (fulfilled/revoked) elbette dışarıda kalır.
   *
   * F11 (denetim): tek `limit(200)` PAYLAŞILIYORDU → mağazadan gelen eşlemesiz sipariş seli
   * (yeni ürün eşlenmeden satışa açıldığında onlarca sipariş) pencereyi doldurup GERÇEKTEN stok
   * bekleyen ESKİ siparişleri listeden düşürüyordu (operatör "sipariş kayboldu" görüyordu).
   * Artık İKİ AYRI sorgu var — pending/partial için 200, unmapped için 100 — sonuçlar tarih
   * azalan birleştirilir. Kova birbirini yiyemez.
   *
   * Dönüş tipi DİZİ kalır (S3: şekil değişikliği YOK); her satıra `hasUnmappedLine` eklenir —
   * "bu siparişin eşlemesi olmayan AKTİF satırı var mı" (S1 ile aynı ifade). Sipariş `status`
   * alanı kısmen teslim edilmiş karma siparişlerde 'partial' olabilir ama satırlarından biri
   * hâlâ eşlemesizdir; operatör bunu status'ten göremiyordu. Tek EXISTS alt sorgusu ile çözülür
   * (N+1 YOK); `order_lines_order_idx` + kısmi `order_lines_pending_product_idx` karşılar.
   *
   * Her satırda ayrıca `productSummary` döner: siparişin HANGİ ürün için beklediği + ürün
   * başına eksik adet (aşağıdaki gerekçe). Ekran stok önceliğini listeden okuyabilsin diye.
   */
  async pending() {
    // S1/S3 ortak ifadesi: eşlemesiz (product_id NULL) + iptal EDİLMEMİŞ + hâlâ iş bekleyen satır.
    //
    // DİKKAT (tuzak): korelasyon `orders.id` DÜZ METİN yazılır, `${orders.id}` ile GÖMÜLMEZ.
    // Drizzle tek-tablolu SELECT'te projeksiyondaki kolonları TABLO ÖNEKSİZ basar; gömülü kolon
    // da öyle basılır → alt sorguda `ol.order_id = "id"` olur ve "id" iç kapsamdan (ol.id)
    // çözülür → koşul HER ZAMAN false döner (sessiz kırılma, hata vermez). Üretilen SQL
    // `.toSQL()` ile doğrulandı.
    const hasUnmappedLine = sql<boolean>`exists (
      select 1 from order_lines ol
      where ol.order_id = orders.id
        and ol.product_id is null
        and ol.canceled = false
        and ol.status in ('pending', 'partial')
    )`;
    // ÜRÜN ÖZETİ (operatör şikâyeti): ekranın asıl aksiyonu "Stok Gir" ama satırda HANGİ ürün
    // için beklendiği yazmıyordu → operatör 40 siparişi tek tek açmadan stok önceliğini
    // göremiyordu. Sipariş başına ürün kırılımı TEK korelasyonlu alt sorguyla döner (N+1 YOK;
    // `order_lines_order_idx` karşılar) — ürün başına eksik adet + ürün kimliği (UI ürün
    // detayına derin bağlantı verir).
    //
    // Yalnız İŞ BEKLEYEN satırlar sayılır: iptal/iade (canceled) satır yeniden teslim edilmez
    // (H1), terminal satır zaten bitmiştir. `qty` PANEL birimidir (eşleme anında bundleQty ile
    // ölçeklenmiş) → `qty - fulfilled_qty` doğrudan "kaç lisans eksik" demektir.
    // product_id NULL satırlar burada YOKTUR (eşlemesiz) — onları `hasUnmappedLine` anlatır.
    //
    // Korelasyonda `orders.id` DÜZ METİN yazılır (yukarıdaki EXISTS ile aynı tuzak: gömülü
    // kolon tablo-öneksiz basılıp iç kapsamdan çözülebilir).
    // `to_json(array(...))`: TEK seviyeli korelasyonlu alt sorgu → boş sonuçta `[]` döner.
    // (FROM-içi alt sorgu sarmalı bilinçli KULLANILMADI: dış sorguya korelasyon kapsam
    // kuralları orada tartışmalı; ARRAY alt sorgusu düz korelasyondur ve her sürümde geçerlidir.)
    const productSummary = sql<
      Array<{ productId: string; name: string; missing: number }>
    >`to_json(array(
      select json_build_object(
        'productId', ol.product_id,
        'name', min(p.name),
        'missing', sum(greatest(ol.qty - ol.fulfilled_qty, 0))::int
      )
      from order_lines ol
      join products p on p.id = ol.product_id
      where ol.order_id = orders.id
        and ol.canceled = false
        and ol.status in ('pending', 'partial')
      group by ol.product_id
      order by sum(greatest(ol.qty - ol.fulfilled_qty, 0)) desc, min(p.name)
    ))`;

    const columns = getTableColumns(orders);

    // MAĞAZA BAĞLAMI (operatör şikâyeti): kuyruk ÇOK SİTELİDİR — satırın hangi mağazadan
    // geldiği görünmezse operatör yanlış mağazanın stoğuna/eşlemesine gider. `siteId` (UUID)
    // tek başına okunabilir değil → domain + kanal tipi JOIN ile döner (sipariş detayı deseni).
    // SIR KOLONU SEÇİLMEZ (hmac/api_key asla); yalnız domain + type.
    const selection = {
      ...columns,
      hasUnmappedLine,
      productSummary,
      siteDomain: sites.domain,
      siteType: sites.type,
    };

    const [waiting, unmapped] = await Promise.all([
      // Stok/kalan bekleyenler (klasik kuyruk).
      this.db
        .select(selection)
        .from(orders)
        .leftJoin(sites, eq(sites.id, orders.siteId))
        .where(inArray(orders.status, ['pending', 'partial']))
        .orderBy(desc(orders.createdAt))
        .limit(200),
      // Eşlemesiz siparişler AYRI kotada — kendi seli yalnız kendi kovasını doldurur.
      this.db
        .select(selection)
        .from(orders)
        .leftJoin(sites, eq(sites.id, orders.siteId))
        .where(eq(orders.status, 'unmapped'))
        .orderBy(desc(orders.createdAt))
        .limit(100),
    ]);

    // Tek liste, tarih azalan (UI eşlemesizleri ayrıca öne alabilir — sıralama sunum kararı).
    return [...waiting, ...unmapped].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  /** Admin sipariş detayı: satırlar + atamalar (maskeli) + timeline (§7 meta box). */
  async detail(orderId: string, actor = 'admin', reveal = true) {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    // Siparişin geldiği mağaza (site) + kanal tipi — operatör hangi siteden/hangi platformdan
    // geldiğini görsün (çok siteli, platform-bağımsız panel: woocommerce/marketplace/reseller).
    // adminOrderUrlTemplate YALNIZ storeAdminUrl türetmek için okunur; yanıta GİRMEZ
    // (sır kolonları — hmac/api_key — hiç seçilmez). webhookUrl ARTIK OKUNMAZ: iç hostname
    // olabildiğinden link üretiminde kullanılmıyor (bkz. store-admin-url.ts).
    const [siteRow] = await this.db
      .select({
        domain: sites.domain,
        type: sites.type,
        adminOrderUrlTemplate: sites.adminOrderUrlTemplate,
      })
      .from(sites)
      .where(eq(sites.id, order.siteId))
      .limit(1);

    // Eski/yeni lisans satırı AYRI alias'larla bağlanır (aynı tabloya iki join) → değişim
    // geçmişinde hem değişen (ölü) hem yerine geçen (canlı) anahtar tek sorguda gelir.
    const oldItem = alias(licenseItems, 'old_li');
    const newItem = alias(licenseItems, 'new_li');

    // Bağımsız okumalar TEK turda (N+1 yok; ek alanlar ekstra round-trip getirmez).
    const [lineRows, asgRows, events, emails, historyRows, replacementRows] = await Promise.all([
      // Satırlar + ürün adı + MAĞAZA ürün bilgisi (remoteProductId/remoteVariationId/remoteName)
      // + "neden bekliyor" tanısı için gereken ürün alanları + ürünün ANLIK kullanılabilir
      // kapasitesi (tek korelasyonlu alt sorgu; sipariş satırı sayısı küçüktür, N+1 round-trip yok).
      this.db
        .select({
          id: orderLines.id,
          remoteLineId: orderLines.remoteLineId,
          remoteProductId: orderLines.remoteProductId,
          remoteVariationId: orderLines.remoteVariationId,
          remoteName: orderLines.remoteName,
          qty: orderLines.qty,
          canceledUnits: orderLines.canceledUnits,
          fulfilledQty: orderLines.fulfilledQty,
          status: orderLines.status,
          productId: orderLines.productId,
          canceled: orderLines.canceled,
          policyOverride: orderLines.policyOverride,
          productName: products.name,
          productSku: products.sku,
          productKind: products.kind,
          productPolicy: products.fulfillmentPolicy,
          productStockless: products.stockless,
          productReleaseAt: products.releaseAt,
          // MULTI/MAK dahil kapasite: Σ(max_uses − use_count) (products.list ile AYNI semantik).
          //
          // notExpiredCond('li'): atama sorgusu (assign.ts) stok ömrü dolmuş kalemi ZATEN
          // dışlar. Bu sayı sipariş detayındaki "neden bekliyor" tanısını (diagnosePendingReason:
          // no_stock / all_or_nothing) besliyor — süresi geçmiş kalemler sayılırsa panel
          // "stok var" der ama "Kalanları Ata" 0 atar (operatör yanlış yönlendirilir).
          availableStock: sql<number>`(
            select coalesce(sum(li.max_uses - li.use_count), 0)::int
            from license_items li
            where li.product_id = ${orderLines.productId} and li.status = 'available'
              and ${notExpiredCond('li')}
          )`,
        })
        .from(orderLines)
        .leftJoin(products, eq(orderLines.productId, products.id))
        .where(eq(orderLines.orderId, orderId)),

      this.db
        .select({
          id: assignments.id,
          lineId: assignments.lineId,
          // Mağaza kalemi (Woo item id) + bonus sentetik satırın orijini → panel/WP atamayı
          // DOĞRU ürün kaleminin altında gruplayabilir.
          remoteLineId: orderLines.remoteLineId,
          remoteName: orderLines.remoteName,
          status: assignments.status,
          units: assignments.units,
          validUntil: assignments.validUntil,
          deliveredAt: assignments.deliveredAt,
          payloadEnc: licenseItems.payloadEnc,
          licenseItemId: licenseItems.id,
          // multi kapasite görünürlüğü + hesap alan-maskesi için.
          itemMaxUses: licenseItems.maxUses,
          itemUseCount: licenseItems.useCount,
          productKind: products.kind,
          productName: products.name,
          payloadSchema: products.payloadSchema,
        })
        .from(assignments)
        .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .innerJoin(products, eq(orderLines.productId, products.id))
        .where(eq(assignments.orderId, orderId))
        // SIRA: stoğa giriş sırası (`seq`). ORDER BY yoktu → sipariş detayındaki anahtar
        // listesi müşterinin mailindeki/My Account'taki sırayla tutmayabiliyordu; artık
        // üç yüzey de aynı yönü kullanır (getDeliveries + mail.processor + burası).
        .orderBy(licenseItems.seq),

      this.db
        .select()
        .from(fulfillmentEvents)
        .where(eq(fulfillmentEvents.orderId, orderId))
        .orderBy(fulfillmentEvents.createdAt),

      this.db
        .select()
        .from(emailLog)
        .where(eq(emailLog.orderId, orderId))
        .orderBy(emailLog.createdAt),

      // Değişim soyağacı (§3/§7 "eski anahtar geçmişi"): bu siparişin atamalarına bağlı
      // assignment_history satırları. BONUS satırlar da KAPSANIR (bonus sentetik satırın
      // productId'si vardır; join ürün-seviyesinde LEFT → hiçbir soyağacı düşmez).
      this.db
        .select({
          id: assignmentHistory.id,
          assignmentId: assignmentHistory.assignmentId,
          reason: assignmentHistory.reason,
          actor: assignmentHistory.actor,
          createdAt: assignmentHistory.createdAt,
          lineId: assignments.lineId,
          remoteLineId: orderLines.remoteLineId,
          remoteName: orderLines.remoteName,
          productName: products.name,
          oldPayloadEnc: oldItem.payloadEnc,
          oldLicenseItemId: oldItem.id,
          newPayloadEnc: newItem.payloadEnc,
          newLicenseItemId: newItem.id,
          // Anahtarın ürün tipi: key ise TAM göster (ölü/karantina key → sır değil),
          // account ise parola sızmasın diye maskeli kal.
          productKind: products.kind,
        })
        .from(assignmentHistory)
        .innerJoin(assignments, eq(assignmentHistory.assignmentId, assignments.id))
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .leftJoin(products, eq(orderLines.productId, products.id))
        .leftJoin(oldItem, eq(assignmentHistory.oldLicenseItemId, oldItem.id))
        .leftJoin(newItem, eq(assignmentHistory.newLicenseItemId, newItem.id))
        .where(eq(assignments.orderId, orderId))
        .orderBy(desc(assignmentHistory.createdAt)),

      // Bu siparişe ait değişim/destek talepleri (§13) — sipariş bağlamında görünsün ki operatör
      // "Sorun Bildir → onayla" akışını siparişten takip edebilsin (support ekranıyla çift yönlü bağ).
      this.db
        .select({
          id: replacementRequests.id,
          status: replacementRequests.status,
          reason: replacementRequests.reason,
          withinWarranty: replacementRequests.withinWarranty,
          resolutionNote: replacementRequests.resolutionNote,
          lineId: replacementRequests.lineId,
          assignmentId: replacementRequests.assignmentId,
          createdAt: replacementRequests.createdAt,
        })
        .from(replacementRequests)
        .where(eq(replacementRequests.orderId, orderId))
        .orderBy(desc(replacementRequests.createdAt)),
    ]);

    const asgIds = asgRows.map((a) => a.id);

    // "Kim yaptı" izi (§8): bu siparişin VE atamalarının audit_log kayıtları TEK sorguda.
    // Terminal atamaların revoke SEBEBİ de buradan türetilir (ayrı sorgu yok). Otomatik
    // görüntüleme-reveal kayıtları (meta.auto=true) HARİÇ — aksi halde her sayfa açılışı izi boğar.
    const auditRows = await this.db
      .select({
        id: auditLog.id,
        action: auditLog.action,
        actor: auditLog.actor,
        targetType: auditLog.targetType,
        targetId: auditLog.targetId,
        meta: auditLog.meta,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .where(
        and(
          asgIds.length
            ? or(
                and(eq(auditLog.targetType, 'order'), eq(auditLog.targetId, orderId)),
                and(eq(auditLog.targetType, 'assignment'), inArray(auditLog.targetId, asgIds)),
              )
            : and(eq(auditLog.targetType, 'order'), eq(auditLog.targetId, orderId)),
          sql`(${auditLog.meta} ->> 'auto') is distinct from 'true'`,
          // PERF: audit_log'da (target_type, target_id) index'i YOK; tek index created_at'tir.
          // Bu siparişe ait bir audit kaydı siparişten ÖNCE oluşamaz → alt sınır, taramayı
          // `audit_log_created_idx` üzerinde sipariş tarihine kadar KESER (migration gerekmez).
          gte(auditLog.createdAt, order.createdAt),
        ),
      )
      .orderBy(desc(auditLog.createdAt))
      .limit(300);

    // Bir atamanın birden çok revoke kaydı olamaz ama defansif: en yeni kazanır.
    const revokeReasonByAsg = new Map<string, string>();
    for (const r of auditRows) {
      if (r.action !== 'revoke' || r.targetType !== 'assignment' || !r.targetId) continue;
      if (revokeReasonByAsg.has(r.targetId)) continue;
      const reason = (r.meta as { reason?: unknown } | null)?.reason;
      if (typeof reason === 'string' && reason) revokeReasonByAsg.set(r.targetId, reason);
    }

    // Değişimle geri alınan atamalar: eski lisans satırı assignment_history.oldLicenseItemId
    // olarak geçiyorsa bu atama İPTAL/İADE DEĞİL, DEĞİŞTİRİLMİŞTİR — UI "iptal" yerine
    // "değiştirildi" etiketleyebilsin diye türetilmiş bayrak döner (durum makinesine dokunulmaz;
    // assignments.status yolu ve tüm invaryantlar aynen korunur).
    const replacedByLicenseItem = new Map<
      string,
      { historyId: string; newAssignmentId: string; reason: string; at: Date | null }
    >();
    for (const h of historyRows) {
      if (!h.oldLicenseItemId || replacedByLicenseItem.has(h.oldLicenseItemId)) continue;
      replacedByLicenseItem.set(h.oldLicenseItemId, {
        historyId: h.id,
        newAssignmentId: h.assignmentId,
        reason: h.reason,
        at: h.createdAt ?? null,
      });
    }
    // Soyağacı satırının ESKİ atamasını (aynı lisans satırını taşıyan terminal atama) çöz.
    const terminalAsgByLicenseItem = new Map<string, string>();
    for (const a of asgRows) {
      if (a.status === 'active' || a.status === 'suspended') continue;
      if (!terminalAsgByLicenseItem.has(a.licenseItemId)) {
        terminalAsgByLicenseItem.set(a.licenseItemId, a.id);
      }
    }

    // Görüntüleme audit'i (§ "reveal/kopyalama audit'e düşer"): admin paneli kimlik-doğrulamalı
    // olduğu için lisanslar artık maskesiz gösterilir (kullanıcı isteği) — bu yüzden her sipariş
    // detayı görüntülemesi TEK reveal kaydına düşer (kim, ne zaman, kaç lisans gördü). Böylece
    // maskeyi kaldırmak "reveal audit'e düşer" değişmez kuralını ihlal etmez, yalnız granülerliği
    // per-key'den per-görüntülemeye taşır.
    // A1: reveal audit YALNIZ düz-metin GERÇEKTEN gösterildiğinde (owner) yazılır — owner-olmayan
    // 'admin' maskeli gördüğünden bir "reveal" değildir (yanıltıcı audit üretmez).
    if (reveal && asgRows.length > 0) {
      // best-effort: audit yazımı bu OKUMA yolunu (GET) bozmamalı — yazım hatasında (DB baskısı/
      // bağlantı kesintisi) detay yine de yüklenir, 500 atmaz (denetim robustluk bulgusu).
      try {
        await this.db.insert(auditLog).values({
          action: 'reveal',
          actor,
          targetType: 'order',
          targetId: orderId,
          meta: { auto: true, view: 'order_detail', count: asgRows.length },
        });
      } catch {
        /* audit yazımı başarısız → görüntüleme yine de döner */
      }
    }

    return {
      // heldForReview zaten satırda; siteDomain + siteType başlıkta "hangi mağaza / hangi kanal".
      // storeAdminUrl: mağaza adminindeki siparişe SALT LİNK (panel mağazaya bağlanmaz, §17).
      order: {
        ...order,
        siteDomain: siteRow?.domain ?? null,
        siteType: siteRow?.type ?? null,
        storeAdminUrl: buildStoreAdminUrl(siteRow, order.remoteOrderId),
      },
      lines: lineRows.map((l) => {
        const bonus = isBonusRemoteLineId(l.remoteLineId);
        const availableStock = l.productId ? Number(l.availableStock ?? 0) : null;
        return {
          id: l.id,
          remoteLineId: l.remoteLineId,
          qty: l.qty,
          fulfilledQty: l.fulfilledQty,
          status: l.status,
          productId: l.productId,
          canceled: l.canceled,
          productName: l.productName,
          productSku: l.productSku ?? null,
          productKind: l.productKind ?? null,
          // MAĞAZADAKİ ürün bilgisi (kullanıcı isteği): sipariş push'unda gelen ham kimlik + AD.
          // Eski satırlarda/eski eklentide null olabilir (geriye dönük uyumlu).
          remoteProductId: l.remoteProductId ?? null,
          remoteVariationId: l.remoteVariationId ?? null,
          remoteName: l.remoteName ?? null,
          // Bonus (sentetik) satır → mağazada karşılığı YOK; origin kalem altında gösterilir.
          isBonus: bonus,
          originRemoteLineId: resolveOriginRemoteLineId(l.remoteLineId),
          availableStock,
          pendingReason: this.diagnosePendingReason({
            canceled: l.canceled,
            held: order.heldForReview,
            productId: l.productId,
            status: l.status,
            qty: l.qty,
            canceledUnits: l.canceledUnits,
            fulfilledQty: l.fulfilledQty,
            policy: l.policyOverride ?? l.productPolicy ?? null,
            stockless: l.productStockless ?? false,
            releaseAt: l.productReleaseAt ?? null,
            availableStock,
          }),
        };
      }),
      emails,
      replacements: replacementRows,
      history: historyRows.map((h) => {
        const oldPlain =
          h.oldPayloadEnc && h.oldLicenseItemId
            ? this.crypto.decrypt(h.oldPayloadEnc, CryptoService.licenseItemAad(h.oldLicenseItemId))
            : null;
        const newPlain =
          h.newPayloadEnc && h.newLicenseItemId
            ? this.crypto.decrypt(h.newPayloadEnc, CryptoService.licenseItemAad(h.newLicenseItemId))
            : null;
        const remoteLineId = h.remoteLineId ?? '';
        return {
          id: h.id,
          // Değişimle OLUŞAN (taze) atama — soyağacının "yeni" ucu.
          assignmentId: h.assignmentId,
          newAssignmentId: h.assignmentId,
          // Değişimle geri alınan (eski) atama — "Geçmiş" listesindeki satırla eşleştirmek için.
          oldAssignmentId: h.oldLicenseItemId
            ? (terminalAsgByLicenseItem.get(h.oldLicenseItemId) ?? null)
            : null,
          reason: h.reason,
          // KİM YAPTI (§8): 'wp:kullanici@site' / 'panel:<admin>' formatında olduğu gibi geçer.
          actor: h.actor,
          createdAt: h.createdAt,
          lineId: h.lineId,
          remoteLineId: remoteLineId || null,
          originRemoteLineId: remoteLineId ? resolveOriginRemoteLineId(remoteLineId) : null,
          // Bonus atamanın değişimi de soyağacına DÜŞER; UI "Bonus" rozetiyle ayırt edebilsin.
          isBonus: remoteLineId ? isBonusRemoteLineId(remoteLineId) : false,
          productName: h.productName ?? null,
          remoteName: h.remoteName ?? null,
          oldLicenseItemId: h.oldLicenseItemId ?? null,
          newLicenseItemId: h.newLicenseItemId ?? null,
          oldMasked: oldPlain !== null ? mask(oldPlain) : '—',
          // key-tipi ölü anahtar TAM gösterilir (operatör hangi key'in değiştiğini net görür) —
          // ANCAK yalnız owner'a (A1); owner-olmayan 'admin' maskeli oldMasked'e düşer.
          oldValue: reveal && oldPlain !== null && h.productKind === 'key' ? oldPlain : null,
          newMasked: newPlain !== null ? mask(newPlain) : '—',
          newValue: reveal && newPlain !== null && h.productKind === 'key' ? newPlain : null,
        };
      }),
      assignments: asgRows.map((a) => {
        const plain = this.crypto.decrypt(
          a.payloadEnc,
          CryptoService.licenseItemAad(a.licenseItemId),
        );
        // Kimlik-doğrulamalı admin paneli: lisans/hesap DÜZ gösterilir (maskeleme yok, kullanıcı
        // isteği — görüntüleme yukarıda audit'e düştü). Hesap ürününde alan-alan düz değerler
        // (kullanıcı adı + parola açık); diğer tiplerde tek düz payload.
        const schema =
          a.productKind === 'account' ? AccountPayloadSchema.safeParse(a.payloadSchema) : null;
        const fields = schema?.success ? parseAccountPayload(schema.data, plain) : null;
        const terminal = a.status !== 'active' && a.status !== 'suspended';
        const lineage = terminal ? replacedByLicenseItem.get(a.licenseItemId) : undefined;
        return {
          id: a.id,
          lineId: a.lineId,
          status: a.status,
          units: a.units,
          validUntil: a.validUntil,
          deliveredAt: a.deliveredAt,
          licenseItemId: a.licenseItemId,
          kind: a.productKind,
          productName: a.productName,
          // Mağaza kalemi + bonus bağlamı (bonus atama, mağazada karşılığı olmayan sentetik satırda).
          remoteLineId: a.remoteLineId,
          originRemoteLineId: resolveOriginRemoteLineId(a.remoteLineId),
          isBonus: isBonusRemoteLineId(a.remoteLineId),
          remoteName: a.remoteName ?? null,
          // §8/A1: düz-metin sır YALNIZ owner'a (reveal=true). owner-olmayan 'admin' maskeli görür
          // (key/code son-4; account alanları kuyruksuz maske) — müşteri/getDeliveries ile aynı disiplin.
          payload: reveal ? plain : maskSecret(plain),
          fields: reveal ? fields : fields ? maskAccountFields(fields) : null,
          // Terminal atamada iptal sebebi (aktifte null) — "Geçmiş" satırında gösterilir.
          revokeReason: revokeReasonByAsg.get(a.id) ?? null,
          // DEĞİŞİMLE geri alındıysa "iptal" DEĞİL "değiştirildi" (türetilmiş; durum makinesi
          // değişmedi — revoke akışı ve tüm invaryantlar aynen korunur).
          replaced: !!lineage,
          replacedByAssignmentId: lineage?.newAssignmentId ?? null,
          replaceReason: lineage?.reason ?? null,
          replacedAt: lineage?.at ?? null,
          // multi (MAK) kalan kapasite görünürlüğü.
          maxUses: a.itemMaxUses,
          useCount: a.itemUseCount,
        };
      }),
      events,
      // "Kim yaptı" denetim izi (§8): sipariş + atamalarına ait audit_log kayıtları.
      auditTrail: auditRows.map((r) => {
        const meta = (r.meta ?? null) as { reason?: unknown; op?: unknown } | null;
        return {
          id: r.id,
          action: r.action,
          actor: r.actor,
          targetType: r.targetType,
          targetId: r.targetId,
          op: typeof meta?.op === 'string' ? meta.op : null,
          reason: typeof meta?.reason === 'string' ? meta.reason : null,
          createdAt: r.createdAt,
        };
      }),
    };
  }

  /**
   * Satırın NEDEN beklediği (§13). Saf fonksiyon — sorgu YAPMAZ; tüm girdiler detail()'in tek
   * satır sorgusundan gelir (N+1 yok). Öncelik sırası bilinçli: terminal/blokaj durumları önce
   * (iptal → inceleme → eşlemesiz), sonra teslim edilebilirlik engelleri (ön sipariş → stok →
   * all-or-nothing). Satır zaten tamamlandıysa null (bekleyen bir şey yok).
   */
  private diagnosePendingReason(l: {
    canceled: boolean;
    held: boolean;
    productId: string | null;
    status: string;
    qty: number;
    canceledUnits?: number | null;
    fulfilledQty: number;
    policy: string | null;
    stockless: boolean;
    releaseAt: Date | null;
    availableStock: number | null;
  }): PendingReason {
    if (l.canceled) return 'canceled';
    if (l.status === 'fulfilled') return null;
    if (l.held) return 'held';
    if (!l.productId) return 'unmapped';
    if (l.stockless && l.releaseAt && new Date(l.releaseAt).getTime() > Date.now()) {
      return 'release_gated';
    }
    // Hedef = qty − canceled_units (fill-target.ts): panelden kalıcı iptal edilen birim
    // "bekleyen iş" DEĞİLDİR — aksi halde tanı "stok yok" der ama teslimat hiç denenmez.
    const remaining = remainingUnits(l);
    if (remaining <= 0) return null;
    const available = l.availableStock ?? 0;
    if (available <= 0) return 'no_stock';
    if (l.policy === 'all-or-nothing' && available < remaining) return 'all_or_nothing';
    return null;
  }

  /**
   * İade/iptal → atama revoke, key karantinaya (§2: iade edilen key otomatik
   * satışa dönmez). audit_log'a düşer. Müşteri deliveries'te artık görünmez.
   *
   * `exec` (F1): varsayılan `this.db` — kendi transaction'ını açar (mevcut çağıranların
   * davranışı DEĞİŞMEZ). Zaten bir transaction içinden çağrılırsa (syncRefunds) o tx geçilir;
   * drizzle iç içe transaction'ı SAVEPOINT'e çevirir → aynı bağlantıda, aynı kilitlerle koşar.
   * Bu ŞART: dış tx satır kilidini tutarken ayrı bağlantıda revoke denemek, kendi kilidimizi
   * beklediğimiz (PG'nin göremediği) bir kilitlenme üretirdi.
   */
  async revokeAssignment(
    assignmentId: string,
    reason: string,
    actor: string,
    markLineCanceled = true,
    exec: Database = this.db,
    // §2 (denetim C2): MAK/çok-kullanımlı kapasitenin geri alımda havuza dönüp dönmeyeceği.
    // GERÇEK İADE yollarında (revokeOrderForSite tam iade, syncRefunds kısmi iade) `false` geçilir →
    // 'iadede hak otomatik dönmez' (aktivasyon Microsoft'ta harcandı; sessiz aşırı-satış önlenir).
    // MEŞRU yeniden-atama yolları (değişim/adet-düşür/recall, varsayılan `true`) kapasiteyi geri verir.
    // Tek-kullanımlık üründe etkisiz (o zaten karantinaya gider).
    returnMultiCapacity = true,
  ) {
    return exec.transaction(async (tx) => {
      const [asg] = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.id, assignmentId))
        .limit(1)
        .for('update');
      if (!asg) throw new NotFoundException('Atama bulunamadı');
      if (asg.status === 'revoked') return { assignmentId, status: 'revoked', already: true };

      await tx
        .update(assignments)
        .set({ status: 'revoked' })
        .where(eq(assignments.id, assignmentId));

      // Lisans geri alımı: tek kullanımlık → karantina (iade edilen key satışa dönmez);
      // çok kullanımlık (MAK) → kapasite geri ver (use_count -= units), tüm key'i imha etme.
      const [li] = await tx
        .select()
        .from(licenseItems)
        .where(eq(licenseItems.id, asg.licenseItemId))
        .limit(1);
      if (li) {
        if (li.maxUses > 1) {
          // §2 (C2): yalnız MEŞRU yeniden-atamada kapasite havuza döner. İADE'de (returnMultiCapacity
          // =false) use_count'a DOKUNULMAZ → harcanan aktivasyon geri gelmez (süre-bitişi deseniyle simetrik).
          if (returnMultiCapacity) {
            await tx.execute(sql`
              UPDATE license_items SET
                use_count = GREATEST(0, use_count - ${asg.units}),
                status = CASE WHEN status = 'depleted' THEN 'available' ELSE status END
              WHERE id = ${asg.licenseItemId};
            `);
          }
        } else {
          await tx
            .update(licenseItems)
            .set({ status: 'quarantined' })
            .where(eq(licenseItems.id, asg.licenseItemId));
        }
      }

      // Satır sayacını düş + satır/sipariş durumunu yeniden hesapla (tutarlılık).
      const [line] = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.id, asg.lineId))
        .limit(1)
        .for('update');
      if (line) {
        const nf = Math.max(0, line.fulfilledQty - asg.units);
        // markLineCanceled (varsayılan true): GERÇEK iade/iptal (refund / admin-revoke) → geri
        // alınan birimler partial-auto yeniden-atama havuzundan KALICI çıkarılır (iade edilen
        // müşteriye taze key ile bedava lisans gitmez, §2). AMA değişim / recall-bulkReplace /
        // sipariş-adedi-düşür gibi "revoke sonrası MEŞRU yeniden-atama" akışları false geçer →
        // satır completeLine ile yeniden atanabilir kalır (aksi halde "stok yok" hatası).
        //
        // ÖLÇEK AYRIMI (denetim + re-doğrulama): `canceled` SATIR ölçeğinde terminal bir bayrak,
        // per-atama iptal ise ATAMA ölçeğinde bir eylem. Bayrak koşulsuz set edilince çok-adetli
        // satırda tek anahtarı iptal etmek satırın TAMAMINI terminal yapıyor ve getDeliveries
        // iptal satırını elediği için müşteri elinde HÂLÂ GEÇERLİ kardeş anahtarlar dururken
        // 0 lisans görüyordu. Ara çözüm olarak `qty` düşürmek ise İKİ YÖNLÜ bozuktu: (a) mağaza
        // re-push'u `qty`'yi geri yükseltip iptal edilen birime TAZE anahtar teslim ediyordu
        // (H1 bedava lisans), (b) iptal sebebi "kusurlu anahtar" ise müşterinin ÖDEDİĞİ hak
        // sessizce kısılıyordu. Doğru ayrım: `qty` MAĞAZA GERÇEĞİ olarak DOKUNULMADAN kalır,
        // iptaller `canceled_units` defterinde birikir; doldurma hedefi `fillTarget` ile
        // `qty - canceled_units`. Böylece re-push hedefi geri açamaz (mağazada karşılığı yok).
        //   - kardeş yok → satır tamamen bitti → canceled=true (terminal, eski davranış)
        //   - kardeş var → canceled_units += units (satır canlı kalır, kardeşler görünür)
        //
        // Satır ZATEN terminalse (revokeOrderForSite önce tüm satırları canceled yapar, sonra
        // atamaları tek tek geri alır) deftere DOKUNMA: aksi halde tam iadede son atama hariç
        // her çağrı "kardeş var" görüp sayacı şişirir ve gereksiz olay yazardı.
        const liveSiblings =
          markLineCanceled && !line.canceled
            ? (
                await tx
                  .select({ id: assignments.id })
                  .from(assignments)
                  .where(
                    and(
                      eq(assignments.lineId, line.id),
                      inArray(assignments.status, ['active', 'suspended']),
                    ),
                  )
                  .limit(1)
              ).length > 0
            : false;
        const addCanceled = liveSiblings ? asg.units : 0;
        const newCanceledUnits = Math.min(line.qty, (line.canceledUnits ?? 0) + addCanceled);
        const lineStatus = lineStatusFor({
          qty: line.qty,
          canceledUnits: newCanceledUnits,
          fulfilledQty: nf,
        });
        await tx
          .update(orderLines)
          .set({
            fulfilledQty: nf,
            status: lineStatus,
            ...(addCanceled > 0 ? { canceledUnits: newCanceledUnits } : {}),
            ...(markLineCanceled && !liveSiblings && !line.canceled ? { canceled: true } : {}),
          })
          .where(eq(orderLines.id, line.id));
        if (addCanceled > 0) {
          // İptal GÖRÜNÜR olmalı: mağaza tarafında karşılığı olmayan bir panel işlemi.
          await tx.insert(fulfillmentEvents).values({
            orderId: asg.orderId,
            type: 'order_edited',
            message:
              `${asg.units} birim kalıcı olarak iptal edildi (satır adedi ${line.qty}, ` +
              `iptal edilen toplam ${newCanceledUnits}). Bu birimler yeni anahtarla ` +
              `DOLDURULMAZ; mağazada da iade/iptal işlenmezse sipariş adedi mağaza tarafında ` +
              `değişmeden kalır.`,
          });
        }
      }
      await recomputeOrderStatus(tx, asg.orderId);

      await tx.insert(auditLog).values({
        action: 'revoke',
        actor,
        targetType: 'assignment',
        targetId: assignmentId,
        meta: { reason, licenseItemId: asg.licenseItemId, units: asg.units },
      });
      await tx.insert(fulfillmentEvents).values({
        orderId: asg.orderId,
        type: 'revoked',
        message: `Atama iptal edildi: ${reason}`,
      });

      return { assignmentId, status: 'revoked', licenseItemId: asg.licenseItemId };
    });
  }

  /**
   * #19 BİRİM-GRANÜLER kısmi revoke: bir atamanın YALNIZ `units` birimini geri alır (atamayı
   * imha etmeden). Çok-kullanımlıkta (MAK) tek key birden çok birim taşıyabildiğinden re-push
   * adet-düşür fazlalığı atamanın TAMAMINI değil yalnız fazlayı geri almalı — aksi halde over-revoke
   * (müşteri hakkını fazladan kaybeder). Kapasite tam `take` kadar döner (use_count -= take); satır
   * fulfilledQty `take` düşer. Satır 'canceled' İŞARETLENMEZ (adet düşür = iade DEĞİL → yeniden
   * atanabilir kalır). `units >= atama.units` ise tam revoke'a düşer (tek-kullanım hep bu yola gelir).
   *
   * `exec` (F1): revokeAssignment ile aynı sözleşme — dış transaction verilirse SAVEPOINT olarak koşar.
   */
  async revokePartialUnits(
    assignmentId: string,
    units: number,
    reason: string,
    actor: string,
    exec: Database = this.db,
    // §2 (denetim C2): İADE'de MAK kapasitesi havuza DÖNMEZ (false). Adet-düşür/re-assign'de döner (true).
    returnMultiCapacity = true,
  ) {
    // `partial` BU DALDA DA döner: aksi hâlde dönüş tipi iki farklı şekilli bir union olur ve
    // çağıran `res.partial` diyemez (test dosyaları tam bu yüzden tip sapması taşıyordu).
    // Davranış değişmez — units<=0 zaten "hiçbir şey yapılmadı" demektir.
    if (units <= 0) return { assignmentId, revoked: 0, partial: false };
    return exec.transaction(async (tx) => {
      const [asg] = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.id, assignmentId))
        .limit(1)
        .for('update');
      if (!asg) throw new NotFoundException('Atama bulunamadı');
      // (Denetim H1 sınıfı) active VE suspended geri alınabilir: askıdaki atama da CANLI hak taşır
      // (iadede kısmi geri alım suspended'ı da kapsamalı). terminal (revoked/expired/replaced) no-op.
      if (asg.status !== 'active' && asg.status !== 'suspended') {
        return { assignmentId, revoked: 0 };
      }

      const take = Math.min(units, asg.units);
      const full = take >= asg.units;

      if (full) {
        await tx.update(assignments).set({ status: 'revoked' }).where(eq(assignments.id, assignmentId));
      } else {
        // Kısmi: yalnız units'i azalt — atama aktif kalır, kalan birim müşteride.
        await tx
          .update(assignments)
          .set({ units: asg.units - take })
          .where(eq(assignments.id, assignmentId));
      }

      // Kapasite iadesi: multi → use_count -= take (+ depleted ise available). Tek-kullanım
      // (maxUses=1) yalnız full yolla gelir (take=asg.units=1) → karantina (satışa dönmez, §2).
      const [li] = await tx
        .select()
        .from(licenseItems)
        .where(eq(licenseItems.id, asg.licenseItemId))
        .limit(1);
      if (li) {
        if (li.maxUses > 1) {
          // §2 (C2): İADE'de (returnMultiCapacity=false) MAK kapasitesi havuza dönmez; assignment.units
          // yine düşürülür (müşteri o birimleri iade etti) ama harcanan aktivasyon geri gelmez.
          if (returnMultiCapacity) {
            await tx.execute(sql`
              UPDATE license_items SET
                use_count = GREATEST(0, use_count - ${take}),
                status = CASE WHEN status = 'depleted' THEN 'available' ELSE status END
              WHERE id = ${asg.licenseItemId};
            `);
          }
        } else if (full) {
          await tx
            .update(licenseItems)
            .set({ status: 'quarantined' })
            .where(eq(licenseItems.id, asg.licenseItemId));
        }
      }

      // Satır sayacı: fulfilledQty -= take, durum yeniden. canceled İŞARETLENMEZ (adet düşür).
      const [line] = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.id, asg.lineId))
        .limit(1)
        .for('update');
      if (line) {
        const nf = Math.max(0, line.fulfilledQty - take);
        const lineStatus = nf >= line.qty ? 'fulfilled' : nf > 0 ? 'partial' : 'pending';
        await tx
          .update(orderLines)
          .set({ fulfilledQty: nf, status: lineStatus })
          .where(eq(orderLines.id, line.id));
      }
      await recomputeOrderStatus(tx, asg.orderId);

      await tx.insert(auditLog).values({
        action: 'revoke',
        actor,
        targetType: 'assignment',
        targetId: assignmentId,
        meta: { reason, licenseItemId: asg.licenseItemId, units: take, partial: !full },
      });
      await tx.insert(fulfillmentEvents).values({
        orderId: asg.orderId,
        type: 'revoked',
        message: `${take} birim geri alındı (${reason})`,
      });

      return { assignmentId, revoked: take, partial: !full };
    });
  }

  /**
   * Site-facing sipariş revoke sarmalayıcısı (§2): WooCommerce'te sipariş iade/iptal
   * edilince WP eklentisi tetikler → panelde CANLI key kalmaz. Siparişin bu siteye ait
   * olduğunu DOĞRULAR (başka sitenin siparişi geri alınamaz), aktif atamalarını MEVCUT
   * idempotent revoke akışıyla (revokeAssignment) geri alır. Payload/key DÖNMEZ.
   *
   * İdempotent: revokeAssignment zaten revoked ise no-op; ikinci çağrıda aktif atama
   * kalmadığından tüm istek no-op olur (revoked=0). İade edilen key otomatik satışa
   * DÖNMEZ (tek-kullanım → karantina; multi/MAK → kapasite geri, §2).
   */
  async revokeOrderForSite(
    site: Site,
    remoteOrderId: string,
    reason: string,
  ): Promise<{ orderId: string; revoked: number; assignments: number }> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.siteId, site.id), eq(orders.remoteOrderId, remoteOrderId)))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const actor = `site:${site.domain}`;

    // #7 denetim (H1 tekrarı, YÜKSEK): held (İnceleme Kuyruğu) sipariş iade/iptal edilince
    // kuyruktan ÇIKARILMALI — aksi halde admin sonradan 'Onayla' derse iade edilmiş siparişe
    // BEDAVA lisans teslim edilir (§2 "iade edilen hak dönmez" ilkesinin tersi). rejectHeld
    // idempotenttir + advisory-lock altında CAS yapar → held ise kapatır (satırlar canceled,
    // status revoked), release ile yarışı kaybettiyse no-op. rejectHeld'i AŞAĞIDAKİ advisory-tx'in
    // DIŞINDA çağırırız: rejectHeld aynı advisory kilidini AYRI bir tx/bağlantıda alır; iç içe alım
    // aynı-anahtar deadlock'u yaratır (dış tx kilidi tutar, iç tx onu bekler → kilitlenme).
    if (order.heldForReview) {
      await this.rejectHeld(order.id, reason, actor);
    }

    // F3 (§2 iade ↔ releaseHeld yarışı): releaseHeld held bayrağını (advisory-lock'lu) tx'te temizler
    // ama teslimatı (completeLine) kilit DIŞINDA yapar. İade tam bu pencerede gelirse held=false görüp
    // hiç aktif atama bulamaz (henüz yazılmadı) → NO-OP → ardından completeLine iade edilmiş siparişe
    // CANLI atama yazar. Kapatma: advisory-lock + order FOR UPDATE altında held'i YENİDEN oku ve TÜM
    // satırları terminal 'canceled' işaretle ("durable refund marker" + status→revoked). Bu işaret
    //   (a) eşzamanlı completeLine'ı DURDURUR: o da satırı FOR UPDATE ile okur → canceled → NOOP;
    //   (b) commit-SONRASI aktif-atama taraması, completeLine bu satırı iade'den ÖNCE yazmışsa (satır
    //       row-lock'u iki yolu serileştirir: ya cancel-önce=noop, ya insert-önce=görülür) onu YAKALAR.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${order.id}))`);
      // 2. denetim (ABBA deadlock düzeltmesi): satır kilitlerini SİPARİŞ satırından ÖNCE al.
      // completeLine (satır FOR UPDATE → recompute'ta orders UPDATE) ve revokeAssignment de
      // satır→sipariş sırasıyla kilitler; bu tx eskiden orders'ı FOR UPDATE ile ÖNCE kilitliyordu
      // → ters sıra, eşzamanlı completeLine (stok import süpürmesi) ile ABBA deadlock (40P01 → 500).
      // advisory-lock zaten eşzamanlı refund/release'i serileştirir; held kararı için orders'ı ayrıca
      // FOR UPDATE kilitlemeye gerek yok (completeLine heldForReview'i değiştirmez). Böylece kilit
      // edinim sırası tüm yollarla aynı olur: satır → sipariş.
      await tx
        .select({ id: orderLines.id })
        .from(orderLines)
        .where(eq(orderLines.orderId, order.id))
        .for('update');
      const [fresh] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, order.id))
        .limit(1);
      if (!fresh) return;
      // Savunma: rejectHeld yarışı kaybettiyse (held hâlâ true) bayrağı burada da kapat.
      if (fresh.heldForReview) {
        await tx
          .update(orders)
          .set({ heldForReview: false, updatedAt: new Date() })
          .where(eq(orders.id, order.id));
      }
      await tx.update(orderLines).set({ canceled: true }).where(eq(orderLines.orderId, order.id));
      await recomputeOrderStatus(tx, order.id);
    });

    // AKTİF + ASKIDAKİ atamalar geri alınır (revoked/expired/replaced zaten teslim edilmiyor).
    // (Denetim H1 sınıfı) 'suspended' de CANLI bir hak: askıdaki atama sonradan "Geri aç" ile
    // aktifleşebilir → tam iade edilen müşteriye çalışan lisans kalırdı. Bu yüzden iadede
    // suspended da geri alınır. Tarama advisory-tx COMMIT'inden SONRA → completeLine'ın (row-lock
    // nedeniyle iade'den önce commit'lediği) atamaları da bu kümede görünür. revokeAssignment
    // tek→karantina, multi→kapasite geri değil (returnMultiCapacity=false, §2), idempotent 'already'.
    const active = await this.db
      .select({ id: assignments.id })
      .from(assignments)
      .where(
        and(
          eq(assignments.orderId, order.id),
          inArray(assignments.status, ['active', 'suspended']),
        ),
      );

    let revoked = 0;
    for (const a of active) {
      // Tam İADE (§2, C2): markLineCanceled=true (terminal) + returnMultiCapacity=false (MAK hakkı dönmez).
      const res = await this.revokeAssignment(a.id, reason, actor, true, this.db, false);
      // already=true → yarışta başka yol revoke etmiş; revoked sayacına katma.
      if (!('already' in res)) revoked++;
    }

    return { orderId: order.id, revoked, assignments: active.length };
  }

  /**
   * Site-facing KISMİ iade uzlaştırması (§2/§7 "kısmi iade → yalnız ilgili satır revoke").
   * WooCommerce'te siparişin BAZI birimleri iade edilince (woocommerce_order_refunded) WP
   * eklentisi satır-bazlı NET adedi (sipariş qty − iade edilen qty) gönderir. Panel her satırın
   * qty'sini NET'e düşürür → autoComplete artık iade edilen birimi DOLDURMAZ (bedava-lisans
   * H1-sınıfı kapanır) ve teslim edilmiş fazlalık birimleri geri alır (revokeExcess deseni;
   * markLineCanceled=false — re-fill'i qty düşüşü engeller, satır ileride tekrar artarsa meşru
   * doldurulabilir). TAM iade (sipariş 'refunded' → tüm satırlar net=0) revokeOrderForSite ile
   * gider (terminal canceled). İdempotent: aynı net adetler tekrar gelirse fark yok → no-op.
   */
  /**
   * (§3) Bir sipariş satırının PANEL birimi başına Woo adedi (bundleQty). reconcileOrder ile AYNI
   * çözüm: varyasyon-özel eşleme öncelikli, yoksa ürün-seviyesi. Eşleme yoksa 1 (birim=adet).
   * order_lines remoteProductId'yi SAKLAMAZ → WP refund satırındaki remoteProductId ile çözülür.
   */
  private async resolveBundleQty(
    siteId: string,
    remoteProductId?: string,
    remoteVariationId?: string,
    // F1: çağıran bir transaction içindeyse okuma da AYNI bağlantıdan yapılır (ayrı bağlantı
    // dış tx'in kilitlediği satırları bekleyebilir + farklı anlık görüntü okur).
    exec: Database = this.db,
    // Denetim C5: eşleme YOKSA `null` döner (tip yalanı düzeltildi — çağıran resolveLineScale
    // null'ı 'ölçek bilinmiyor → qty'ye dokunma' olarak ele alır; Promise<number> yanıltıcıydı).
  ): Promise<number | null> {
    if (!remoteProductId) return 1;
    const variation =
      remoteVariationId && remoteVariationId !== '0' ? remoteVariationId : null;
    if (variation) {
      const [row] = await exec
        .select({ bundleQty: siteProductMappings.bundleQty })
        .from(siteProductMappings)
        .where(
          and(
            eq(siteProductMappings.siteId, siteId),
            eq(siteProductMappings.remoteProductId, remoteProductId),
            eq(siteProductMappings.remoteVariationId, variation),
            eq(siteProductMappings.active, true),
          ),
        )
        .orderBy(asc(siteProductMappings.createdAt))
        .limit(1);
      if (row) return row.bundleQty;
    }
    const [row] = await exec
      .select({ bundleQty: siteProductMappings.bundleQty })
      .from(siteProductMappings)
      .where(
        and(
          eq(siteProductMappings.siteId, siteId),
          eq(siteProductMappings.remoteProductId, remoteProductId),
          isNull(siteProductMappings.remoteVariationId),
          eq(siteProductMappings.active, true),
        ),
      )
      .orderBy(asc(siteProductMappings.createdAt))
      .limit(1);
    return row?.bundleQty ?? null;
  }

  /**
   * Satırın MAĞAZA adedi → PANEL birimi ölçeği. `OrdersService.resolveLineScale` ile AYNI
   * sözleşme (iki servis de aynı invaryantı korumalı — tek yerde bozulursa iade yolları
   * ayrışır):
   *   eşlemesiz satır → 1 · satır anlık görüntüsü (0025) → o · canlı eşleme → o · yoksa null.
   * `null` = ölçek bilinmiyor ⇒ çağıran qty'ye DOKUNMAZ (canlı anahtar geri alınmaz).
   */
  private async resolveLineScale(
    siteId: string,
    line: { productId: string | null; bundleQty: number | null },
    remote: { remoteProductId?: string; remoteVariationId?: string },
    exec: Database = this.db,
  ): Promise<number | null> {
    if (!line.productId) return 1;
    if (line.bundleQty != null && line.bundleQty > 0) return line.bundleQty;
    // Eski eklenti remoteProductId göndermiyorsa eşleme aranamaz → 1 (geriye dönük uyumlu:
    // 0025 öncesi davranış zaten buydu ve bundleQty=1 kurulumlarda doğrudur).
    if (!remote.remoteProductId) return 1;
    return this.resolveBundleQty(siteId, remote.remoteProductId, remote.remoteVariationId, exec);
  }

  async syncRefunds(
    site: Site,
    remoteOrderId: string,
    lines: {
      remoteLineId: string;
      netQty: number;
      remoteProductId?: string;
      remoteVariationId?: string;
    }[],
    reason: string,
  ): Promise<{ orderId: string; revoked: number; adjustedLines: number }> {
    const [order] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.siteId, site.id), eq(orders.remoteOrderId, remoteOrderId)))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const actor = `site:${site.domain}`;

    /*
     * F1 (denetim, YÜKSEK — para kaybı): bu gövde eskiden KİLİTSİZ ve TRANSACTION'SIZ bir
     * read-modify-write'tı — satırı okur (qty/fulfilledQty), `excess` hesaplar, sonra ayrı
     * ifadelerle revoke ederdi. WP tarafında aynı iade İKİ KEZ POST edilebiliyor (satır-içi
     * `woocommerce_order_refunded` + Action Scheduler işi); iki istek de BAYAT fulfilledQty
     * okuyup aynı `excess`i ikişer kez geri alıyordu → müşterinin İADE ETMEDİĞİ CANLI
     * anahtarları ölüyor, ardından partial-auto satırı taze stokla dolduruyordu (hem müşteri
     * mağduriyeti hem bedava lisans yanması).
     *
     * Artık tüm gövde TEK transaction'da ve sipariş advisory kilidinin ALTINDA koşar:
     *   · İkinci eşzamanlı istek kilitte bekler, sırası gelince TAZE qty/fulfilledQty okur →
     *     `netQty >= line.qty` görüp no-op eder (idempotent davranış korunur).
     *   · Ortada hata olursa kısmi durum kalmaz (revoke edildi ama qty düşmedi → rollback).
     * Davranış AYNEN korundu (netQty >= qty → dokunma; excess>0 → o kadar birim geri al);
     * eklenen tek şey atomiklik.
     */
    return this.db.transaction(async (tx) => {
      /*
       * KİLİT ANAHTARI: `hashtext(order.id)` — projedeki TÜM sipariş-kapsamlı yazarlarla AYNI
       * ad alanı (revokeOrderForSite / releaseHeld / rejectHeld / pending-lines.linkLine).
       * Ayrı bir 'refund:<id>' ad alanı seçilseydi tam-iade ile kısmi-iade birbirini
       * dışlamaz, ikisi de order_lines satırlarını FARKLI sırayla kilitleyip ABBA deadlock
       * (40P01 → 500) üretebilirdi. Aynı anahtar hem yarışı kapatır hem kilit sırasını
       * tekleştirir. (İç içe advisory alan bir yardımcı ÇAĞIRMIYORUZ → kendi kilidimizi
       * bekleme riski yok; revokeOrderForSite'ın rejectHeld'i tx dışında çağırma nedeni budur.)
       */
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${order.id}))`);

      /*
       * KİLİT SIRASI (proje sözleşmesi): advisory → assignments → order_lines → orders.
       * revokeAssignment/revokePartialUnits de bu sırayla kilitler. Siparişin TÜM atama ve
       * satır kilitleri döngüden ÖNCE alınır: aksi halde 1. satırın revoke'u `orders` satırını
       * güncelledikten (kilitledikten) sonra 2. satır için YENİ bir order_lines kilidi istenir
       * → aynı anda satır kilidi tutup orders isteyen completeLine ile ABBA deadlock olurdu.
       * Küme sipariş başına küçüktür (satır/atama sayısı), maliyeti ihmal edilebilir.
       */
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

      let totalRevoked = 0;
      let adjusted = 0;

      for (const l of lines) {
        // netQty WP'den MAĞAZA birimi gelir; panel line.qty/fulfilledQty PANEL birimidir
        // (= mağaza adedi × ölçek). Ölçeklemeden karşılaştırmak bundleQty>1'de iade edilmeyen
        // satırlardan bile aşırı revoke ederdi.
        const orderNetQty = Math.max(0, Math.floor(l.netQty));
        // Kilit zaten yukarıda alındı; bu okuma TAZE (aynı tx içindeki kendi yazmalarımız da
        // görünür → aynı remoteLineId iki kez gelirse ikinci tur no-op'a düşer).
        const [line] = await tx
          .select()
          .from(orderLines)
          .where(and(eq(orderLines.orderId, order.id), eq(orderLines.remoteLineId, l.remoteLineId)))
          .limit(1);
        if (!line || line.canceled) continue;

        // ÖLÇEK satırdan çözülür — eşlemeden DEĞİL (denetim bulgusu):
        //  · Eşlemesiz satırda (`productId` NULL) qty MAĞAZA birimindedir → ölçek 1. Eskiden
        //    burada koşulsuz bundleQty ile çarpılıyordu; satır sonradan "Eşlemeyi uygula" ile
        //    bağlanınca linkLine aynı qty'yi BİR KEZ DAHA çarpıyor ve müşteriye hakkından fazla
        //    (bedava) lisans teslim ediliyordu.
        //  · Eşleme kaldırılmış + anlık görüntü yoksa ölçek BİLİNMEZ → satır ATLANIR (qty'ye
        //    dokunmak canlı anahtarları iade YOKKEN geri alırdı).
        const scale = await this.resolveLineScale(site.id, line, l, tx);
        if (scale == null) {
          this.logger.warn(
            `İade uzlaştırma: satır ölçeği çözülemedi (eşleme kaldırılmış, anlık görüntü yok) — ` +
              `atlanıyor: line=${line.id} order=${order.id} remoteProduct=${l.remoteProductId ?? '-'}`,
          );
          continue;
        }
        const netQty = orderNetQty * scale;
        if (netQty >= line.qty) continue; // Bu satırda iade yok (refund yolu qty ARTIRMAZ).

        // 1) Fazla teslim edilmiş birimleri geri al (fulfilled > netQty) — revokeExcess deseni:
        // en yeni atamadan başlayarak `excess` birim karşılanana dek; tek→karantina, multi→kapasite.
        const excess = line.fulfilledQty - netQty;
        if (excess > 0) {
          // (Denetim H1 sınıfı) active + suspended: askıdaki atama da fulfilledQty'ye dahildir ve
          // CANLI hak taşır → kısmi iadede geri alınabilir kümeye girer. Aksi halde fazlalık yalnız
          // suspended'dayken döngü aktifi geri alamaz, suspended sağ kalır (sonradan geri açılırsa
          // iade edilen birim çalışır).
          const active = await tx
            .select({ id: assignments.id, units: assignments.units })
            .from(assignments)
            .where(
              and(
                eq(assignments.lineId, line.id),
                inArray(assignments.status, ['active', 'suspended']),
              ),
            )
            .orderBy(desc(assignments.createdAt));
          let revoked = 0;
          for (const a of active) {
            if (revoked >= excess) break;
            const need = excess - revoked;
            // tx GEÇİLİR: yardımcılar aynı bağlantıda SAVEPOINT olarak koşar (ayrı bağlantı
            // bizim tuttuğumuz satır kilidini bekler ve asla dönmezdi).
            if (a.units <= need) {
              // Kısmi İADE (§2, C2): markLineCanceled=false (satır re-fill'e açık) AMA returnMultiCapacity
              // =false — bu bir iadedir, MAK hakkı havuza dönmez (aşırı-satış önlenir).
              await this.revokeAssignment(a.id, reason, actor, false, tx, false);
              revoked += a.units;
            } else {
              // GERÇEK dönüşü say (revokeExcess deseni) — over-count savunması: yardımcı beklenmedik
              // biçimde 0 döndürürse (yarış) sayaç şişmez.
              const res = await this.revokePartialUnits(a.id, need, reason, actor, tx, false);
              revoked += res.revoked;
            }
          }
          totalRevoked += revoked;
        }

        // 2) qty'yi NET'e düşür (revoke sonrası taze fulfilled ile satır durumu yeniden).
        const [fresh] = await tx
          .select({ fulfilledQty: orderLines.fulfilledQty })
          .from(orderLines)
          .where(eq(orderLines.id, line.id))
          .limit(1);
        const nf = fresh?.fulfilledQty ?? 0;
        const lineStatus = nf >= netQty ? 'fulfilled' : nf > 0 ? 'partial' : 'pending';
        await tx
          .update(orderLines)
          .set({ qty: netQty, status: lineStatus })
          .where(eq(orderLines.id, line.id));
        adjusted++;
      }

      if (adjusted > 0) {
        await recomputeOrderStatus(tx, order.id);
        await tx.insert(fulfillmentEvents).values({
          orderId: order.id,
          type: 'revoked',
          message: `Kısmi iade uzlaştırıldı — ${adjusted} satır, ${totalRevoked} birim geri alındı (${reason})`,
        });
      }

      return { orderId: order.id, revoked: totalRevoked, adjustedLines: adjusted };
    });
  }

  // ─── §7 Meta box SITE-SCOPED operasyonlar (WP eklentisi HMAC ile çağırır) ───────────
  // Mevcut reveal/replace/suspend/resend uçları ADMIN_TOKEN'lıdır (panel-içi). WP eklentisi
  // bunları site HMAC secret'ıyla çağıramaz. Aşağıdaki sarmalayıcılar HmacGuard arkasından
  // gelir: SİTE kimliği HMAC ile doğrulanır, ve HER işlem ÖNCE hedefin (atama/sipariş) çağıran
  // siteye AİT olduğunu doğrular (çapraz-site erişim = 404, varlık sızmaz). actor = wp:kullanıcı@site.

  /** Siparişin bu siteye ait olduğunu doğrula → panel iç id. Çapraz-site/eksik = 404. */
  private async assertOrderInSite(remoteOrderId: string, siteId: string): Promise<{ orderId: string }> {
    const [o] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.siteId, siteId), eq(orders.remoteOrderId, remoteOrderId)))
      .limit(1);
    if (!o) throw new NotFoundException('Sipariş bulunamadı');
    return { orderId: o.id };
  }

  /**
   * Atamanın, verilen remoteOrderId'li VE bu siteye ait bir siparişe bağlı olduğunu doğrula.
   * Çapraz-site atama id'si veya yanlış sipariş = 404 (varlık/başka-site sızmaz). → lineId döner.
   */
  private async assertAssignmentInSite(
    remoteOrderId: string,
    assignmentId: string,
    siteId: string,
  ): Promise<{ lineId: string; orderId: string; status: string }> {
    const [a] = await this.db
      .select({
        lineId: assignments.lineId,
        orderId: assignments.orderId,
        status: assignments.status,
      })
      .from(assignments)
      .innerJoin(orders, eq(assignments.orderId, orders.id))
      .where(
        and(
          eq(assignments.id, assignmentId),
          eq(orders.remoteOrderId, remoteOrderId),
          eq(orders.siteId, siteId),
        ),
      )
      .limit(1);
    if (!a) throw new NotFoundException('Atama bulunamadı');
    return { lineId: a.lineId, orderId: a.orderId, status: a.status };
  }

  /**
   * §7 loglu reveal — site-scoped. Audit'e wp:kullanıcı@site düşer.
   * Denetim: YALNIZ active/suspended atama gösterilebilir — revoked/expired(hide)/replaced key'in
   * düz payload'ı reveal edilmez (getDeliveries savunma filtresiyle simetrik; karantina/gizleme
   * yaşam döngüsü reveal yolunda da zorlanır).
   */
  async siteReveal(site: Site, remoteOrderId: string, assignmentId: string, actor: string) {
    const a = await this.assertAssignmentInSite(remoteOrderId, assignmentId, site.id);
    if (a.status !== 'active' && a.status !== 'suspended') {
      throw new BadRequestException('Yalnız aktif veya askıdaki atama gösterilebilir');
    }
    return this.reveal(assignmentId, actor);
  }

  /** §7 askıya al/geri aç — site-scoped. reason opsiyonel (verilirse audit'e düşer). */
  async siteSuspend(
    site: Site,
    remoteOrderId: string,
    assignmentId: string,
    suspend: boolean,
    actor: string,
    reason?: string,
  ) {
    await this.assertAssignmentInSite(remoteOrderId, assignmentId, site.id);
    return this.suspend(assignmentId, suspend, actor, reason);
  }

  /** §7 aynı üründen taze key ile değiştir (sebepli) — site-scoped. */
  async siteReplace(
    site: Site,
    remoteOrderId: string,
    assignmentId: string,
    reason: string,
    actor: string,
  ) {
    await this.assertAssignmentInSite(remoteOrderId, assignmentId, site.id);
    return this.replaceAssignment(assignmentId, reason, actor);
  }

  /** §7 teslimat mailini tekrar gönder (60sn debounce) — site-scoped + audit izi. */
  async siteResend(site: Site, remoteOrderId: string, actor: string) {
    const { orderId } = await this.assertOrderInSite(remoteOrderId, site.id);
    const r = await this.resend(orderId, actor);
    await this.db.insert(fulfillmentEvents).values({
      orderId,
      type: 'mail_resent',
      message: `Teslimat maili tekrar gönderildi — ${actor}`,
    });
    return r;
  }

  /**
   * Sipariş satırının (Woo item id) bu siteye ait siparişe ait olduğunu doğrula → panel iç line id.
   * Çapraz-site/eksik = 404. Bonus per-LINE olduğundan (atama üzerinden değil) kullanılır.
   */
  private async assertLineInSite(
    remoteOrderId: string,
    remoteLineId: string,
    siteId: string,
  ): Promise<string> {
    const [l] = await this.db
      .select({ id: orderLines.id })
      .from(orderLines)
      .innerJoin(orders, eq(orderLines.orderId, orders.id))
      .where(
        and(
          eq(orderLines.remoteLineId, remoteLineId),
          eq(orders.remoteOrderId, remoteOrderId),
          eq(orders.siteId, siteId),
        ),
      )
      .limit(1);
    if (!l) throw new NotFoundException('Sipariş satırı bulunamadı');
    return l.id;
  }

  /** §7 +1 bonus atama — site-scoped, PER-LINE (Woo item id). Satıra ekstra key ekler + bonus maili. */
  async siteBonus(site: Site, remoteOrderId: string, remoteLineId: string, actor: string) {
    const lineId = await this.assertLineInSite(remoteOrderId, remoteLineId, site.id);
    const res = await this.fulfillment.bonusAssign(lineId, actor);
    await this.db.insert(auditLog).values({
      action: 'assign',
      actor,
      targetType: 'order',
      targetId: res.orderId,
      meta: { op: 'bonus', lineId, added: res.added },
    });
    // Bonus teslimat maili — best-effort (atama zaten commit; kuyruk hatası bonusu düşürmez).
    try {
      const [o] = await this.db.select().from(orders).where(eq(orders.id, res.orderId)).limit(1);
      if (o) {
        await this.mail.enqueueDelivery(
          o.id,
          o.customerEmail,
          `Siparişinize ek lisans eklendi — ${o.remoteOrderId}`,
        );
      }
    } catch {
      /* best-effort */
    }
    return res;
  }

  /**
   * §7 meta box görünümü — site-scoped, PAYLOAD-SIZINTISIZ. Sipariş durum matrisi + satırlar +
   * atamalar (MASKELİ, assignmentId + status ile → aksiyon hedefi) + değişim geçmişi (eski key
   * maskeli). Reveal AYRI/loglu uçtan gelir; buradan düz payload/licenseItemId DÖNMEZ.
   */
  async siteAdminView(site: Site, remoteOrderId: string) {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.siteId, site.id), eq(orders.remoteOrderId, remoteOrderId)))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const lineRows = await this.db
      .select({
        remoteLineId: orderLines.remoteLineId,
        remoteName: orderLines.remoteName,
        qty: orderLines.qty,
        fulfilledQty: orderLines.fulfilledQty,
        status: orderLines.status,
        canceled: orderLines.canceled,
        productName: products.name,
      })
      .from(orderLines)
      .leftJoin(products, eq(orderLines.productId, products.id))
      .where(eq(orderLines.orderId, order.id));
    const lines = lineRows.map((l) => ({
      ...l,
      originRemoteLineId: resolveOriginRemoteLineId(l.remoteLineId),
      isBonus: isBonusRemoteLineId(l.remoteLineId),
    }));

    const asgRows = await this.db
      .select({
        id: assignments.id,
        // remoteLineId: WP tarafı her atamayı KENDİ sipariş kalemi (Woo item id) altında gösterebilsin.
        // Bonus atamaları `bonus:<origLine>:<uuid>` taşır → WP origin satırın altında gruplar.
        remoteLineId: orderLines.remoteLineId,
        status: assignments.status,
        units: assignments.units,
        validUntil: assignments.validUntil,
        deliveredAt: assignments.deliveredAt,
        payloadEnc: licenseItems.payloadEnc,
        licenseItemId: licenseItems.id,
        itemMaxUses: licenseItems.maxUses,
        itemUseCount: licenseItems.useCount,
        productKind: products.kind,
        payloadSchema: products.payloadSchema,
      })
      .from(assignments)
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(eq(assignments.orderId, order.id))
      // WP meta box (mağaza sipariş ekranı). Panel sipariş detayı / My Account / teslimat maili
      // ARTIK `licenseItems.seq` ile sıralanıyor; burası tek başına `deliveredAt DESC` kalsaydı
      // aynı sipariş mağaza tarafında TERS yönde ve aynı damgalı atamalarda KEYFİ sırada
      // görünürdü (tek teslimatta deliveredAt hepsinde eşittir).
      //
      // `deliveredAt DESC` BİRİNCİL anahtar olarak KORUNUR (kısmi teslimatta en son gelen parti
      // üstte — bu ekranın mevcut sözleşmesi); yalnız eşitlik `seq ASC` ile çözülür → tek
      // teslimatlı olağan siparişte sıra panelin diğer yüzeyleriyle AYNI olur.
      .orderBy(desc(assignments.deliveredAt), licenseItems.seq);

    // Eski/yeni anahtar AYRI alias'larla — geçmiş satırında "neyle değişti" de görünsün (maskeli).
    const oldItem = alias(licenseItems, 'old_li');
    const newItem = alias(licenseItems, 'new_li');
    const historyRows = await this.db
      .select({
        assignmentId: assignmentHistory.assignmentId,
        remoteLineId: orderLines.remoteLineId,
        productName: products.name,
        remoteName: orderLines.remoteName,
        reason: assignmentHistory.reason,
        actor: assignmentHistory.actor,
        createdAt: assignmentHistory.createdAt,
        oldPayloadEnc: oldItem.payloadEnc,
        oldLicenseItemId: oldItem.id,
        newPayloadEnc: newItem.payloadEnc,
        newLicenseItemId: newItem.id,
      })
      .from(assignmentHistory)
      .innerJoin(assignments, eq(assignmentHistory.assignmentId, assignments.id))
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .leftJoin(products, eq(orderLines.productId, products.id))
      .leftJoin(oldItem, eq(assignmentHistory.oldLicenseItemId, oldItem.id))
      .leftJoin(newItem, eq(assignmentHistory.newLicenseItemId, newItem.id))
      .where(eq(assignments.orderId, order.id))
      .orderBy(desc(assignmentHistory.createdAt));

    // DEĞİŞİMLE geri alınan atamayı "İptal" DEĞİL "Değiştirildi" gösterebilmek için türetilmiş
    // bayrak (kullanıcı bulgusu: bonus/normal değişimde eski anahtar meta box'ta "İptal" görünüyordu).
    // Durum makinesine DOKUNULMAZ — assignments.status 'revoked' kalır (revoke akışı, karantina ve
    // §2 invaryantları aynen); yalnız SUNUM için "bu revoke bir değişimdi" bilgisi eklenir.
    // licenseItemId siteye DÖNMEZ; eşleştirme server-side yapılır.
    const replacedItemIds = new Set(
      historyRows.map((h) => h.oldLicenseItemId).filter((x): x is string => !!x),
    );
    const replaceReasonByItem = new Map<string, string>();
    for (const h of historyRows) {
      if (h.oldLicenseItemId && !replaceReasonByItem.has(h.oldLicenseItemId)) {
        replaceReasonByItem.set(h.oldLicenseItemId, h.reason);
      }
    }

    return {
      orderId: order.id,
      remoteOrderId: order.remoteOrderId,
      status: order.status,
      held: order.heldForReview,
      lines,
      assignments: asgRows.map((a) => {
        const plain = this.crypto.decrypt(
          a.payloadEnc,
          CryptoService.licenseItemAad(a.licenseItemId),
        );
        const masked = maskPayload(plain, a.productKind, a.payloadSchema);
        const terminal = a.status !== 'active' && a.status !== 'suspended';
        const replaced = terminal && replacedItemIds.has(a.licenseItemId);
        // licenseItemId DÖNMEZ (site iç id'yi görmez) — yalnız assignmentId aksiyon hedefidir.
        return {
          id: a.id,
          replaced,
          replaceReason: replaced ? (replaceReasonByItem.get(a.licenseItemId) ?? null) : null,
          remoteLineId: a.remoteLineId,
          // BONUS gruplama (§7): bonus atama `bonus:<wooItemId>:<uuid>` sentetik satırındadır.
          // originRemoteLineId, WP meta box'un önek AYRIŞTIRMADAN doğru ürün kaleminin altına
          // gruplaması için TEK anahtardır (atamalar ve geçmiş AYNI alanı taşır).
          originRemoteLineId: resolveOriginRemoteLineId(a.remoteLineId),
          isBonus: isBonusRemoteLineId(a.remoteLineId),
          status: a.status,
          units: a.units,
          validUntil: a.validUntil,
          deliveredAt: a.deliveredAt,
          kind: a.productKind,
          maskedPayload: masked.maskedPayload,
          maskedFields: masked.maskedFields,
          maxUses: a.itemMaxUses,
          useCount: a.itemUseCount,
        };
      }),
      history: historyRows.map((h) => {
        const remoteLineId = h.remoteLineId ?? '';
        return {
          assignmentId: h.assignmentId,
          remoteLineId: h.remoteLineId,
          // KRİTİK (kullanıcı bulgusu): bonus atamanın değişim geçmişi, WP tarafında satır
          // eşleşmesi TAM `remoteLineId` üzerinden yapıldığı için düşüyordu (bonus satırın id'si
          // `bonus:<item>:<uuid>`, Woo kalemi ise `<item>`). originRemoteLineId ile geçmiş de
          // atamalarla AYNI şekilde gruplanır → bonus değişimi artık geçmişte görünür.
          originRemoteLineId: remoteLineId ? resolveOriginRemoteLineId(remoteLineId) : null,
          isBonus: remoteLineId ? isBonusRemoteLineId(remoteLineId) : false,
          productName: h.productName ?? null,
          remoteName: h.remoteName ?? null,
          reason: h.reason,
          actor: h.actor,
          createdAt: h.createdAt,
          oldMasked:
            h.oldPayloadEnc && h.oldLicenseItemId
              ? mask(
                  this.crypto.decrypt(
                    h.oldPayloadEnc,
                    CryptoService.licenseItemAad(h.oldLicenseItemId),
                  ),
                )
              : '—',
          newMasked:
            h.newPayloadEnc && h.newLicenseItemId
              ? mask(
                  this.crypto.decrypt(
                    h.newPayloadEnc,
                    CryptoService.licenseItemAad(h.newLicenseItemId),
                  ),
                )
              : '—',
        };
      }),
    };
  }

  /**
   * Karantina / Değiştirilen Anahtarlar (§2/§3): eski/ölü anahtarlar ayrı tabloda TUTULMAZ —
   * `license_items` satırı DB'de kalır, yalnız `status` → `quarantined` (tek-kullanım revoke/iade)
   * veya `voided` (recall) olur. Bu ekran üç kaynağı OKUMA-anında birleştirir: license_items (durum),
   * assignment_history (değişim soyağacı + sebep), audit_log (düz-revoke sebebi fallback).
   *
   * GÜVENLİK: liste yüzlerce ölü anahtar döndürür → account-tipi TAM parola bir listede TOPLU dökülmez.
   * keyPreview server-side üretilir: key/code/custom → son-4 maskeli (bulk liste reveal-audit üretmesin);
   * account → yalnız secret-OLMAYAN alanlar (parola HİÇ dönmez). TAM değer yalnız kaynak siparişin loglu
   * reveal yolunda görülür. Yazma yok — salt-okunur.
   *
   * PERF: `preview=false` verilirse `keyPreview` (ve dolayısıyla satır başına AES-GCM çözme)
   * HİÇ üretilmez, alan `null` döner — anahtarı göstermeyen ekranlar (havuz sayımı/gruplama)
   * için. Satır sayısı/sırası/diğer alanlar birebir aynıdır.
   *
   * DÖNÜŞ (DÜRÜSTLÜK): düz dizi DEĞİL, `{ rows, truncated, limit }`. `truncated`, JS süzgecinden
   * SONRAKİ satır sayısına değil SQL'in döndürdüğü HAM satır sayısının fetch üst sınırına dayanır —
   * aksi halde tarih süzgeci satırları kırptığında liste EKSİKKEN uyarı `false` çıkıyordu (G6).
   */
  async listQuarantine(params: QuarantineQuery = {}) {
    // (Denetim A1/M1) Düz-metin yetkisi: controller canRevealPlaintext(role)'ü geçer. Servis
    // varsayılanı true (geriye dönük: reveal geçmeyen iç çağrılar — CSV export vb. — tam metin alır;
    // export owner-only rota; owner-olmayan gate controller'da). owner-OLMAYAN admin → maskeli.
    const reveal = params.reveal ?? true;
    // Önizleme (dolayısıyla satır başına AES-GCM çözme) varsayılan AÇIK — eski çağrılar aynen çalışır.
    const preview = params.preview ?? true;
    const limit = Math.min(Math.max(Math.trunc(params.limit ?? 500), 1), 5000);
    // Satır çoğalması (leftJoin fan-out: aynı ölü key'in birden çok atama/soyağacı satırı) SQL
    // LIMIT'i tüketebildiği için lisans-satırı bazında dedupe'tan ÖNCE daha geniş çekilir, sonra
    // JS'te `limit`e kırpılır. Üst sınır sabit → bellek patlamaz.
    const fetchLimit = Math.min(limit * 3 + 50, 20_000);

    // ── Tarih sınırları (SQL ön-filtresi + kesin JS süzgeci AYNI değerleri kullanır) ────────
    // SAVUNMACI: geçersiz değer (from=abc) SESSİZCE süzgeçsiz kabul edilir — 400/500 atılmaz.
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
    const rawFrom = (params.from ?? '').trim();
    const rawTo = (params.to ?? '').trim();
    const fromTs = rawFrom ? Date.parse(rawFrom) : Number.NaN;
    const toParsed = rawTo ? Date.parse(rawTo) : Number.NaN;
    // Yalnız TARİH verildiyse (YYYY-MM-DD) üst sınır gün SONUNA kadar kapsar — aksi halde
    // "bugünden bugüne" seçimi 00:00 sınırında kalıp listeyi boş gösterirdi.
    const toTs = !Number.isNaN(toParsed) && dateOnly.test(rawTo) ? toParsed + 86_399_999 : toParsed;
    // SQL parametresi için ISO — Date aralığı DIŞINA taşan değer (ör. gün-sonu eklemesi üst
    // sınırı aşarsa) `toISOString()`'i patlatır; null'a düşer → o yönde SQL ön-filtresi yok
    // (kesin JS süzgeci yine çalışır). Okuma yolu ASLA 500 atmaz.
    const isoOrNull = (ts: number): string | null => {
      if (Number.isNaN(ts)) return null;
      const d = new Date(ts);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    };
    const fromIso = isoOrNull(fromTs);
    const toIso = isoOrNull(toTs);

    const search = (params.search ?? '').trim();
    const like = search ? `%${search}%` : null;
    // Tedarikçi zinciri: parti (batch) doğrudan tedarikçi taşımıyorsa satın alma emrinden gelir.
    const supplierIdExpr = sql`coalesce(${batches.supplierId}, ${purchaseOrders.supplierId})`;

    const conditions = [inArray(licenseItems.status, ['quarantined', 'voided'])];
    if (params.status) conditions.push(eq(licenseItems.status, params.status));
    if (params.productId) conditions.push(eq(licenseItems.productId, params.productId));
    if (params.supplierId) conditions.push(sql`${supplierIdExpr} = ${params.supplierId}`);
    if (like) {
      // Aranabilir alanlar: ürün adı/SKU, müşteri e-postası, mağaza sipariş no, parti etiketi,
      // tedarikçi adı. ANAHTAR İÇERİĞİ aranmaz (payload şifreli — düz metin sorgusu imkânsız).
      const searchCond = or(
        ilike(products.name, like),
        ilike(products.sku, like),
        ilike(orders.customerEmail, like),
        ilike(orders.remoteOrderId, like),
        ilike(batches.label, like),
        ilike(suppliers.name, like),
      );
      if (searchCond) conditions.push(searchCond);
    }

    // ── TEDARİKÇİ BİLDİRİM DURUMU (§12 değişim fişi) ───────────────────────────────────────
    // "Bu kusurlu anahtar tedarikçiye bildirildi mi?" — AYRI bir sorgu yazılmaz, kalem başına
    // tek EXISTS ile bu (denetimden geçmiş) sorguya bağlanır.
    //
    // `outcome <> 'rejected'` yüklemi, `supplier_claim_items_open_uniq` KISMİ UNIQUE INDEX'İYLE
    // BİREBİR AYNIDIR ve bu bilinçli: tedarikçi reddettiyse anahtar HAVUZA GERİ DÖNER, yani hem
    // yeniden fişlenebilir (index izin verir) hem "bekleyenler" listesinde tekrar görünür
    // (buradaki süzgeç izin verir). İki yüklem ayrışırsa ekran ile veritabanı çelişir.
    const openClaimExists = sql`EXISTS (
      SELECT 1 FROM supplier_claim_items sci
      WHERE sci.license_item_id = ${licenseItems.id} AND sci.outcome <> 'rejected'
    )`;
    if (params.claimed === 'none') conditions.push(sql`NOT ${openClaimExists}`);
    else if (params.claimed === 'open') conditions.push(openClaimExists);

    // ── SQL ÖN-FİLTRESİ: tarih aralığı (denetim bulgusu G6) ────────────────────────────────
    // Karantina tarihi TEK kolon DEĞİL: coalesce(değişim geçmişi, düz-revoke audit'i, stok
    // düzeltme, atama, stok girişi). Son ikisi bu sorguda, ilk üçü AYRI tablolarda → KESİN
    // süzgeç aşağıda (JS) kalır. Ama süzgeç YALNIZ JS'te kalırsa SQL en yeni `fetchLimit`
    // satırı çeker ve seçilen ESKİ dönem o pencerede olmadığı için liste BOŞ görünürdü
    // (20.000 kayıtlı kurulumda "01.01.2025–31.03.2025" → 0 satır). Bu yüzden SQL'e SAĞLAM
    // BİR ÜST KÜME (superset) ön-filtresi konur: hiçbir GEÇERLİ satırı düşürmez, ama pencereyi
    // doğru döneme kaydırır.
    const baseAt = sql`coalesce(${licenseItems.assignedAt}, ${licenseItems.createdAt})`;

    // ÜST SINIR — sağlam: karantina olayı (revoke/değişim/düzeltme) kalemin atanmasından ya da
    // stok girişinden ÖNCE olamaz ⇒ quarantinedAt >= baseAt. baseAt > to ise kayıt KESİN aralık
    // dışıdır. ORDER BY da baseAt olduğu için pencere tam bu dönemin başından itibaren dolar.
    if (toIso) conditions.push(sql`${baseAt} <= ${toIso}::timestamptz`);

    // ALT SINIR — `baseAt >= from` TEK BAŞINA YANLIŞ olurdu: kalem 2 yıl önce atanıp DÜN
    // karantinaya düşmüş olabilir ("Son 7 gün" süzgecinin en tipik kaydı). Bu yüzden aralıkta
    // OLAY üretmiş kalemler ayrıca toplanıp OR ile eklenir (id listeleri; sır içermez).
    // Toplama üst sınırı aşarsa alt-sınır ön-filtresi HİÇ uygulanmaz → geniş (ama eksiksiz)
    // pencere; kesin süzme zaten JS'te yapılır. "Eksik liste" yerine "geniş liste" tercih edilir.
    if (fromIso) {
      const eventCap = 5000;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const inWindow = (col: unknown) =>
        toIso
          ? sql`${col} >= ${fromIso}::timestamptz AND ${col} <= ${toIso}::timestamptz`
          : sql`${col} >= ${fromIso}::timestamptz`;

      const [historyIdRows, auditIdRows, adjIdRows] = await Promise.all([
        // Değişim (assignment_history) — ana sorgudaki join ile AYNI anahtar: old_license_item_id.
        this.db
          .select({ id: assignmentHistory.oldLicenseItemId })
          .from(assignmentHistory)
          .where(
            and(
              sql`${assignmentHistory.oldLicenseItemId} is not null`,
              inWindow(assignmentHistory.createdAt),
            ),
          )
          .limit(eventCap + 1),
        // Düz-revoke (audit_log) — hedef ATAMA id'si; ana sorguda assignments.id ile eşleşir.
        this.db
          .select({ id: auditLog.targetId })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, 'revoke'),
              eq(auditLog.targetType, 'assignment'),
              inWindow(auditLog.createdAt),
            ),
          )
          .limit(eventCap + 1),
        // Stok düzeltme (recall/void/damage) — voided kalemlerin tek zaman kaynağı.
        this.db
          .select({ id: stockAdjustments.licenseItemId })
          .from(stockAdjustments)
          .where(
            and(
              inArray(stockAdjustments.action, ['recall', 'void', 'damage']),
              sql`${stockAdjustments.licenseItemId} is not null`,
              inWindow(stockAdjustments.createdAt),
            ),
          )
          .limit(eventCap + 1),
      ]);

      const capped =
        historyIdRows.length > eventCap ||
        auditIdRows.length > eventCap ||
        adjIdRows.length > eventCap;
      if (!capped) {
        const itemIds = Array.from(
          new Set(
            [...historyIdRows, ...adjIdRows].map((r) => r.id).filter((x): x is string => !!x),
          ),
        );
        // target_id METİN kolonu — uuid'ye çevrilemeyen değer parametre olarak gönderilirse
        // Postgres 22P02 atardı; okuma yolu asla 500'lemesin diye biçim doğrulanır.
        const asgIds = Array.from(
          new Set(auditIdRows.map((r) => r.id).filter((x): x is string => !!x && uuidRe.test(x))),
        );
        const parts = [sql`${baseAt} >= ${fromIso}::timestamptz`];
        if (itemIds.length) parts.push(inArray(licenseItems.id, itemIds));
        if (asgIds.length) parts.push(inArray(assignments.id, asgIds));
        const fromCond = or(...parts);
        if (fromCond) conditions.push(fromCond);
      }
    }

    // Fiş bilgisi (kod/durum/yanıt) için TEK join (denetim/perf): eskiden dördü ayrı korele
    // skaler alt-sorguydu (ikisi supplier_claims'e JOIN'liydi) ve fetchLimit'teki HER fan-out
    // satırı için tekrar koşuyordu. `outcome <> 'rejected'` yüklemi `supplier_claim_items_open_uniq`
    // KISMİ UNIQUE INDEX'iyle birebir aynı olduğundan license_item başına EN FAZLA BİR satır
    // döner → bu join satır ÇOĞALTMAZ (yukarıdaki openClaimExists ile aynı tanım).
    const claimLink = this.db
      .select({
        licenseItemId: supplierClaimItems.licenseItemId,
        claimId: supplierClaimItems.claimId,
        claimOutcome: sql<string>`${supplierClaimItems.outcome}::text`.as('claim_outcome'),
        claimCode: supplierClaims.code,
        claimStatus: sql<string>`${supplierClaims.status}::text`.as('claim_status'),
      })
      .from(supplierClaimItems)
      .innerJoin(supplierClaims, eq(supplierClaims.id, supplierClaimItems.claimId))
      .where(sql`${supplierClaimItems.outcome} <> 'rejected'`)
      .as('claim_link');

    const rows = await this.db
      .select({
        licenseItemId: licenseItems.id,
        payloadEnc: licenseItems.payloadEnc,
        status: licenseItems.status,
        assignedAt: licenseItems.assignedAt,
        createdAt: licenseItems.createdAt,
        productId: products.id,
        productName: products.name,
        productSku: products.sku,
        productKind: products.kind,
        payloadSchema: products.payloadSchema,
        batchId: batches.id,
        batchCode: batches.label,
        supplierId: sql<string | null>`${supplierIdExpr}`,
        supplierName: suppliers.name,
        sourceOrderId: orders.id,
        sourceRemoteOrderId: orders.remoteOrderId,
        customerEmail: orders.customerEmail,
        siteDomain: sites.domain,
        siteType: sites.type,
        // webhookUrl OKUNMAZ: mağaza admin linki artık yalnız şablon/domain'den türetilir.
        siteAdminOrderUrlTemplate: sites.adminOrderUrlTemplate,
        // Değişim soyağacı (varsa): eski key → yeni atama + sebep + zaman.
        replacedByAssignmentId: assignmentHistory.assignmentId,
        historyReason: assignmentHistory.reason,
        historyAt: assignmentHistory.createdAt,
        formerAssignmentId: assignments.id,
        // Tedarikçi bildirimi (§12): kalem hangi değişim fişinde? (claim_link join'i — yukarıda)
        claimId: claimLink.claimId,
        claimCode: claimLink.claimCode,
        claimStatus: claimLink.claimStatus,
        claimOutcome: claimLink.claimOutcome,
      })
      .from(licenseItems)
      .innerJoin(products, eq(licenseItems.productId, products.id))
      // former atama/order/customer: revoke sonrası assignment satırı kalır, licenseItemId hâlâ
      // eski key'i işaret eder.
      .leftJoin(assignments, eq(assignments.licenseItemId, licenseItems.id))
      // NOT (PERF, denetim): burada bir `order_lines` LEFT JOIN'i vardı ve HİÇBİR kolonu
      // seçilmiyor, hiçbir koşulda kullanılmıyordu (ölü join). Kaldırıldı; DAVRANIŞ BİREBİR
      // AYNI: birincil anahtar (`order_lines.id`) üzerinden LEFT JOIN olduğu için satır
      // ÇOĞALTMIYOR ve LEFT olduğu için satır DÜŞÜRMÜYORDU — yani sonuç kümesi değişmez,
      // yalnız her okuma yolundan bir tablo erişimi kalkar.
      .leftJoin(orders, eq(assignments.orderId, orders.id))
      .leftJoin(sites, eq(orders.siteId, sites.id))
      // Tedarik zinciri (§12): parti → satın alma emri → tedarikçi. batch_id FK'siz plain uuid.
      .leftJoin(batches, eq(licenseItems.batchId, batches.id))
      .leftJoin(purchaseOrders, eq(batches.purchaseOrderId, purchaseOrders.id))
      .leftJoin(suppliers, sql`${suppliers.id} = ${supplierIdExpr}`)
      // sebep (değişim): eski key = ah.old_license_item_id.
      .leftJoin(assignmentHistory, eq(assignmentHistory.oldLicenseItemId, licenseItems.id))
      // Tedarikçi bildirimi: kısmi unique index sayesinde 1:0..1 → satır çoğaltmaz.
      .leftJoin(claimLink, eq(claimLink.licenseItemId, licenseItems.id))
      .where(and(...conditions))
      // voided (recall) item'ların assignedAt'i NULL → stok giriş tarihine (created_at) düş;
      // aksi halde tüm recall kategorisi listenin sonunda kalıp pencereden düşerdi.
      // TIE-BREAK (seq) ŞART: bu ORDER BY bir LIMIT ile birlikte çalışıyor. Eşit damgalı
      // satırlarda hangilerinin pencereye gireceği tie-break olmadan KEYFİ olur — aynı
      // süzgeç iki koşuda farklı kayıt kümesi döndürebilir (kırpma uyarısı da yanıltır).
      // YÖN: `seq DESC` — envanter listesiyle aynı kural (satır satır en yeni üstte).
      // Bir recall/void tüm partiyi aynı damgayla öldürür; eşitliği en son eklenen anahtar
      // kazanır, böylece iki liste aynı sırayı gösterir.
      .orderBy(sql`coalesce(${licenseItems.assignedAt}, ${licenseItems.createdAt}) DESC, ${licenseItems.seq} DESC`)
      .limit(fetchLimit);

    // audit_log fallback (detail() reasonRows deseni): düz-revoke (değişim değil) sebebi
    // audit_log.meta.reason'da → formerAssignmentId kümesi için topla (en yeni kazanır).
    const asgIds = Array.from(
      new Set(rows.map((r) => r.formerAssignmentId).filter((x): x is string => !!x)),
    );
    const auditReasonByAsg = new Map<string, string>();
    const auditAtByAsg = new Map<string, Date>();
    if (asgIds.length) {
      const reasonRows = await this.db
        .select({
          targetId: auditLog.targetId,
          meta: auditLog.meta,
          createdAt: auditLog.createdAt,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, 'revoke'),
            eq(auditLog.targetType, 'assignment'),
            inArray(auditLog.targetId, asgIds),
          ),
        )
        .orderBy(desc(auditLog.createdAt));
      for (const r of reasonRows) {
        if (!r.targetId) continue;
        if (!auditAtByAsg.has(r.targetId) && r.createdAt) auditAtByAsg.set(r.targetId, r.createdAt);
        if (!auditReasonByAsg.has(r.targetId)) {
          const reason = (r.meta as { reason?: unknown } | null)?.reason;
          if (typeof reason === 'string' && reason) auditReasonByAsg.set(r.targetId, reason);
        }
      }
    }

    // Voided (recall/void/damage) item'lar için sebep+zaman stock_adjustments'tadır (atama/geçmiş
    // YOK) → aksi halde tüm recall/void kategorisi sebep='—' görünürdü (denetim MED bulgusu).
    const liIds = Array.from(new Set(rows.map((r) => r.licenseItemId)));
    const adjReasonByLi = new Map<string, string>();
    const adjAtByLi = new Map<string, Date>();
    // `action` da okunur: kusurun KAYNAĞINI (recall / damage / elle void) belirler ve
    // tedarikçiye giden fiş raporunda gerekçe ayrımı olarak yazılır.
    const adjActionByLi = new Map<string, string>();
    if (liIds.length) {
      const adjRows = await this.db
        .select({
          licenseItemId: stockAdjustments.licenseItemId,
          reason: stockAdjustments.reason,
          action: stockAdjustments.action,
          createdAt: stockAdjustments.createdAt,
        })
        .from(stockAdjustments)
        .where(
          and(
            inArray(stockAdjustments.licenseItemId, liIds),
            inArray(stockAdjustments.action, ['recall', 'void', 'damage']),
          ),
        )
        .orderBy(desc(stockAdjustments.createdAt));
      for (const a of adjRows) {
        if (!a.licenseItemId) continue;
        if (!adjAtByLi.has(a.licenseItemId) && a.createdAt)
          adjAtByLi.set(a.licenseItemId, a.createdAt);
        if (!adjReasonByLi.has(a.licenseItemId) && a.reason)
          adjReasonByLi.set(a.licenseItemId, a.reason);
        if (!adjActionByLi.has(a.licenseItemId) && a.action)
          adjActionByLi.set(a.licenseItemId, a.action);
      }
    }

    // MAK/multi voided item, leftJoin(assignments)'te birden çok atamaya yayılabilir → licenseItem
    // başına TEK satır (aynı ölü key mükerrer listelenmesin; denetim bulgusu).
    const seen = new Set<string>();
    const mapped = rows
      .filter((r) => {
        if (seen.has(r.licenseItemId)) return false;
        seen.add(r.licenseItemId);
        return true;
      })
      .map((r) => {
        const auditReason = r.formerAssignmentId
          ? (auditReasonByAsg.get(r.formerAssignmentId) ?? null)
          : null;
        const auditAt = r.formerAssignmentId
          ? (auditAtByAsg.get(r.formerAssignmentId) ?? null)
          : null;
        const adjReason = adjReasonByLi.get(r.licenseItemId) ?? null;
        const adjAt = adjAtByLi.get(r.licenseItemId) ?? null;
        const adjAction = adjActionByLi.get(r.licenseItemId) ?? null;
        return {
          licenseItemId: r.licenseItemId,
          productId: r.productId,
          productName: r.productName,
          sku: r.productSku,
          productKind: r.productKind,
          status: r.status,
          // preview=false → çözme HİÇ koşmaz (PERF). Alan yine DÖNER ama `null`'dır: tüketici
          // "alan yok" ile "önizleme istenmedi" arasını ayırt edebilsin (sessiz boş string yok).
          keyPreview: preview
            ? this.quarantineKeyPreview(
                r.payloadEnc,
                r.licenseItemId,
                r.productKind,
                r.payloadSchema,
                reveal,
              )
            : null,
          // Tedarik izi (§12) — tedarikçiye "şu partiden şu anahtarlar bozuk" diye iletilebilsin.
          batchId: r.batchId ?? null,
          batchCode: r.batchCode ?? null,
          supplierId: r.supplierId ?? null,
          supplierName: r.supplierName ?? null,
          // Stok girişi (import) tarihi — karantina tarihinden AYRI kavram.
          createdAt: r.createdAt ?? null,
          sourceOrderId: r.sourceOrderId ?? null,
          sourceRemoteOrderId: r.sourceRemoteOrderId ?? null,
          // Alan adı simetrisi (yeni tüketiciler için; source* alanları GERİYE DÖNÜK korunur).
          orderId: r.sourceOrderId ?? null,
          remoteOrderId: r.sourceRemoteOrderId ?? null,
          siteDomain: r.siteDomain ?? null,
          // Mağaza adminindeki kaynak sipariş — SALT LİNK (panel mağazaya bağlanmaz).
          storeAdminUrl: buildStoreAdminUrl(
            {
              type: r.siteType,
              domain: r.siteDomain,
              adminOrderUrlTemplate: r.siteAdminOrderUrlTemplate,
            },
            r.sourceRemoteOrderId,
          ),
          customerEmail: r.customerEmail ?? null,
          reason: r.historyReason ?? auditReason ?? adjReason ?? null,
          replacedByAssignmentId: r.replacedByAssignmentId ?? null,
          quarantinedAt: r.historyAt ?? auditAt ?? adjAt ?? r.assignedAt ?? r.createdAt ?? null,
          // Tedarikçi bildirimi (§12): boşsa kalem HAVUZDA bekliyor demektir.
          claimId: r.claimId ?? null,
          claimCode: r.claimCode ?? null,
          claimStatus: r.claimStatus ?? null,
          claimOutcome: r.claimOutcome ?? null,
          /**
           * Kusurun KAYNAĞI — tedarikçiye giden raporda gerekçe ayrımı için. Kalemin ölüm
           * yolundan türetilir: değişim soyağacı varsa müşteri iadesi; yoksa stok düzeltme
           * kaydının `action`'ı (recall/damage/void) belirler. Fiş kesilirken snapshot'lanır.
           */
          defectKind: r.historyReason
            ? 'customer_return'
            : adjAction === 'recall'
              ? 'recall'
              : adjAction === 'damage'
                ? 'damage'
                : adjAction === 'void'
                  ? 'manual_void'
                  : auditReason
                    ? 'customer_return'
                    : null,
        };
      });

    // Görüntüde en yeni üstte: voided'ın DB assignedAt'i NULL olduğu için birleşik zamana göre JS sıralaması.
    mapped.sort((a, b) => {
      const ta = a.quarantinedAt ? new Date(a.quarantinedAt).getTime() : 0;
      const tb = b.quarantinedAt ? new Date(b.quarantinedAt).getTime() : 0;
      return tb - ta;
    });

    // KESİN tarih süzgeci: birleşik `quarantinedAt` (değişim/audit/stok-düzeltme/atama/giriş
    // koalesansı) ancak burada, üç kaynak birleştirildikten SONRA bilinir. Yukarıdaki SQL
    // ön-filtresi pencereyi doğru döneme kaydırır; bu adım o pencereyi tam aralığa kırpar.
    const filtered =
      Number.isNaN(fromTs) && Number.isNaN(toTs)
        ? mapped
        : mapped.filter((r) => {
            const t = r.quarantinedAt ? new Date(r.quarantinedAt).getTime() : null;
            if (t === null) return false;
            if (!Number.isNaN(fromTs) && t < fromTs) return false;
            if (!Number.isNaN(toTs) && t > toTs) return false;
            return true;
          });

    const out = filtered.slice(0, limit);

    // KIRPILMA (DÜRÜSTLÜK, G6): sinyal HAM SQL satır sayısına dayanır — JS tarih süzgecinden
    // SONRAKİ sayıya değil. Aksi halde süzgeç satırları kırptığında "liste eksik ama uyarı yok"
    // durumu doğuyordu (operatör o dönemin bozuk anahtarlarını hiç görmeden dışa aktarıyordu).
    // İki kaynak: (1) SQL fetch üst sınırına dayanıldı → daha eskiler HİÇ okunmadı;
    // (2) dedupe sonrası kayıt sayısı `limit`i aştı → kuyruk kesildi.
    const truncated = rows.length >= fetchLimit || filtered.length > limit;

    // "reveal audit'e düşer" (§17) bu yol için de geçerli: karantina listesi ölü anahtarların
    // DÜZ METNİNİ toplu döndürür (operatör tedarikçiye değişim talebi için dışa aktarır).
    // Tek kayıt = tek görüntüleme (per-key değil per-view granülerlik, sipariş detayı deseni).
    // best-effort: audit yazımı bu OKUMA yolunu bozmamalı (yazım hatasında liste yine döner).
    // (Denetim M1) Audit YALNIZ gerçek düz-metin döndüğünde (reveal=true) yazılır — maskeli
    // liste (owner-olmayan) hiçbir sır ifşa etmez, dolayısıyla reveal kaydı üretmez.
    // `preview` de ŞART: önizleme kapalıyken payload HİÇ çözülmez, yani ortada görüntülenen
    // bir sır yoktur — kayıt yazmak denetim izini YALAN sayımlarla kirletir (operatör
    // "5000 anahtar görüntülendi" görür, oysa hiçbiri gösterilmedi).
    if (reveal && preview && out.length > 0) {
      try {
        await this.db.insert(auditLog).values({
          action: 'reveal',
          actor: params.actor || 'admin',
          targetType: 'quarantine',
          // Liste görünümü tek bir kayda ait değil → hedef id yok; kapsam meta'da.
          meta: {
            auto: true,
            view: 'quarantine_list',
            count: out.length,
            // Arama METNİ yazılmaz (müşteri e-postası içerebilir); yalnız süzgeç varlığı.
            filtered: Boolean(
              search || params.status || params.productId || params.supplierId || fromIso || toIso,
            ),
            truncated,
          },
        });
      } catch {
        /* audit yazımı başarısız → liste yine de döner */
      }
    }

    // Düz dizi DEĞİL: kırpılma bilgisi olmadan admin tarafı "liste tam" sanıyordu (G6).
    return { rows: out, truncated, limit };
  }

  /**
   * Karantina listesi için anahtar önizlemesi. `reveal` (denetim A1/M1) düz-metin yetkisidir:
   *   · reveal=true (owner / auth KAPALI): key/code/custom → TAM düz anahtar (ölü/karantina anahtar
   *     sır değil); account → yalnız secret-OLMAYAN alanlar (bir LİSTEDE onlarca parolayı toplu
   *     dökmemek için; tam hesap kaynak siparişte görünür).
   *   · reveal=false (owner-OLMAYAN admin): key/code/custom → maskeli (••••••+son-4); account →
   *     tüm alanlar maskeli (secret kuyruksuz). Sipariş detayı / envanter maskesiyle simetrik.
   */
  private quarantineKeyPreview(
    payloadEnc: string,
    licenseItemId: string,
    kind: string,
    payloadSchema: unknown,
    reveal: boolean,
  ): string {
    const plain = this.crypto.decrypt(payloadEnc, CryptoService.licenseItemAad(licenseItemId));
    if (kind === 'account') {
      const parsed = AccountPayloadSchema.safeParse(payloadSchema);
      if (parsed.success) {
        const fields = parseAccountPayload(parsed.data, plain);
        // owner-OLMAYAN: TÜM alanlar maskeli (secret kuyruksuz). owner: yalnız secret-olmayanları göster.
        const shown = reveal
          ? fields.filter((f) => !f.secret)
          : maskAccountFields(fields);
        return shown.length ? shown.map((f) => `${f.label}: ${f.value}`).join(' · ') : '—';
      }
      return '—';
    }
    return reveal ? plain : maskSecret(plain);
  }

  // ─── İnceleme Kuyruğu (§8 held_for_review — dinamik kota) ──────────────────────────
  /**
   * İnceleme kuyruğunda tek çağrıda dönen azami sipariş. Kırpma SESSİZ DEĞİL: `truncated`
   * ile raporlanır (aşağıdaki nota bakınız).
   */
  private static readonly HELD_LIST_LIMIT = 200;

  /**
   * İnceleme kuyruğu listesi (§8): dinamik kota eşiğini aşıp held_for_review'e alınmış
   * siparişler (en yeni önce). Site domain + satır sayısı özetiyle — PAYLOAD/KEY YOK.
   *
   * DÖNÜŞ (DÜRÜSTLÜK): düz dizi DEĞİL, `{ items, truncated, limit }`. Eskiden yalnız
   * `limit(200)` vardı ve kırpılma HİÇBİR YERDE söylenmiyordu; sıralama `heldAt DESC`
   * olduğu için pencereden düşenler EN ESKİ held siparişlerdi — yani müşterinin ÖDEDİĞİ
   * ama teslim edilmemiş, en uzun süredir bekleyen kayıtlar. Operatör kuyruğu boşalttığını
   * sanıp o siparişleri kalıcı beklemede bırakabiliyordu (projenin savaştığı "sessiz kırpma"
   * sınıfı). Desen: TAVAN+1 çek, JS'te kırp — tam TAVAN kadar kayıtta yanlış alarm basılmaz.
   */
  async listHeldOrders() {
    const rows = await this.db
      .select({
        id: orders.id,
        remoteOrderId: orders.remoteOrderId,
        customerEmail: orders.customerEmail,
        status: orders.status,
        heldAt: orders.heldAt,
        heldReason: orders.heldReason,
        createdAt: orders.createdAt,
        siteId: orders.siteId,
        siteDomain: sites.domain,
        lineCount: sql<number>`(select count(*)::int from order_lines ol where ol.order_id = ${orders.id})`,
      })
      .from(orders)
      .leftJoin(sites, eq(orders.siteId, sites.id))
      .where(eq(orders.heldForReview, true))
      // TIE-BREAK (id) ŞART: bu ORDER BY bir LIMIT ile çalışıyor — eşit `heldAt` damgalı
      // siparişlerde (aynı saniyede beklemeye alınan toplu akış) pencereye hangilerinin
      // gireceği tie-break olmadan KEYFİ olurdu; iki koşu farklı liste döndürebilirdi
      // (proje kuralı: LIMIT'li her ORDER BY'ın tie-break'i olmalı). Birincil anahtar ve
      // NULLS sırası DEĞİŞMEDİ (desc → NULLS FIRST, eski davranış).
      .orderBy(desc(orders.heldAt), desc(orders.id))
      .limit(AdminOrdersService.HELD_LIST_LIMIT + 1);

    // Sinyal HAM SQL satır sayısından: TAVAN+1 çekildiği için `>` KESİN kırpma demektir.
    const truncated = rows.length > AdminOrdersService.HELD_LIST_LIMIT;
    // Tespit için çekilen fazladan satır YANITA GİRMEZ (sözleşme: en fazla TAVAN satır).
    return {
      items: rows.slice(0, AdminOrdersService.HELD_LIST_LIMIT),
      truncated,
      limit: AdminOrdersService.HELD_LIST_LIMIT,
    };
  }

  /**
   * İnceleme kuyruğu ONAYLA (§8): held bayrağını ÖNCE temizler (completeLine held savunmasına
   * takılmasın), sonra her eşlemeli + iptal-edilmemiş satırı MEVCUT atama makinesiyle (completeLine
   * — atomik SKIP LOCKED + kapasite + mail/webhook) doldurur. Stok kadar atar; yetmezse satır
   * partial/pending kalır (normal akış, autoComplete sonra tamamlar). fulfillment_events + audit izi.
   */
  async releaseHeld(orderId: string, actor: string) {
    // #7 denetim (yarış): held bayrağını AYNI sipariş için advisory-lock altında CAS ile temizle
    // → eşzamanlı rejectHeld/refund'ı DIŞLA (ikisi de kilit altında heldForReview'i yeniden okur;
    // bayrak temizlendiyse ikinci geçiş no-op olur). Teslimat (completeLine) bayrak commit sonrası.
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`);
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1)
        .for('update');
      if (!order) throw new NotFoundException('Sipariş bulunamadı');
      if (!order.heldForReview) throw new BadRequestException('Sipariş incelemede değil');
      await tx
        .update(orders)
        .set({ heldForReview: false, updatedAt: new Date() })
        .where(eq(orders.id, orderId));
    });

    // Bayrak temizlendi → completeLine held-guard'a takılmaz. Her eşlemeli + iptal-edilmemiş satırı
    // doldur; completeLine artık all-or-nothing'i onurlandırır (kısmi teslim etmez, #7 denetim D).
    const lines = await this.db
      .select({ id: orderLines.id, productId: orderLines.productId, canceled: orderLines.canceled })
      .from(orderLines)
      .where(eq(orderLines.orderId, orderId));
    for (const l of lines) {
      if (l.productId && !l.canceled) await this.fulfillment.completeLine(l.id);
    }

    // F3 (defense-in-depth): teslimat penceresinde sipariş iade/iptal edilmiş olabilir —
    // revokeOrderForSite advisory-lock altında TÜM satırları canceled + status='revoked' yapar.
    // Ana güvence revokeOrderForSite tarafında (satır row-lock'u completeLine ile serileşir); bu ek
    // kat: sipariş bu arada 'revoked' olduysa BU teslimatta açılmış aktif atamaları geri al → iade
    // edilmiş siparişte canlı key kalmaz (§2). Normal (iade yok) akışta status fulfilled/partial → no-op.
    const [afterState] = await this.db
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (afterState?.status === 'revoked') {
      const stray = await this.db
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.orderId, orderId), eq(assignments.status, 'active')));
      for (const a of stray) {
        await this.revokeAssignment(
          a.id,
          'İade/iptal ile yarış — teslimat geri alındı',
          actor,
        ).catch(() => undefined);
      }
    }

    await this.db.insert(fulfillmentEvents).values({
      orderId,
      type: 'review_released',
      message: `İnceleme onaylandı (${actor}) — teslimat başlatıldı`,
    });
    await this.db.insert(auditLog).values({
      action: 'assign',
      actor,
      targetType: 'order',
      targetId: orderId,
      meta: { op: 'review_release' },
    });

    const [fresh] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    return { orderId, released: true, status: fresh?.status ?? 'pending' };
  }

  /**
   * İnceleme kuyruğu REDDET (§8): held siparişi teslim ETMEDEN kapatır. Held siparişte hiç atama
   * yapılmadığından geri alınacak lisans YOK; satırlar 'canceled' işaretlenir → recompute 'revoked'
   * (tüm satırlar iptal) + değişim/yeniden-atama havuzuna girmez. Müşteri bir key ALMADI (mail/webhook
   * gönderilmemişti). WP sipariş durumunu bulkStatus poll'unda 'revoked' görür. audit + event izi.
   */
  async rejectHeld(orderId: string, reason: string, actor: string) {
    return this.db.transaction(async (tx) => {
      // #7 denetim (yarış + H1 tekrarı): advisory-lock altında CAS. release/refund ile yarışı
      // dışlar; İDEMPOTENT — kilit altında held DEĞİLSE (başka geçiş kazandı / zaten kapandı)
      // no-op döner (revokeOrderForSite held siparişi güvenle kapatmak için bunu çağırır).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${orderId}))`);
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1)
        .for('update');
      if (!order) throw new NotFoundException('Sipariş bulunamadı');
      if (!order.heldForReview) {
        return { orderId, rejected: false, status: order.status, alreadyClosed: true as const };
      }

      await tx
        .update(orders)
        .set({ heldForReview: false, updatedAt: new Date() })
        .where(eq(orders.id, orderId));
      // Held satırda normalde atama yoktur (createOrder held-dalı atama yapmaz); yine de bir yarış
      // bıraktıysa savunma amaçlı revoke et (kapasite/karantina getDeliveries filtresiyle birlikte
      // reddedilen siparişte canlı key kalmasını engeller).
      const activeAsgs = await tx
        .select({ id: assignments.id })
        .from(assignments)
        .where(and(eq(assignments.orderId, orderId), eq(assignments.status, 'active')));
      if (activeAsgs.length > 0) {
        await tx
          .update(assignments)
          .set({ status: 'revoked' })
          .where(and(eq(assignments.orderId, orderId), eq(assignments.status, 'active')));
      }
      // Satırlar terminal 'canceled' (yeniden-teslime uygun değil, §2) → recompute 'revoked'.
      await tx.update(orderLines).set({ canceled: true }).where(eq(orderLines.orderId, orderId));
      const s = await recomputeOrderStatus(tx, orderId);
      await tx.insert(fulfillmentEvents).values({
        orderId,
        type: 'review_rejected',
        message: `İnceleme reddedildi (${actor}): ${reason}`,
      });
      await tx.insert(auditLog).values({
        action: 'revoke',
        actor,
        targetType: 'order',
        targetId: orderId,
        meta: { op: 'review_reject', reason },
      });
      return { orderId, rejected: true, status: s };
    });
  }
}
