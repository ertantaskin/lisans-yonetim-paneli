import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { securityEvents, type SecurityEvent } from '../db/schema/securityEvents';

export const SECURITY_QUEUE = 'security';

/** Anomali taraması periyodu (ms). Tam tablo taraması değil, dar zaman pencereli sorgular. */
const SCAN_EVERY_MS = 15 * 60 * 1000;

/**
 * Velocity (hız) eşiği: bir sitenin son 1 saatte ürettiği sipariş sayısı bunu aşarsa
 * 'velocity' güvenlik olayı yazılır. 2 katını aşarsa severity='critical'.
 */
const VELOCITY_THRESHOLD = 100;
const VELOCITY_CRITICAL_MULTIPLIER = 2;

/**
 * Değişim-oranı anomalisi: bir sitede son 24 saatte onaylanmış (approved) değişim
 * taleplerinin, o sitenin ayakta atamalarına oranı bunu aşarsa 'anomaly' yazılır.
 * MIN_ASSIGNMENTS düşük hacimli sitelerde yanlış-pozitifi engeller.
 */
const REPLACEMENT_RATIO_THRESHOLD = 0.25;
const REPLACEMENT_MIN_ASSIGNMENTS = 10;

/** Dedupe penceresi: aynı site+type için bu süre içinde ikinci kez yazma (gürültü kırpma). */
const DEDUPE_WINDOW = sql`interval '1 hour'`;

/**
 * Güvenlik/anomali tarayıcısı (§5/§15). Dar zaman pencereli RAW SQL ile hız ve
 * değişim-oranı anomalilerini tespit eder; bulguları security_events'e yazar.
 *
 * KRİTİK (§15): AUTO-SUSPEND YAPMAZ. Yalnız kaydeder ve yüzeye çıkarır; askıya alma
 * / bloklama gibi aksiyonu her zaman bir insan onaylar. Otomatik yaptırım bilinçli yok.
 */
@Injectable()
export class SecurityService implements OnModuleInit {
  private readonly logger = new Logger(SecurityService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(SECURITY_QUEUE) private readonly queue: Queue,
  ) {}

  /** Boot'ta tekrarlı tarama işini kaydeder (aynı repeat anahtarı → mükerrer eklenmez). */
  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'scan',
      {},
      { repeat: { every: SCAN_EVERY_MS }, removeOnComplete: 50, removeOnFail: 50 },
    );
  }

  /** Güvenlik olaylarını (opsiyonel tür filtresi) en yeni önce döndürür. */
  async listEvents(type?: string): Promise<SecurityEvent[]> {
    const where = type ? eq(securityEvents.type, type) : undefined;
    return this.db
      .select()
      .from(securityEvents)
      .where(where)
      .orderBy(desc(securityEvents.createdAt))
      .limit(500);
  }

  /**
   * Tüm anomali denetimlerini çalıştırır; yeni yazılan olay sayısını döndürür.
   * @returns { created } — üretilen güvenlik olayı sayısı
   */
  async scan(): Promise<{ created: number }> {
    let created = 0;
    created += await this.scanVelocity();
    created += await this.scanReplacementAnomaly();
    if (created > 0) {
      this.logger.warn(`Güvenlik taraması: ${created} yeni olay kaydedildi (insan onayı bekler)`);
    }
    return { created };
  }

  /**
   * Velocity denetimi — son 1 saatte site başına sipariş sayısı eşiği aşarsa 'velocity'.
   * @returns yazılan olay sayısı
   */
  private async scanVelocity(): Promise<number> {
    const rows = await rawRows<{ site_id: string; cnt: number }>(this.db, sql`
      SELECT site_id, count(*)::int AS cnt
      FROM orders
      WHERE created_at >= now() - interval '1 hour'
      GROUP BY site_id
      HAVING count(*) > ${VELOCITY_THRESHOLD};
    `);
    let n = 0;
    for (const r of rows) {
      const cnt = Number(r.cnt);
      const severity = cnt > VELOCITY_THRESHOLD * VELOCITY_CRITICAL_MULTIPLIER ? 'critical' : 'warning';
      const wrote = await this.recordEvent({
        type: 'velocity',
        severity,
        siteId: r.site_id,
        detail: `Son 1 saatte ${cnt} sipariş (eşik ${VELOCITY_THRESHOLD}) — olası kötüye kullanım/hız anomalisi`,
        meta: { count: cnt, threshold: VELOCITY_THRESHOLD, windowHours: 1 },
      });
      if (wrote) n++;
    }
    return n;
  }

  /**
   * Değişim-oranı anomalisi — son 24 saatte onaylanmış değişim / ayakta atama oranı
   * eşiği aşan siteler için 'anomaly'. Düşük hacimli siteler (MIN_ASSIGNMENTS altı) elenir.
   * @returns yazılan olay sayısı
   */
  private async scanReplacementAnomaly(): Promise<number> {
    const rows = await rawRows<{
      site_id: string;
      approved: number;
      assignments: number;
    }>(this.db, sql`
      SELECT
        o.site_id AS site_id,
        count(DISTINCT rr.id) FILTER (
          WHERE rr.status = 'approved' AND rr.updated_at >= now() - interval '24 hours'
        )::int AS approved,
        count(DISTINCT a.id) FILTER (WHERE a.status = 'active')::int AS assignments
      FROM orders o
      LEFT JOIN order_lines ol ON ol.order_id = o.id
      LEFT JOIN assignments a ON a.line_id = ol.id
      LEFT JOIN replacement_requests rr ON rr.order_id = o.id
      GROUP BY o.site_id;
    `);
    let n = 0;
    for (const r of rows) {
      const approved = Number(r.approved);
      const assignments = Number(r.assignments);
      if (assignments < REPLACEMENT_MIN_ASSIGNMENTS) continue;
      const ratio = approved / assignments;
      if (ratio <= REPLACEMENT_RATIO_THRESHOLD) continue;
      const wrote = await this.recordEvent({
        type: 'anomaly',
        severity: 'warning',
        siteId: r.site_id,
        detail:
          `Yüksek değişim oranı: son 24s ${approved} onaylı değişim / ${assignments} aktif atama ` +
          `(%${Math.round(ratio * 100)} > %${Math.round(REPLACEMENT_RATIO_THRESHOLD * 100)}) — olası stok/kalite sorunu`,
        meta: { approved, assignments, ratio, threshold: REPLACEMENT_RATIO_THRESHOLD },
      });
      if (wrote) n++;
    }
    return n;
  }

  /**
   * Satış kotası aşımını 'quota_exceeded' güvenlik olayı olarak kaydeder (SalesQuotaGuard çağırır).
   * Dedupe'lu (aynı site+type için 1 saat) → sürekli 429 yiyen site saatte en çok bir kez loglanır.
   * Aşım kotanın 2 katını geçtiyse severity='critical'. §15: yalnız KAYDEDER + yüzeye çıkarır
   * (/security akışı + risk skoru); otomatik yaptırım YOK — askıya alma insan onayına kalır.
   * Best-effort: kaydedememe (çağıranda catch) sipariş reddini etkilemez.
   * @returns yazıldıysa true (dedupe atlaması false)
   */
  async recordQuotaExceeded(siteId: string, todayCount: number, quota: number): Promise<boolean> {
    const severity = todayCount >= quota * 2 ? 'critical' : 'warning';
    return this.recordEvent({
      type: 'quota_exceeded',
      severity,
      siteId,
      detail: `Günlük satış kotası aşıldı: bugün ${todayCount} sipariş (kota ${quota}) — sipariş push 429 ile reddedildi`,
      meta: { todayCount, quota },
    });
  }

  /**
   * Olay yazar — DEDUPE: aynı site+type için son DEDUPE_WINDOW içinde kayıt varsa yazmaz.
   * @returns yazıldıysa true, dedupe ile atlandıysa false
   */
  private async recordEvent(ev: {
    type: string;
    severity: string;
    siteId: string | null;
    subject?: string;
    detail: string;
    meta?: unknown;
  }): Promise<boolean> {
    const dupWhere = ev.siteId
      ? and(
          eq(securityEvents.type, ev.type),
          eq(securityEvents.siteId, ev.siteId),
          sql`${securityEvents.createdAt} >= now() - ${DEDUPE_WINDOW}`,
        )
      : and(
          eq(securityEvents.type, ev.type),
          sql`${securityEvents.siteId} IS NULL`,
          sql`${securityEvents.createdAt} >= now() - ${DEDUPE_WINDOW}`,
        );
    const existing = await this.db
      .select({ id: securityEvents.id })
      .from(securityEvents)
      .where(dupWhere)
      .limit(1);
    if (existing.length > 0) return false;

    await this.db.insert(securityEvents).values({
      type: ev.type,
      severity: ev.severity,
      siteId: ev.siteId,
      subject: ev.subject ?? null,
      detail: ev.detail,
      meta: (ev.meta ?? null) as SecurityEvent['meta'],
    });
    return true;
  }
}
