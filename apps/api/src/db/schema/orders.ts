import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { fulfillmentPolicyEnum, orderLineStatusEnum, orderStatusEnum } from './enums';
import { products } from './products';
import { sites } from './sites';

/**
 * orders — panele bildirilmiş sipariş (§3).
 * idempotency_key UNIQUE (site+order+line) → çifte satış imkânsız (§2).
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'restrict' }),
    remoteOrderId: text('remote_order_id').notNull(),
    customerEmail: text('customer_email').notNull(),
    status: orderStatusEnum('status').notNull().default('pending'),
    idempotencyKey: text('idempotency_key').notNull(),
    /**
     * Dinamik kota incelemesi (§8): true ise sipariş KABUL edildi ama teslimat manuel onaya
     * alındı — atama YAPILMAZ, autoComplete bu siparişi ATLAR, admin "İnceleme Kuyruğu"nda
     * Onayla (releaseHeld → completeLine) / Reddet (rejectHeld → satırlar canceled) eder.
     * status enum'a 'held_for_review' EKLENMEZ (boolean bayrak → enum migration'ı gerekmez,
     * status geçerli bir değer olarak 'pending' kalır; getDeliveries/recompute bozulmaz).
     */
    heldForReview: boolean('held_for_review').notNull().default(false),
    heldAt: timestamp('held_at', { withTimezone: true }),
    heldReason: text('held_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex('orders_idempotency_key_uniq').on(t.idempotencyKey),
    uniqueIndex('orders_site_remote_uniq').on(t.siteId, t.remoteOrderId),
    // Sipariş listesi/dashboard varsayılan sıralaması (en yeni önce) — createdAt DESC.
    index('orders_created_idx').on(t.createdAt.desc()),
    // Site-kapsamlı sipariş listesi (site scope + en yeni önce) tek index'ten karşılanır.
    index('orders_site_created_idx').on(t.siteId, t.createdAt.desc()),
    // İnceleme kuyruğu (§8): yalnız held siparişler — partial index küçük kalır (order_lines
    // pending_product_idx felsefesi), kuyruk listesi seq-scan yapmaz.
    index('orders_held_idx')
      .on(t.createdAt.desc())
      .where(sql`${t.heldForReview} = true`),
    // 0018'de eklenen fonksiyonel index (customers 360 case-insensitive e-posta grup/arama) prod'da
    // var ama schema'da DECLARE edilmemişti → drift. Burada tanımlanır ki schema tekrar TEK doğruluk
    // kaynağı olsun (#7 denetim M): db:generate 0020 CREATE üretir, prod'da IF NOT EXISTS ile no-op.
    index('orders_email_lower_idx').on(sql`lower(${t.customerEmail})`),
  ],
);

export const orderLines = pgTable(
  'order_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    // Eşlemesiz (unmapped) satırda null olabilir — sipariş kaybolmaz (§4).
    productId: uuid('product_id').references(() => products.id, { onDelete: 'restrict' }),
    remoteLineId: text('remote_line_id').notNull(),
    // Mağaza ürün kimliği/varyasyonu/adı (sipariş push'unda gelir) — eşleştirme doğrulaması +
    // "eşlenmemiş gelen ürünler" ekranı + izlenebilirlik için saklanır. Eski satırlarda/eski
    // eklentide NULL (geriye dönük uyumlu; teslimat mantığını ETKİLEMEZ — atama resolveMapping'den).
    remoteProductId: text('remote_product_id'),
    remoteVariationId: text('remote_variation_id'),
    remoteName: text('remote_name'),
    qty: integer('qty').notNull(),
    /**
     * TESLİMAT ANINDAKİ paket adedi (mapping.bundleQty) anlık görüntüsü — `qty`/`fulfilledQty`
     * hangi ölçekte yazıldığını sabitler. Eşleme SONRADAN pasifleştirilir/silinirse canlı
     * `resolveMapping` null döner; ölçeği oradan türeten yollar (reconcileOrder/syncRefunds)
     * bundleQty'yi sessizce 1'e düşürüp satırı "aşırı teslim" sanıyor ve müşterinin CANLI
     * anahtarlarını iade YOKKEN geri alıyordu. Artık ölçek satırdan okunur (migration 0025).
     * NULL = bilinmiyor: eşlemesiz satır (qty MAĞAZA birimindedir) ya da 0025 öncesi eski satır.
     */
    bundleQty: integer('bundle_qty'),
    fulfilledQty: integer('fulfilled_qty').notNull().default(0),
    status: orderLineStatusEnum('status').notNull().default('pending'),
    // İade/iptal terminal işareti (§2): revoke ile geri alınan satır TRUE olur ve otomatik/elle
    // yeniden teslime UYGUN DEĞİLDİR — aksi halde iade edilen satır taze key ile yeniden
    // doldurulup müşteriye bedava lisans verilirdi. status='pending'e dönse bile canceled kalır.
    canceled: boolean('canceled').notNull().default(false),
    // Sipariş bazlı politika ezme (§5) — null ise ürün politikası geçerli.
    policyOverride: fulfillmentPolicyEnum('policy_override'),
    priority: integer('priority').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Sipariş → satırlar birleştirmesi (detay, teslimat, recompute) FK'yi indexler.
    index('order_lines_order_idx').on(t.orderId),
    // Tamamlama motoru: ürün bazında bekleyen/kısmi + iptal-EDİLMEMİŞ satırları tarar.
    // Partial index → devasa geçmiş satır kümesinde yalnız "iş bekleyen" alt küme küçük kalır
    // (license_items_available_idx felsefesi). status IN (pending, partial) AND NOT canceled.
    index('order_lines_pending_product_idx')
      .on(t.productId)
      .where(sql`${t.status} IN ('pending', 'partial') AND ${t.canceled} = false`),
  ],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type OrderLine = typeof orderLines.$inferSelect;
export type NewOrderLine = typeof orderLines.$inferInsert;
