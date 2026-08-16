import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { AUDIT_ACTIONS, AuditService } from './audit.service';

/**
 * Query süzgeci doğrulayıcısı — `admin-orders.controller` ile BİREBİR aynı desen.
 * BOŞ string ("?action=") "süzgeç temizlendi" sayılır (admin UI seçimi sıfırlarken boş
 * parametre gönderir); dolu ise KURALA uymak zorunda. Girdi/çıktı tipi `string` kalır
 * (ZodBody jeneriği preprocess/transform ile uyumsuz olurdu) — dönüşüm handler'da yapılır.
 */
const blankOr = (check: (s: string) => boolean, message: string) =>
  z
    .string()
    .max(200)
    .refine((s) => s === '' || check(s), message)
    .optional();

/**
 * `GET /v1/admin/audit` süzgeçleri (§8 denetim izi). Hepsi opsiyonel; hiçbiri verilmezse
 * en yeni kayıtlar döner.
 *
 * NEDEN AÇIK 400 (sessiz yok sayma DEĞİL): geçersiz bir `?action=` değerini süzgeçsiz kabul
 * etmek TÜM denetim kayıtlarını listelerdi — operatör kapsamın daraltıldığını sanırken global
 * listeye bakardı. Aynı gerekçe `/customers` `siteId` doğrulamasında da yazılı. Ayrıca
 * doğrulamasız bir enum değeri Postgres 22P02 ile **500** üretir (ham hata sızar).
 */
export const ListAuditQuerySchema = z.object({
  /** Aktör KISMİ eşleşme — serbest metin; üst sınır log/gövde şişirmeye karşı. */
  actor: z.string().max(200).optional(),
  action: blankOr(
    (s) => (AUDIT_ACTIONS as readonly string[]).includes(s),
    `action şu değerlerden biri olmalı: ${AUDIT_ACTIONS.join(', ')}`,
  ),
  /**
   * Hedef türü (order/license_item/site…). Serbest metin AMA dar karakter kümesi: değerler
   * uygulamada üretilir, operatör yazmaz; kalıba uymayan girdi süzgeci sessizce boşaltırdı.
   */
  targetType: blankOr(
    (s) => /^[a-z_]{1,64}$/.test(s),
    'targetType yalnız küçük harf ve alt çizgi içerebilir',
  ),
  /** Hedef kimliği — UUID OLMAK ZORUNDA DEĞİL (ör. anonymize maskeli e-posta yazar). */
  targetId: z.string().max(200).optional(),
  traceId: z.string().max(200).optional(),
  from: blankOr((s) => !Number.isNaN(Date.parse(s)), 'from geçerli bir tarih olmalı'),
  to: blankOr((s) => !Number.isNaN(Date.parse(s)), 'to geçerli bir tarih olmalı'),
  page: blankOr((s) => /^\d{1,7}$/.test(s), 'page bir sayı olmalı'),
  // Aralık kırpması serviste (izinli sayfa boyutları) — çift doğrulama yerine tek kaynak.
  pageSize: blankOr((s) => /^\d{1,4}$/.test(s), 'pageSize bir sayı olmalı'),
});
type ListAuditQuery = z.infer<typeof ListAuditQuerySchema>;

/** '' / boşluk → undefined (süzgeç yok). */
const trimmed = (v?: string): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};

/**
 * Admin: denetim izi (§8). ADMIN_TOKEN gerektirir.
 *
 * ── YETKİ / MASKELEME KARARI ──────────────────────────────────────────────────
 * `AdminGuard` YETERLİ; `@AdminRole` + `canRevealPlaintext` ile owner-only maskeleme
 * UYGULANMADI. Gerekçe (koda bakılarak verildi, tahminle değil):
 *
 *  1. `audit_log.meta` sözleşme gereği DÜZ-METİN SIR TAŞIMAZ (şema yorumu: "Ek bağlam
 *     — redakteli — payload düz metin ASLA girmez"). Yazma noktalarının TAMAMI tarandı
 *     (bu tarama yapıldığında `insert(auditLog)` 9 dosyada 32 çağrıydı; eski yorum "30"
 *     diyordu — sayı sonradan artmıştı, güncel sayı `grep -rn "insert(auditLog)"` ile
 *     doğrulanabilir ve yeni bir yazar eklendiğinde bu değerlendirme TEKRARLANMALIDIR):
 *     meta yalnız sayaç, uuid, enum, sebep metni ve tedarik alan adları taşıyor. Arama
 *     METNİ bile bilerek yazılmıyor (kısmi anahtar olabilir diye) — `stock.service` ve
 *     `admin-orders.service` bunu açıkça not ediyor.
 *  2. `canRevealPlaintext` kapısının konusu SIR gösterimidir (lisans anahtarı / hesap
 *     parolası). Burada gösterilecek bir sır yok; kapıyı yine de koymak, denetim izini
 *     owner-olmayan operatöre delik gösterirdi ve ekranın VARLIK SEBEBİNİ (hesap
 *     verebilirlik) zayıflatırdı.
 *  3. Tek PII-benzeri değerler: `site_update` meta'sındaki `senderEmail`/`webhookUrl`
 *     (MAĞAZA yapılandırması — /sites ekranında zaten her admin'e açık) ve `anonymize`
 *     kaydının `targetId`'si (KVKK gereği ZATEN maskeli yazılıyor). Müşteri e-postası
 *     hiçbir yazar tarafından meta'ya konmuyor.
 *
 * Buna rağmen savunma-derinliği olarak servis, meta'da sır ÇAĞRIŞTIRAN anahtar adlarını
 * (`password`, `payload`, `token`…) `[gizlendi]` ile değiştirir — bugün no-op, yarın
 * eklenecek bir yazar için kapı (bkz. `SENSITIVE_META_KEY_RE`).
 *
 * APPEND-ONLY: bu controller'da YALNIZ `@Get` var. Denetim izine yazma/silme/düzeltme ucu
 * bilinçli olarak YOK.
 */
@Controller('admin/audit')
@UseGuards(AdminGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@Query(new ZodBody(ListAuditQuerySchema)) query: ListAuditQuery) {
    return this.audit.list({
      actor: trimmed(query.actor),
      action: trimmed(query.action),
      targetType: trimmed(query.targetType),
      targetId: trimmed(query.targetId),
      traceId: trimmed(query.traceId),
      from: trimmed(query.from),
      to: trimmed(query.to),
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }
}
