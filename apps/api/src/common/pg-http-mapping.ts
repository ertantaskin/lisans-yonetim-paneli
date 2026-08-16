import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { pgErrorCode } from '../db/pg-error';

/**
 * HAM Postgres hatası → ANLAMLI HTTP yanıtı (SQLSTATE çevirisi) — SAF KURAL.
 *
 * NEDEN AYRI DOSYA: bu kural `PgExceptionFilter`'ın içinde yaşıyordu, ama filtre
 * `SentryExceptionFilter`'ı genişlettiği için modülü `@sentry/node`'u da yüklüyor. Kuralın
 * birim testi o zincirin tamamını ayağa kaldırmak zorunda kalıyordu (ve bir kurulumda
 * OpenTelemetry çözümlemesi yüzünden HİÇ koşamadı — test SESSİZCE hiçbir şeyi korumazdı).
 * Saf kural burada, framework kablolaması filtrede: test yalnız bu dosyayı yükler.
 *
 * NEDEN VAR (asıl gerekçe): kod tabanında SQLSTATE → 4xx çevirimi HİÇBİR YERDE merkezî
 * değildi. Tek tük servisler kendi sıcak yollarında `isUniqueViolation` yakalıyordu
 * (kategori/rehber/admin), geri kalan HER yazma yolu ham sürücü hatasını Nest'in varsayılan
 * işleyicisine bırakıyordu → operatör "Internal server error" görüyor, ne olduğunu ve ne
 * yapacağını anlamıyor, log okumadan teşhis imkânsız oluyordu. En kolay tetiklenenler:
 * mükerrer SKU (23505), silinmiş tedarikçi/ürün id'si (23503), bozuk UUID (22P02), int4
 * taşması (22003) ve yoğunlukta sorgu/kilit zaman aşımı (57014/55P03).
 *
 * KAPSAM DAR TUTULDU — yalnız İSTEMCİ GİRDİSİNDEN doğabilecek ve operatörün bir sonraki
 * adımını belirleyen kodlar çevrilir. Sunucu kusurunu gösteren kodlar (23502 not_null,
 * 42703 undefined_column…) BİLEREK 500 kalır: onlar için doğru davranış Sentry'ye düşüp
 * düzeltilmektir, kullanıcıya "girdiniz hatalı" demek DEĞİL.
 *
 * SIR/PII SIZMAZ: PG'nin kendi hata metni (`Key (sku)=(…) already exists`, `detail`) yanıta
 * ASLA konmaz; mesajlar sabit Türkçe metinlerdir. SQLSTATE + kısıt adı yalnız LOG'a yazılır.
 */

/** Çeviri sonucu — saf veri, böylece DB/HTTP olmadan birim testi yazılabilir. */
export interface PgHttpMapping {
  status: number;
  message: string;
  /** Doluysa yanıta `Retry-After` (saniye) başlığı basılır — geçici arıza sinyali. */
  retryAfterSec?: number;
}

/**
 * Geçici (yeniden denenebilir) arızalarda önerilen bekleme. 5 sn bilinçli olarak
 * `lock_timeout` (10 sn) / `statement_timeout` (30 sn) mertebesinde DEĞİL: amaç istemcinin
 * hemen ardından tekrar denemesini biraz geciktirip kilidi tutan işleme pencere bırakmak.
 */
const RETRY_AFTER_SEC = 5;

/**
 * 23503 iki AYRI durumu taşır ve ikisinin HTTP karşılığı zıttır:
 *   · INSERT/UPDATE'te ATA satır yok         → istemci var olmayan bir id gönderdi → 404
 *   · DELETE'te satır hâlâ REFERANS ediliyor → kayıt kullanımda, silinemez          → 409
 * Postgres ikisini de aynı kodla verir; ayrım yalnız hata METNİNDE ("is still referenced
 * from table") görünür. Metin okunur ama YANITA GİRMEZ (yalnız dal seçimini belirler) —
 * yanlış eşleşmede sonuç 404 olur, yani daha temkinli tarafa düşülür.
 */
const STILL_REFERENCED_RE = /still referenced from table/i;

/** Hata zincirindeki metinleri (message + detail) birleştirir — yalnız dal seçimi için. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur != null && depth < 5; depth += 1) {
    const rec = cur as { message?: unknown; detail?: unknown; cause?: unknown };
    if (typeof rec.message === 'string') parts.push(rec.message);
    if (typeof rec.detail === 'string') parts.push(rec.detail);
    cur = rec.cause;
  }
  return parts.join(' | ');
}

/**
 * SQLSTATE → HTTP eşlemesi. Eşlenmeyen (ya da PG olmayan) hata için `null` → çağıranın
 * davranışı DEĞİŞMEZ (500 + Sentry).
 *
 * NOT — `isUniqueViolation`'ın METİN YEDEĞİ burada BİLEREK KULLANILMAZ: o yedek "kod
 * okunamıyorsa metne bak" diyerek dar bir serviste anlamlıdır, ama bu kural GLOBAL bir
 * catch-all'da uygulanır; içinde 'unique constraint' geçen ilgisiz bir hata (ör. üçüncü
 * parti bir kütüphanenin mesajı) sessizce 409'a çevrilirdi. Global katmanda yalnız SQLSTATE
 * otoriterdir.
 */
export function pgHttpMapping(err: unknown): PgHttpMapping | null {
  const code = pgErrorCode(err);
  if (!code) return null;

  switch (code) {
    // unique_violation — aynı benzersiz değeri taşıyan ikinci kayıt.
    case '23505':
      return {
        status: 409,
        message:
          'Bu kayıt zaten var: benzersiz olması gereken bir alan (ör. SKU, ad, e-posta) ' +
          'başka bir kayıtta kullanılıyor. Farklı bir değerle tekrar deneyin.',
      };

    // foreign_key_violation — bkz. STILL_REFERENCED_RE.
    case '23503':
      return STILL_REFERENCED_RE.test(errorText(err))
        ? {
            status: 409,
            message:
              'Bu kayıt başka kayıtlar tarafından kullanıldığı için silinemez. ' +
              'Önce ona bağlı kayıtları kaldırın ya da başka bir kayda taşıyın.',
          }
        : {
            status: 404,
            message:
              'İşlemde başvurulan kayıt bulunamadı (silinmiş olabilir). ' +
              'Sayfayı yenileyip listeden güncel bir kayıt seçin.',
          };

    // numeric_value_out_of_range — int4 tavanını (2.147.483.647) aşan sayı.
    case '22003':
      return {
        status: 400,
        message:
          'Girilen sayı çok büyük; veritabanının tam sayı sınırını aşıyor. ' +
          'Daha küçük bir değer girin.',
      };

    // string_data_right_truncation — 22003'ün metin kardeşi (kolon uzunluğu aşıldı).
    case '22001':
      return {
        status: 400,
        message:
          'Girilen metin çok uzun; bu alanın izin verdiği karakter sınırını aşıyor. ' +
          'Kısaltıp tekrar deneyin.',
      };

    // invalid_text_representation — çoğunlukla UUID/enum/sayı olmayan bir değerin kolon
    // tipine cast edilmesi (bozuk id ile açılan bağlantı, elle düzenlenmiş adres).
    case '22P02':
      return {
        status: 400,
        message:
          'Geçersiz kimlik veya değer biçimi. Adresteki kimlik bozuk olabilir; ' +
          'kaydı listeden tekrar açın.',
      };

    // query_canceled — `statement_timeout` (30sn) devreye girdi.
    case '57014':
      return {
        status: 503,
        message:
          'İşlem zaman aşımına uğradı (sorgu 30 saniyeyi aştı). Sistem şu an yoğun olabilir; ' +
          'birkaç saniye sonra tekrar deneyin. Tekrarlıyorsa süzgeci/tarih aralığını daraltın.',
        retryAfterSec: RETRY_AFTER_SEC,
      };

    // lock_not_available — `lock_timeout` (10sn): satır/advisory kilidi başka işlemde.
    case '55P03':
      return {
        status: 503,
        message:
          'Bu kayıt şu anda başka bir işlem tarafından kilitli (kilit bekleme süresi doldu). ' +
          'Hiçbir değişiklik yazılmadı; birkaç saniye sonra tekrar deneyin.',
        retryAfterSec: RETRY_AFTER_SEC,
      };

    // deadlock_detected + serialization_failure — operatör açısından AYNI durum: işlem
    // tamamen geri alındı, doğru davranış TEKRAR DENEMEK. 40001, 40P01 ile birebir aynı sınıf.
    case '40P01':
    case '40001':
      return {
        status: 409,
        message:
          'Eşzamanlı bir işlemle çakışıldı ve işlem geri alındı (hiçbir değişiklik yazılmadı). ' +
          'Lütfen tekrar deneyin.',
      };

    default:
      return null;
  }
}

/** Eşlemeyi Nest istisnasına çevirir — yanıt gövdesi diğer 4xx'lerle AYNI şekilde olsun. */
export function pgHttpException(mapping: PgHttpMapping): HttpException {
  switch (mapping.status) {
    case 400:
      return new BadRequestException(mapping.message);
    case 404:
      return new NotFoundException(mapping.message);
    case 409:
      return new ConflictException(mapping.message);
    case 503:
      return new ServiceUnavailableException(mapping.message);
    default:
      return new HttpException(mapping.message, mapping.status);
  }
}
