import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { notifications, type Notification } from '../db/schema/notifications';

/** Bildirim önem düzeyi — UI rozeti + Telegram tetiği ('warning'/'critical' → gönder). */
export type NotificationSeverity = 'info' | 'warning' | 'critical';

export interface CreateNotificationInput {
  type: string;
  severity?: NotificationSeverity;
  title: string;
  message: string;
  meta?: Record<string, unknown> | null;
}

/**
 * Bildirim servisi (§12). Panel içi bildirim akışını yazar; 'warning'/'critical' önemli
 * olaylar env-gated best-effort Telegram'a düşer. Sır ASLA meta'ya/mesaja konmaz.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  /**
   * Best-effort Telegram bildirimi (§12). TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env varsa
   * gönderir; yoksa no-op (debug log). ASLA throw ETMEZ — bildirim akışını hiçbir hata
   * kesmez (SMTP env-gated deseni gibi). Sır loglanmaz.
   * @returns gerçekten gönderildiyse true; no-op/başarısız ise false
   */
  async sendTelegram(text: string): Promise<boolean> {
    const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
    const chatId = this.config.get<string>('TELEGRAM_CHAT_ID');
    if (!token || !chatId) {
      this.logger.debug('Telegram env yok — bildirim atlanıyor (no-op)');
      return false;
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        // Token/sırrı loglama — yalnız durum kodu.
        this.logger.warn(`Telegram gönderimi başarısız: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `Telegram gönderimi hata: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Bildirim kaydı oluşturur (§12). severity 'warning'/'critical' ise best-effort
   * Telegram'a da düşer; gönderildiyse sent_telegram işaretlenir.
   */
  async create(input: CreateNotificationInput): Promise<Notification> {
    const severity: NotificationSeverity = input.severity ?? 'info';

    const [row] = await this.db
      .insert(notifications)
      .values({
        type: input.type,
        severity,
        title: input.title,
        message: input.message,
        meta: input.meta ?? null,
      })
      .returning();

    // Önemli olaylar Telegram'a — başarısızlık kaydı ETKİLEMEZ (best-effort).
    if (severity === 'warning' || severity === 'critical') {
      const sent = await this.sendTelegram(
        `[${severity.toUpperCase()}] ${input.title}\n${input.message}`,
      );
      if (sent) {
        await this.db
          .update(notifications)
          .set({ sentTelegram: true })
          .where(eq(notifications.id, row!.id));
        row!.sentTelegram = true;
      }
    }

    return row!;
  }

  /** Son bildirimler (createdAt DESC). UI akışı için. */
  async list(limit = 50): Promise<Notification[]> {
    return this.db
      .select()
      .from(notifications)
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }
}
