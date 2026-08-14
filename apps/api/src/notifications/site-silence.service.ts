import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { NotificationsService } from './notifications.service';
import { resolveSilenceHours } from './site-silence.constants';
import { upsertSoleJobScheduler } from '../queue/sole-scheduler';

export const SITE_SILENCE_QUEUE = 'site-silence';

/**
 * Sessizlik taraması periyodu (ms). Eşik SAAT mertebesinde (vars. 24s) olduğu için 30 dakikalık
 * granülerlik fazlasıyla yeterli; daha sık koşmak yalnız DB yükü ekler, alarmı hızlandırmaz.
 * Düşük stok taramasıyla aynı kadans (aynı sınıf "yavaş" operasyonel sinyal).
 */
const SWEEP_EVERY_MS = 30 * 60 * 1000;

/**
 * Tek koşuda üretilecek AZAMİ bildirim. Panel geneli bir kesintide (ör. panel adresi
 * değişti, TLS bozuldu) TÜM mağazalar aynı anda sessizleşir; sınır olmasaydı tek turda
 * yüzlerce bildirim + yüzlerce Telegram mesajı üretilirdi (alarm körlüğü). Sınıra takılan
 * siteler dedupe kuralı gereği "henüz bildirilmemiş" kalır → bir sonraki turda bildirilir.
 */
const MAX_ALERTS_PER_RUN = 50;

type SilentSiteRow = {
  id: string;
  domain: string;
  /** postgres.js timestamptz'yi Date olarak döndürür; ham sürücü davranışına güvenilmez. */
  last_seen_at: Date | string;
  silent_hours: number;
};

/**
 * MAĞAZA SESSİZLİK (canlılık) ALARMI (§16 gözlem).
 *
 * NEDEN VAR: geçmişte gerçek bir kesinti GÜNLERCE fark edilmedi — eklenti panele hiç imzalı
 * istek göndermiyordu ama panel "sağlıklı" görünüyordu, çünkü SESSİZLİĞİ ÖLÇEN hiçbir sinyal
 * yoktu. `plugin_version_at` yalnız SÜRÜM değişince, katalog `synced_at` yalnız içerik hash'i
 * değişince yazılır; ikisi de canlılık ölçmez. Ölçen tek alan `sites.last_seen_at`'tir
 * (HmacGuard, imza DOĞRULANDIKTAN sonra yazar) — bu tarama da onu okur.
 *
 * DEDUPE STRATEJİSİ (pencere değil, EPİZOT): "bu sessizlik epizodu için zaten bildirdik mi?"
 * sorusu `n.created_at > s.last_seen_at` ile yanıtlanır. Site sustuğu sürece `last_seen_at`
 * DONDUĞU için ilk alarmdan sonra üretilen her tur bu koşula takılır → epizot başına TAM BİR
 * bildirim. Mağaza tekrar konuşup yeniden susarsa `last_seen_at` ileri gider, eski bildirim
 * artık "epizot öncesi" kalır → YENİ alarm üretilir. Sabit saatlik bir dedupe penceresi bu iki
 * davranışı aynı anda veremezdi (ya kalıcı arızada spam, ya yeni epizotta sessizlik).
 */
@Injectable()
export class SiteSilenceService implements OnModuleInit {
  private readonly logger = new Logger(SiteSilenceService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(SITE_SILENCE_QUEUE) private readonly queue: Queue,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Boot'ta tekrarlı taramayı KARARLI job-scheduler kimliğiyle upsert eder (BullMQ v5) —
   * low-stock/expiry/retention ile aynı desen. `queue.add(repeat)` yerine `upsertJobScheduler`:
   * periyot değişirse eski zamanlama atomik değiştirilir, yetim (mükerrer) schedule kalmaz.
   */
  async onModuleInit(): Promise<void> {
    await upsertSoleJobScheduler(
      this.queue,
      'site-silence-sweep',
      { every: SWEEP_EVERY_MS },
      { name: 'sweep', data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      this.logger,
    );
  }

  /**
   * Eşiği aşan AKTİF siteler için 'site_silent' bildirimi üretir (epizot-dedupe'lu).
   * @returns yeni oluşturulan bildirim sayısı
   */
  async checkSilence(): Promise<number> {
    const hours = resolveSilenceHours();

    // Yüklem `isSiteSilent()` ile BİREBİR aynı (ekran ile alarm çelişmesin):
    //   - status='active'          → askıdaki sitenin susması beklenendir
    //   - last_seen_at IS NOT NULL → hiç bağlanmamış site KURULUM aşamasıdır, alarm konusu değil
    //   - last_seen_at < now()-eşik
    // Dedupe ANA sorguya NOT EXISTS ile gömülü (döngü-içi N+1 yok) — low-stock deseni.
    // ORDER BY: en uzun süredir susan önce → tavana takılınırsa en kritik olanlar bildirilir.
    const rows = await rawRows<SilentSiteRow>(this.db, sql`
      SELECT
        s.id AS id,
        s.domain AS domain,
        s.last_seen_at AS last_seen_at,
        floor(extract(epoch FROM (now() - s.last_seen_at)) / 3600)::int AS silent_hours
      FROM sites s
      WHERE s.status = 'active'
        AND s.last_seen_at IS NOT NULL
        AND s.last_seen_at < now() - (${hours} * interval '1 hour')
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
          WHERE n.type = 'site_silent'
            AND n.meta->>'siteId' = s.id::text
            -- EPİZOT dedupe: bu sessizlik epizodu (last_seen_at'ten SONRASI) için bildirim var mı?
            AND n.created_at > s.last_seen_at
        )
      ORDER BY s.last_seen_at ASC
      LIMIT ${MAX_ALERTS_PER_RUN};
    `);

    let created = 0;
    for (const r of rows) {
      const silentHours = Number(r.silent_hours);
      await this.notifications.create({
        type: 'site_silent',
        // 'warning' → env-gated Telegram'a da düşer (kritik değil: mağaza kapalı/az trafikli de
        // olabilir; operatörün BAKMASI gerekir, sistem kendi başına bir eylem yapmaz — §15).
        severity: 'warning',
        title: `Mağaza sessiz: ${r.domain}`,
        message:
          `${r.domain} panele ${silentHours} saattir imzalı istek göndermedi ` +
          `(eşik ${hours} saat). Eklenti devre dışı kalmış, panel adresi/anahtarı değişmiş ya da ` +
          `mağaza erişilemez olabilir — bağlantıyı kontrol edin.`,
        // Sır/PII YOK: yalnız site kimliği + domain + süre. siteId dedupe anahtarıdır.
        meta: {
          siteId: r.id,
          domain: r.domain,
          // Her zaman ISO metin: meta JSON'a yazılır ve okuyan taraf (UI/rapor) tek biçim bekler.
          lastSeenAt:
            r.last_seen_at instanceof Date ? r.last_seen_at.toISOString() : String(r.last_seen_at),
          silentHours,
          thresholdHours: hours,
        },
      });
      created += 1;
    }

    if (created > 0) this.logger.warn(`Sessiz mağaza: ${created} bildirim üretildi`);
    if (created === MAX_ALERTS_PER_RUN) {
      // Tavana dayandık: muhtemelen panel-geneli bir kesinti var. Kalanlar bir sonraki turda
      // bildirilir (dedupe onları "bildirilmemiş" saymaya devam eder).
      this.logger.warn(
        `Sessizlik taraması tur tavanına (${MAX_ALERTS_PER_RUN}) ulaştı — kalan siteler sonraki turda bildirilecek.`,
      );
    }
    return created;
  }
}
