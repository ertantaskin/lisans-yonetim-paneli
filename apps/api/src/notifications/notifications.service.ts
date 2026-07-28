import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
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

  /**
   * Son bildirimler (createdAt DESC). UI akışı için. `unreadOnly` ile üst bardaki bildirim
   * çanı yalnız okunmamışları çekebilir (notifications_unread_idx partial index'i kapsar).
   * İmza geriye dönük uyumlu: mevcut `list(limit)` çağrıları aynen çalışır.
   */
  async list(limit = 50, opts?: { unreadOnly?: boolean }): Promise<Notification[]> {
    return this.db
      .select()
      .from(notifications)
      .where(opts?.unreadOnly ? isNull(notifications.readAt) : undefined)
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  /** Okunmamış bildirim sayısı (çan rozeti). Partial index sıcak yolu — tek COUNT. */
  async unreadCount(): Promise<number> {
    const [row] = await this.db
      .select({ c: sql<number>`count(*)::int` })
      .from(notifications)
      .where(isNull(notifications.readAt));
    return Number(row?.c ?? 0);
  }

  /**
   * Bildirimleri okundu işaretler (§17 çan). `ids` verilirse yalnız onlar, `all: true` ise
   * TÜM okunmamışlar `read_at = now()` olur.
   *
   * Okuma durumu GLOBAL (şema notu): panel tek operasyon ekibince izlenir, per-admin okuma
   * durumu bilinçli olarak yok. Yalnız `read_at IS NULL` satırlar güncellenir → tekrar çağrı
   * idempotenttir ve `marked` GERÇEKTEN yeni okunanları sayar (UI sahte "N okundu" göstermez).
   *
   * @returns marked = bu çağrıda okundu yapılan satır sayısı, unread = kalan okunmamış sayısı
   */
  async markRead(input: { ids?: string[]; all?: boolean }): Promise<{
    marked: number;
    unread: number;
  }> {
    const ids = input.ids?.filter((id) => typeof id === 'string' && id.length > 0) ?? [];
    const markAll = input.all === true;

    // Ne id ne 'all' → hiçbir şey yapma (yanlışlıkla TÜMÜNÜ okumaya çevirme). Sayaç yine döner.
    if (!markAll && ids.length === 0) {
      return { marked: 0, unread: await this.unreadCount() };
    }

    const rows = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        markAll
          ? isNull(notifications.readAt)
          : and(isNull(notifications.readAt), inArray(notifications.id, ids)),
      )
      .returning({ id: notifications.id });

    return { marked: rows.length, unread: await this.unreadCount() };
  }
}
