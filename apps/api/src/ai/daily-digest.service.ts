import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { NotificationsService } from '../notifications/notifications.service';
import { AiSummaryService, type DailyMetrics, type DailySummary } from './ai-summary.service';

export const DAILY_DIGEST_QUEUE = 'daily-digest';
/** Günlük özetin gönderileceği zaman — cron: her gün 08:00 (sunucu saati). §16. */
const DIGEST_CRON = '0 8 * * *';
/** Tekrarlı işi tekilleştiren sabit anahtar — mükerrer kayıt olmaz. */
const DIGEST_JOB_ID = 'daily-digest';

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

  /** Boot'ta günlük tekrarlı işi kaydeder (sabit jobId + cron anahtarı → mükerrer eklenmez). */
  async onModuleInit(): Promise<void> {
    await this.queue.add(
      'digest',
      {},
      {
        repeat: { pattern: DIGEST_CRON },
        jobId: DIGEST_JOB_ID,
        removeOnComplete: 50,
        removeOnFail: 50,
      },
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
      `Sorunlu webhook: ${m.failedOutbox}`,
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

    if (m.failedOutbox >= failedOutboxThreshold) {
      await this.notifications.create({
        type: 'digest_alert',
        severity: 'critical',
        title: 'Sorunlu webhook birikmesi',
        message: `Bekleyen/başarısız outbox olayı ${m.failedOutbox} (eşik ${failedOutboxThreshold}). Dead-letter kuyruğunu inceleyin.`,
        meta: { metric: 'failedOutbox', value: m.failedOutbox, threshold: failedOutboxThreshold },
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
