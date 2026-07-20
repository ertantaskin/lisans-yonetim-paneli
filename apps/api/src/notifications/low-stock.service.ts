import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { NotificationsService } from './notifications.service';

export const LOW_STOCK_QUEUE = 'low-stock';
/** Düşük stok taraması periyodu (ms). Anlık kritik değil → 30 dk yeterli (§12). */
const SWEEP_EVERY_MS = 30 * 60 * 1000;
/** Aynı ürün için tekrarlı 'low_stock' bildirim susturma penceresi (saat). */
const DEDUPE_WINDOW_HOURS = 12;

type LowStockRow = {
  product_id: string;
  sku: string;
  name: string;
  available: number;
  threshold: number;
};

/**
 * Düşük stok tespiti (§12). low_stock_threshold IS NOT NULL ürünler için anlık
 * 'available' stok (products.service.list() ile AYNI mantık: max_uses - use_count,
 * status='available' filtreli) eşiğin altına inince 'low_stock' bildirimi üretir.
 * Son 12 saatte aynı ürün için bildirim varsa DEDUPE ile tekrar üretmez (spam yok).
 */
@Injectable()
export class LowStockService implements OnModuleInit {
  private readonly logger = new Logger(LowStockService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(LOW_STOCK_QUEUE) private readonly queue: Queue,
    private readonly notifications: NotificationsService,
  ) {}

  /** Boot'ta tekrarlı taramayı kaydeder (aynı repeat anahtarı → mükerrer eklenmez). */
  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'sweep',
      {},
      { repeat: { every: SWEEP_EVERY_MS }, removeOnComplete: 50, removeOnFail: 50 },
    );
  }

  /**
   * Eşiğin altına inen ürünler için 'low_stock' bildirimi üretir (dedupe'lu).
   * @returns yeni oluşturulan bildirim sayısı
   */
  async checkLowStock(): Promise<number> {
    // available: products.service.list() ile aynı — coalesce(sum(max_uses-use_count)
    // FILTER status='available'). GROUP BY p.id (pk) → HAVING p.low_stock_threshold'a erişebilir.
    const rows = (await this.db.execute<LowStockRow>(sql`
      SELECT
        p.id AS product_id,
        p.sku AS sku,
        p.name AS name,
        p.low_stock_threshold AS threshold,
        COALESCE(SUM(li.max_uses - li.use_count) FILTER (WHERE li.status = 'available'), 0)::int
          AS available
      FROM products p
      LEFT JOIN license_items li ON li.product_id = p.id
      WHERE p.low_stock_threshold IS NOT NULL
      GROUP BY p.id
      HAVING COALESCE(SUM(li.max_uses - li.use_count) FILTER (WHERE li.status = 'available'), 0)
        <= p.low_stock_threshold;
    `)) as unknown as LowStockRow[];

    let created = 0;
    for (const r of rows) {
      const available = Number(r.available);
      const threshold = Number(r.threshold);

      // Dedupe: son 12 saatte aynı ürün için 'low_stock' bildirimi varsa atla.
      if (await this.recentlyNotified(r.product_id)) continue;

      await this.notifications.create({
        type: 'low_stock',
        severity: 'warning',
        title: `Düşük stok: ${r.name}`,
        message: `${r.sku} — kalan stok ${available}, eşik ${threshold}. Yeni stok girişi gerekli.`,
        meta: { productId: r.product_id, sku: r.sku, available, threshold },
      });
      created += 1;
    }

    if (created > 0) this.logger.log(`Düşük stok: ${created} bildirim üretildi`);
    return created;
  }

  /** Son DEDUPE_WINDOW_HOURS içinde bu ürün için 'low_stock' bildirimi var mı? */
  private async recentlyNotified(productId: string): Promise<boolean> {
    const rows = (await this.db.execute<{ hit: number }>(sql`
      SELECT 1 AS hit
      FROM notifications
      WHERE type = 'low_stock'
        AND meta->>'productId' = ${productId}
        AND created_at > now() - (${DEDUPE_WINDOW_HOURS} * interval '1 hour')
      LIMIT 1;
    `)) as unknown as Array<{ hit: number }>;
    return rows.length > 0;
  }
}
