/**
 * Ürün/stok tarafının PAYLAŞILAN sayısal tavanları.
 *
 * NEDEN AYRI DOSYA (ölçülmüş risk): bu sabitler önce `products.controller` ve `stock.service`
 * içinde yaşıyordu ve birbirlerini import ediyorlardı →
 *   products.controller → stock.service (KEY_FORMAT_MAX_LENGTH)
 *   stock.service/controller → products.controller (MAX_USES_CAP)
 * yani DÖNGÜSEL import. API CommonJS'e derlendiği için döngüde ikinci yüklenen modül KISMİ
 * `exports` görür: sabit `undefined` gelir. İkisi de modül-YÜKLEME anında zod şeması kuruyor
 * (`.max(SABIT)`) ve zod `.max(undefined)` çağrısında sınırı SESSİZCE uygulamaz — hata yok,
 * log yok, yalnız kapı açılır. Kapatılan şey önemsiz değil: `KEY_FORMAT_MAX_LENGTH`
 * katastrofik-backtracking regex'iyle tüm API'yi dondurabilen bir DoS yüzeyini sınırlar.
 *
 * Bugün patlamıyordu çünkü `app.module` ProductsModule'ü StockModule'den ÖNCE yüklüyor —
 * ama bu bir TESADÜF, invaryant değil: app.module'de iki satırın yer değiştirmesi ya da
 * stock.service'i önce çeken yeni bir import sınırı sessizce devre dışı bırakırdı.
 *
 * Sabitleri yaprak (bağımlılıksız) bir modülde tutmak döngüyü yapısal olarak imkânsız kılar.
 * Aynı çözüm panelde de uygulanmıştı (`lib/categories.ts`, `lib/license-page-sizes.ts`).
 */

/**
 * Çok kullanımlı (MAK) ürün/kalem için en yüksek kullanım hakkı.
 *
 * Hem ürün formundaki `maxUses` hem de kalem bazlı kapasite düzeltmesi bu tavana bağlıdır:
 * iki ayrı tavan tutmak, bu kod tabanında tekrar tekrar görülen "aynı kavramın iki yüklemi"
 * hatasıdır. Tavan olmadan tek satırla "1 anahtar = 2 milyar birim" yazılıp Σ(max_uses −
 * use_count) tabanlı TÜM stok sayaçları anlamsızlaştırılabilirdi.
 */
export const MAX_USES_CAP = 100_000;

/** `keyFormat` regex deseninin en fazla uzunluğu (ReDoS yüzeyini sınırlar). */
export const KEY_FORMAT_MAX_LENGTH = 200;
