import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationsService } from '../notifications/notifications.service';
import { AiSummaryService, type DailyMetrics, type DailySummary } from './ai-summary.service';
import { upsertSoleJobScheduler } from '../queue/sole-scheduler';

export const DAILY_DIGEST_QUEUE = 'daily-digest';
/** Günlük özetin gönderileceği zaman — cron: her gün 08:00 (sunucu saati). §16. */
const DIGEST_CRON = '0 8 * * *';
/**
 * Kararlı job-scheduler kimliği (§16). BullMQ v5 job scheduler'ı BUNUNLA anahtarlar; cron
 * değişse bile eski zamanlama atomik olarak DEĞİŞTİRİLİR (repeat opsiyonlarıyla anahtarlanan
 * eski `queue.add` yaklaşımının aksine — o, pattern değişince ORTADA yetim zamanlama bırakır
 * ve İKİSİ birden tetiklenir; digest NON-idempotent olduğu için mükerrer Telegram özeti +
 * çift kritik alarm demektir). schedulerId sabit kaldıkça mükerrer zamanlama oluşmaz.
 */
const DIGEST_SCHEDULER_ID = 'daily-digest';

/**
 * Sabit-eşik alarm varsayılanları — DIGEST_*_THRESHOLD env ile geçersiz kılınır.
 * failedOutbox/securityEvents24h eşiği AŞARSA, availableStock eşiğe İNER/altına geçerse
 * kritik bildirim üretilir (NotificationsService.create → warning/critical Telegram yolu).
 */
const DEFAULT_FAILED_OUTBOX_THRESHOLD = 5;
const DEFAULT_SECURITY_EVENTS_THRESHOLD = 20;
const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/** Pozitif tamsayı env okur; eksik/geçersizse varsayılana düşer. */
function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/**
 * Günlük Telegram özeti + sabit-eşik alarm (§16). BullMQ tekrarlı iş (her gün 08:00):
 * AiSummaryService.dailySummary() metriklerini KISA Türkçe düz-metin özete çevirip
 * best-effort Telegram'a düşer (AI açıksa anomali paragrafı da eklenir), ardından sabit/env
 * eşikleri aşan metrikler için kritik bildirim üretir.
 *
 * Env-gated: Telegram env (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) yoksa sendTelegram zaten
 * no-op (sessiz) — iş yine çalışır, ekstra gate gerekmez. AI env yoksa paragraph=null gelir,
 * metrik özeti yine gönderilir. Bu servis yalnız OKUR + bildirir; lisans verisine dokunmaz.
 */
@Injectable()
export class DailyDigestService implements OnModuleInit {
  private readonly logger = new Logger(DailyDigestService.name);

  constructor(
    @InjectQueue(DAILY_DIGEST_QUEUE) private readonly queue: Queue,
    private readonly aiSummary: AiSummaryService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Boot'ta günlük tekrarlı işi KARARLI job-scheduler kimliğiyle upsert eder. Cron ileride
   * değişirse eski zamanlama atomik değiştirilir (yetim mükerrer schedule kalmaz) → çift
   * digest/kritik alarm olmaz. NON-idempotent olduğu için bu servis en kritik olanı.
   */
  async onModuleInit(): Promise<void> {
    await upsertSoleJobScheduler(
      this.queue,
      DIGEST_SCHEDULER_ID,
      { pattern: DIGEST_CRON },
      { name: 'digest', data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      this.logger,
    );
  }

  /**
   * Günlük özeti üretir: metrikleri toplar, Telegram'a düz-metin özet gönderir ve
   * sabit/env eşikleri aşan metrikler için kritik bildirim üretir.
   * @returns { sent: Telegram'a gerçekten gönderildi mi, alerts: üretilen eşik alarmı sayısı }
   */
  async run(): Promise<{ sent: boolean; alerts: number }> {
    const summary = await this.aiSummary.dailySummary();
    const text = this.formatDigest(summary);
    const sent = await this.notifications.sendTelegram(text);
    const alerts = await this.raiseThresholdAlerts(summary.metrics);
    this.logger.log(
      `Günlük özet: Telegram ${sent ? 'gönderildi' : 'no-op'}, ${alerts} eşik alarmı üretildi`,
    );
    return { sent, alerts };
  }

  /** Metrikleri (+ varsa AI paragrafı) KISA Türkçe düz-metin özete çevirir. */
  private formatDigest(summary: DailySummary): string {
    const m = summary.metrics;
    const date = new Date().toLocaleDateString('tr-TR');
    const lines = [
      `Günlük Operasyon Özeti — ${date}`,
      '',
      `Bugünkü sipariş: ${m.todayOrders}`,
      `Açık talep: ${m.openReplacements}`,
      `Güvenlik olayı (24s): ${m.securityEvents24h}`,
      // Mail AYRI satır: outbox sağlıklıyken mail yolu ölmüş olabilir (SMTP kimliği süresi
      // dolduğunda tam olarak bu olur) — tek satırda toplansaydı arıza yine görünmezdi.
      `Sorunlu webhook: ${m.failedOutbox}`,
      `Sorunlu mail: ${m.failedEmails}`,
      `Atanabilir stok: ${m.availableStock}`,
    ];
    // AI açık ve paragraf üretildiyse anomali yorumunu ekle (kapalı/hata → atlanır).
    if (summary.paragraph) {
      lines.push('', summary.paragraph);
    }
    return lines.join('\n');
  }

  /**
   * Sabit/env eşikleri aşan metrikler için kritik bildirim üretir. create() severity
   * 'critical' → NotificationsService best-effort Telegram yoluna düşer (ayrı gate yok).
   * Günde bir kez çalıştığı için doğal kadans; ekstra dedupe gerekmez.
   * @returns üretilen alarm sayısı
   */
  private async raiseThresholdAlerts(m: DailyMetrics): Promise<number> {
    const failedOutboxThreshold = envInt(
      'DIGEST_FAILED_OUTBOX_THRESHOLD',
      DEFAULT_FAILED_OUTBOX_THRESHOLD,
    );
    const securityEventsThreshold = envInt(
      'DIGEST_SECURITY_EVENTS_THRESHOLD',
      DEFAULT_SECURITY_EVENTS_THRESHOLD,
    );
    const lowStockThreshold = envInt('DIGEST_LOW_STOCK_THRESHOLD', DEFAULT_LOW_STOCK_THRESHOLD);

    let alerts = 0;

    /*
     * Teslimat kanalı alarmı — webhook VE mail.
     *
     * Eskiden yalnız outbox sayılıyordu: SMTP relay kimliği süresi dolduğunda siparişler
     * teslim edilir, panel 'fulfilled' der, webhook'lar başarıyla gider ama teslimat
     * mailleri 5 denemede ölür. Sabah özeti "Sorunlu webhook: 0" deyip maildan hiç söz
     * etmediği için arıza ancak müşteri şikâyetiyle fark ediliyordu.
     *
     * Eşik PAYLAŞILIR (DIGEST_FAILED_OUTBOX_THRESHOLD): iki sayaç da "sorunlu teslimat
     * kaydı" mertebesindedir ve ikinci bir env eklemek onu docker-compose + .env.example
     * geçiş zincirine de eklemeyi gerektirirdi (env'i yalnız .env'e yazmak bu projede
     * defalarca SESSİZCE etkisiz kaldı). Mesaj iki sayıyı AYRI söyler — operatörün
     * bakacağı yer farklıdır (/ops dead-letter sekmeleri vs SMTP yapılandırması).
     */
    if (m.failedOutbox >= failedOutboxThreshold || m.failedEmails >= failedOutboxThreshold) {
      await this.notifications.create({
        type: 'digest_alert',
        severity: 'critical',
        title: 'Sorunlu teslimat kaydı birikmesi (webhook/mail)',
        message:
          `Sorunlu webhook: ${m.failedOutbox} · Sorunlu mail: ${m.failedEmails} ` +
          `(eşik ${failedOutboxThreshold}). Dead-letter kuyruğunu (/ops) inceleyin; ` +
          'mail tarafı doluysa SMTP yapılandırmasını da kontrol edin.',
        meta: {
          metric: 'failedOutbox',
          value: m.failedOutbox,
          failedEmails: m.failedEmails,
          threshold: failedOutboxThreshold,
        },
      });
      alerts += 1;
    }

    if (m.securityEvents24h >= securityEventsThreshold) {
      await this.notifications.create({
        type: 'digest_alert',
        severity: 'critical',
        title: 'Olağandışı güvenlik olayı yoğunluğu',
        message: `Son 24 saatte ${m.securityEvents24h} güvenlik olayı (eşik ${securityEventsThreshold}). Güvenlik akışını inceleyin.`,
        meta: {
          metric: 'securityEvents24h',
          value: m.securityEvents24h,
          threshold: securityEventsThreshold,
        },
      });
      alerts += 1;
    }

    if (m.availableStock <= lowStockThreshold) {
      await this.notifications.create({
        type: 'digest_alert',
        severity: 'critical',
        title: 'Kritik düşük stok',
        message: `Atanabilir stok ${m.availableStock} (eşik ${lowStockThreshold}). Yeni stok girişi gerekli.`,
        meta: {
          metric: 'availableStock',
          value: m.availableStock,
          threshold: lowStockThreshold,
        },
      });
      alerts += 1;
    }

    return alerts;
  }
}
