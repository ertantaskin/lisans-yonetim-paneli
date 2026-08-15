import { z } from 'zod';
import { OrderLineStatus, OrderStatus, ProductKind } from '../domain/enums';

/**
 * /v1/orders sözleşmesi (§4). Eklenti sipariş bildirir; panel atomik atama yapıp
 * assignment listesi döner.
 *
 *   201 fully_fulfilled · 207 partial_fulfillment · 202 pending_stock
 *
 * Idempotency-Key = site+order+line (UNIQUE) — tekrar gelen istek yeni atama
 * yapmaz, mevcut cevabı döner.
 */

// ── İstek ───────────────────────────────────────────────────────────────────
export const CreateOrderLine = z.object({
  /** Eklenti tarafındaki satır kimliği (idempotency parçası). */
  remoteLineId: z.string().min(1).max(200),
  remoteProductId: z.string().min(1).max(200),
  // İstemciler varyasyonsuz üründe null gönderebilir — undefined/null ikisi de kabul.
  remoteVariationId: z.string().min(1).max(200).nullish(),
  /** Mağaza ürün adı (opsiyonel — eski eklenti göndermez). Panel eşleştirme doğrulaması +
   *  "eşlenmemiş gelen ürünler" ekranı için saklar; teslimat mantığını ETKİLEMEZ.
   *  KRİTİK: kritik-olmayan bu alan siparişi ASLA reddetmemeli → max() ile 400 atmak yerine
   *  255'e KIRP (astral/emoji ad UTF-16 birim ≠ WP mb_substr kod-noktası; denetim LOW); hatalı
   *  tip → null'a düş (.catch), sipariş yine teslim edilir. */
  remoteName: z
    .string()
    .transform((s) => s.slice(0, 255))
    .nullish()
    .catch(null),
  // Üst sınır (DoS + int4 taşması savunması): qty tek kalemde makul bir tavana bağlanır.
  // Kardeş site-facing DTO'lar (SyncRefunds .max(200), BulkStatus .max(100)) zaten kaplı;
  // sınırsız qty hem tek transaction'da devasa atama işi hem int4 overflow → 500 üretiyordu.
  qty: z.number().int().positive().max(100000),
  /** Ürün varsayılan politikasını sipariş bazında ezme (opsiyonel). */
  policyOverride: z.enum(['partial-auto', 'partial-approval', 'all-or-nothing']).optional(),
});
export type CreateOrderLine = z.infer<typeof CreateOrderLine>;

export const CreateOrderRequest = z.object({
  remoteOrderId: z.string().min(1).max(200),
  customerEmail: z.string().email().max(320),
  // Üst sınır: tek siparişte satır sayısı tavana bağlı (hedefli DoS savunması — createOrder
  // her satırı tek transaction'da işler; sınırsız satır kritik teslimat yolunu tıkayabilirdi).
  lines: z.array(CreateOrderLine).min(1).max(200),
});
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

// ── Yanıt ───────────────────────────────────────────────────────────────────
export const AssignmentResult = z.object({
  assignmentId: z.string().uuid(),
  remoteLineId: z.string(),
  units: z.number().int().positive(),
  validUntil: z.string().datetime().nullable(),
});
export type AssignmentResult = z.infer<typeof AssignmentResult>;

export const OrderLineResult = z.object({
  remoteLineId: z.string(),
  status: OrderLineStatus,
  requestedQty: z.number().int().nonnegative(),
  fulfilledQty: z.number().int().nonnegative(),
});
export type OrderLineResult = z.infer<typeof OrderLineResult>;

export const CreateOrderResponse = z.object({
  orderId: z.string().uuid(),
  status: OrderStatus,
  assignments: z.array(AssignmentResult),
  lines: z.array(OrderLineResult),
  /**
   * Dinamik satış kotası incelemesi (§8): sipariş KABUL edildi ama teslimat manuel onaya
   * alındı (held_for_review) — atama YAPILMADI, admin "İnceleme Kuyruğu"nda Onayla/Reddet
   * eder. Opsiyonel: yalnız held siparişte true; klasik akış alanı hiç göndermez (geriye
   * dönük uyumlu — eski WP istemcisi yok sayar). HTTP durumu 202 (pending_stock ile aynı).
   */
  held: z.boolean().optional(),
});
export type CreateOrderResponse = z.infer<typeof CreateOrderResponse>;

/** §4 HTTP durum → anlam eşlemesi. */
export const ORDER_HTTP_STATUS = {
  fullyFulfilled: 201,
  partialFulfillment: 207,
  pendingStock: 202,
  alreadyProcessed: 409,
  mappingNotFound: 404,
  invalidSignature: 401,
} as const;

// ── Teslimat (GET /v1/orders/:id/deliveries) — müşteri görünümü (§4, §7) ─────
/** Hesap ürünü teslimat alanı (değer dâhil; müşteri kendi lisansını görür). */
export const DeliveryField = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  secret: z.boolean(),
});
export type DeliveryField = z.infer<typeof DeliveryField>;

export const DeliveryItem = z.object({
  assignmentId: z.string().uuid(),
  remoteLineId: z.string(),
  units: z.number().int().positive(),
  validUntil: z.string().datetime().nullable(),
  /**
   * Süre doldu mu (valid_until < now). onExpiry='hide' ürünlerde süresi geçen teslimat
   * yanıttan tamamen çıkarılır (bu bayrak yalnız onExpiry='keep' için true görülebilir).
   */
  expired: z.boolean(),
  /** Ürün tipi — WP eklentisi/admin buna göre render dallanır. */
  kind: ProductKind,
  /** key/code/custom için düz payload; account'ta null (fields kullanılır). */
  payload: z.string().nullable(),
  /** account için yapılandırılmış alanlar; diğer tiplerde null. */
  fields: z.array(DeliveryField).nullable(),
  /**
   * Bu kalemin ürününe bağlı kurulum/etkinleştirme rehberinin kimliği (§7); rehber yoksa null.
   *
   * Rehberin METNİ burada TAŞINMAZ — yanıtın üst düzeyindeki `guides` dizisinde BİR KEZ
   * bulunur. Aynı rehber 10 anahtara bağlıysa 4.000 karakterlik metni 10 kez göndermek,
   * mağaza sayfasını 5 sn zaman aşımıyla senkron render eden bu ucu gereksiz yorardı.
   */
  guideId: z.string().uuid().nullable().optional(),
});
export type DeliveryItem = z.infer<typeof DeliveryItem>;

/** Teslimatla birlikte gönderilen kurulum rehberi — panel tarafında render edilmiştir. */
export const DeliveryGuide = z.object({
  id: z.string().uuid(),
  title: z.string(),
  /**
   * Güvenli HTML (yalnız h4/p/ol/ul/li/strong/a/br; ham girdi kaçırılmıştır).
   * Mağaza eklentisi bunu KENDİ `wp_kses` allow-list'iyle ikinci kez süzer.
   */
  html: z.string(),
  /** Düz metin karşılığı — .txt indirme ve panel dışı yüzeyler için. */
  text: z.string(),
});
export type DeliveryGuide = z.infer<typeof DeliveryGuide>;

export const DeliveriesResponse = z.object({
  orderId: z.string().uuid(),
  status: OrderStatus,
  deliveries: z.array(DeliveryItem),
  /** §8 İnceleme Kuyruğu — sipariş yönetici onayı bekliyor (WP "doğrulanıyor" bandı). */
  held: z.boolean().optional(),
  /** En güncel teslimat maili durumu (sent|failed|…); yoksa null (WP bounce bandı). */
  mailStatus: z.string().nullable().optional(),
  /** §7 müşteri durum matrisi — kısmi ilerleme göstergesi: teslim edilen / toplam BİRİM. */
  fulfilled: z.number().int().nonnegative().optional(),
  total: z.number().int().nonnegative().optional(),
  /** §7 — bu siparişte askıya alınmış (suspended) atama var (müşteriye "inceleme altında"). */
  suspended: z.boolean().optional(),
  /** §7 — onExpiry='hide' ürünün süresi geçmiş ataması vardı (müşteriye "süreniz doldu"). */
  expiredHidden: z.boolean().optional(),
  /**
   * §7 kurulum/etkinleştirme rehberleri — siparişteki ürünlere bağlı, TEKRARSIZ liste.
   * Teslimat kalemleri `guideId` ile buraya bağlanır. Rehberi olmayan siparişte boş dizi
   * (alan hiç gelmeyebilir → eski panel sürümüne karşı okuyucular savunmacı davranmalı).
   */
  guides: z.array(DeliveryGuide).optional(),
});
export type DeliveriesResponse = z.infer<typeof DeliveriesResponse>;
