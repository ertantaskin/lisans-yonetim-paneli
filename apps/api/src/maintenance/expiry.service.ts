import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';

export const EXPIRY_QUEUE = 'expiry';
/** Süre-bitişi taraması periyodu (ms). Boşluk savunma amaçlı getDeliveries filtresiyle kapalı. */
const SWEEP_EVERY_MS = 5 * 60 * 1000;

/**
 * Süreli hesap süre-bitişi motoru (§11). valid_until'i geçmiş AKTİF atamaları,
 * ürünün onExpiry politikası 'hide' ise 'expired'a çeker → getDeliveries artık
 * göstermez, payload sızmaz. onExpiry='keep' ürünler 'active' kalır (süre sonrası
 * da görünür; getDeliveries 'expired' bayrağı verir).
 *
 * Not: expired atamanın license_item'ı serbest BIRAKILMAZ ("iade edilen hak otomatik
 * dönmez", §2) — geri kazanım admin recall'ıyla olur. Kiralık-slot kapasite dönüşü ayrı iş.
 */
@Injectable()
export class ExpiryService implements OnModuleInit {
  private readonly logger = new Logger(ExpiryService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(EXPIRY_QUEUE) private readonly queue: Queue,
  ) {}

  /** Boot'ta tekrarlı tarama işini kaydeder (aynı repeat anahtarı → mükerrer eklenmez). */
  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'sweep',
      {},
      { repeat: { every: SWEEP_EVERY_MS }, removeOnComplete: 50, removeOnFail: 50 },
    );
  }

  /**
   * Süresi geçmiş (onExpiry='hide') aktif atamaları 'expired' yapar.
   * @returns expired'a çekilen atama sayısı
   */
  async sweepExpired(): Promise<number> {
    const rows = await this.db.execute<{ id: string }>(sql`
      UPDATE assignments a
      SET status = 'expired'
      FROM order_lines ol
      JOIN products p ON p.id = ol.product_id
      WHERE a.line_id = ol.id
        AND a.status = 'active'
        AND a.valid_until IS NOT NULL
        AND a.valid_until < now()
        AND p.on_expiry = 'hide'
      RETURNING a.id;
    `);
    const count = (rows as unknown as Array<{ id: string }>).length;
    if (count > 0) this.logger.log(`Süre-bitişi: ${count} atama expired'a çekildi`);
    return count;
  }
}
