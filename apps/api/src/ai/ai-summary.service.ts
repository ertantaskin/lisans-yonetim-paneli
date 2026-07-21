import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { AiService } from './ai.service';

/**
 * Günlük operasyon metrikleri (§15). Salt-okunur sayımlar — yan etki yok.
 * Bu sayılar HER ZAMAN hesaplanır (AI kapalı olsa bile).
 */
export interface DailyMetrics {
  /** Bugün (yerel gün başından beri) oluşturulan sipariş sayısı. */
  todayOrders: number;
  /** Açık (status='open') değişim/garanti talebi sayısı. */
  openReplacements: number;
  /** Son 24 saatte düşen güvenlik olayı sayısı. */
  securityEvents24h: number;
  /** Başarısız (veya askıda kalıp denemesi tükenmiş) webhook outbox olayı sayısı. */
  failedOutbox: number;
  /**
   * Atanabilir kalan KAPASİTE (Σ max_uses−use_count, status='available'). MULTI/MAK
   * ürünlerde satır sayısı DEĞİL — products.service/channel-catalog ile aynı semantik.
   */
  availableStock: number;
}

/** Günlük özet yanıtı (§15). Metrikler her zaman; AI paragrafı yalnız AI açıkken. */
export interface DailySummary {
  metrics: DailyMetrics;
  /** AI'nın Türkçe anomali yorumu; AI kapalı veya hata olduysa null (GRACEFUL). */
  paragraph: string | null;
  aiEnabled: boolean;
}

/**
 * AiSummaryService — günlük operasyon özeti + AI anomali paragrafı (§15).
 *
 * İlke: operasyon metrikleri HER ZAMAN döner (basit salt-okunur sayımlar). AI açıksa
 * bu sayıları yorumlayan kısa bir TÜRKÇE "anomali paragrafı" üretilir; AI kapalı ya da
 * çağrı patlarsa paragraph=null döner ve metrikler yine teslim edilir (503 ATILMAZ).
 *
 * Modele YALNIZ maskesiz sayılar gider — lisans payload/sır asla gönderilmez (§15).
 */
@Injectable()
export class AiSummaryService {
  private readonly logger = new Logger(AiSummaryService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ai: AiService,
  ) {}

  /** Günlük metrikleri toplar; AI açıksa anomali paragrafı ekler (graceful). */
  async dailySummary(): Promise<DailySummary> {
    const metrics = await this.collectMetrics();
    const aiEnabled = this.ai.enabled();

    if (!aiEnabled) {
      return { metrics, paragraph: null, aiEnabled: false };
    }

    let paragraph: string | null = null;
    try {
      paragraph = await this.ai.complete({
        system:
          'Sen bir lisans dağıtım panelinin operasyon asistanısın. Sana günlük ' +
          'metrikleri JSON olarak verilir. Bu sayıları yorumlayan, dikkat çekici ' +
          'sapmaları (yüksek başarısız webhook, biriken açık talep, düşük stok, ' +
          'olağandışı güvenlik olayı yoğunluğu vb.) vurgulayan KISA bir Türkçe ' +
          'paragraf yaz (en fazla 3-4 cümle). Sayı uydurma, yalnız verilenleri yorumla. ' +
          'Her şey normalse bunu sakince belirt. Madde işareti kullanma, düz metin yaz.',
        user: JSON.stringify(metrics),
        maxTokens: 512,
      });
    } catch (err) {
      // AI patlasa bile metrikler teslim edilsin — özet hizmeti AI'sız çalışmayı sürdürür.
      this.logger.warn(`AI anomali paragrafı üretilemedi: ${(err as Error).message}`);
      paragraph = null;
    }

    return { metrics, paragraph, aiEnabled: true };
  }

  /**
   * Beş operasyon sayacını tek salt-okunur sorguda toplar (skaler alt sorgular).
   * failedOutbox: status='failed' VEYA 15dk+ askıda kalmış pending (deneme tükenmiş)
   * — ops dead-letter tanımıyla aynı "sorunlu outbox" semantiği (§16).
   */
  private async collectMetrics(): Promise<DailyMetrics> {
    const rows = await rawRows<{
      today_orders: number;
      open_replacements: number;
      security_events_24h: number;
      failed_outbox: number;
      available_stock: number;
    }>(this.db, sql`
      SELECT
        (SELECT count(*) FROM orders
           WHERE created_at >= date_trunc('day', now()))::int AS today_orders,
        (SELECT count(*) FROM replacement_requests
           WHERE status = 'open')::int AS open_replacements,
        (SELECT count(*) FROM security_events
           WHERE created_at >= now() - interval '24 hours')::int AS security_events_24h,
        (SELECT count(*) FROM outbox_events
           WHERE status = 'failed'
              OR (status = 'pending' AND created_at < now() - interval '15 minutes'))::int AS failed_outbox,
        (SELECT coalesce(sum(max_uses - use_count), 0) FROM license_items
           WHERE status = 'available')::int AS available_stock;
    `);
    const r = rows[0];
    return {
      todayOrders: Number(r?.today_orders ?? 0),
      openReplacements: Number(r?.open_replacements ?? 0),
      securityEvents24h: Number(r?.security_events_24h ?? 0),
      failedOutbox: Number(r?.failed_outbox ?? 0),
      availableStock: Number(r?.available_stock ?? 0),
    };
  }
}
