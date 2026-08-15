import { sql } from 'drizzle-orm';
import { bigserial, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orders } from './orders';

/**
 * fulfillment_events — sipariş timeline'ı (§3). Panel + WP meta box'ta gösterilir.
 * Örn: order_received, partially_fulfilled, fulfilled, resent, revoked.
 */
export const fulfillmentEvents = pgTable(
  'fulfillment_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    message: text('message'),
    meta: jsonb('meta'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),

    /**
     * EKLEME SIRASI — monoton artan (sequence). Zaman çizelgesinde `created_at`'in tie-break'i.
     *
     * NEDEN GEREKLİ (ÖLÇÜLDÜ): bir siparişin olayları TEK transaction'da yazılır (`createOrder`
     * önce `order_received`, sonra `fulfilled`/`partially_fulfilled`/`pending_stock` ekler) ve
     * `now()` transaction başlangıcını döndürdüğü için damgalar BİREBİR AYNIDIR. Dev verisinde
     * aynı damgayı paylaşan 7.200 olay grubu sayıldı — `fulfilled + line_completed + revoked`
     * üçlüleri dahil. Sıralama yalnız `created_at` ile yapıldığı sürece bu olaylar KEYFİ sırada
     * dönüyordu: sipariş detayında "Geri alındı" satırı "Sipariş tamamlandı"nın ÜSTÜNDE
     * görünebiliyor ve sıra sayfa yenilendikçe değişebiliyordu. Denetim izi niteliğindeki bir
     * ekranda bu, olayların nedensel sırasını yanlış anlatır.
     *
     * `id` (uuid v4) tie-break olarak YETMEZ: kararlı olur ama sıra yine rastgeledir —
     * `license_items.seq` için aynı gerekçeyle alınan karar (migration 0030) burada tekrarlanır.
     *
     * GEÇMİŞ SATIRLAR: değerler heap FİZİKSEL sırasıyla dolar. `fulfillment_events` yalnız
     * INSERT alır (hiçbir kod yolu UPDATE etmez) → pratikte ekleme sırasına eşittir; yine de
     * KESİN garanti bu migration SONRASI yazılan satırlar içindir.
     */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('fulfillment_events_order_idx').on(t.orderId, t.createdAt),
    // Saklama/budama (retention) sıcak yolu: RetentionService created_at'e göre eski satırları
    // batch'ler halinde siler. Mevcut order_idx (order_id, created_at) prefiksi order_id olduğu
    // için `WHERE created_at < X` taramasını KARŞILAMAZ → ayrı created_at index'i gerekir
    // (migration 0029). fulfillment_events ~2×sipariş hızında büyür; index'siz her prune tam-tablo tarar.
    index('fulfillment_events_created_idx').on(t.createdAt),
  ],
);

export type FulfillmentEvent = typeof fulfillmentEvents.$inferSelect;
export type NewFulfillmentEvent = typeof fulfillmentEvents.$inferInsert;
