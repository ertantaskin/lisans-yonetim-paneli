import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { auditLog, emailLog, outboxEvents } from '../db/schema';
import { WEBHOOK_QUEUE, type WebhookJob } from '../webhook/webhook.service';
import { MAIL_QUEUE, type DeliveryJob } from '../mail/mail.service';

/** Yeniden kuyruğa alınabilir dead-letter kaynağı. */
export type ReplayKind = 'outbox' | 'email';

/**
 * Birleşik dead-letter satırı (§16). Başarısız geri-kanal webhook (outbox_events) +
 * başarısız/bounce mail (email_log) tek listede. Sır/payload İÇERMEZ — yalnız meta.
 */
export interface DeadLetterRow {
  kind: ReplayKind;
  id: string;
  /** outbox: event_type · email: subject (konu — sır değil). */
  label: string;
  status: string;
  /** Son hata mesajı (varsa). */
  error: string | null;
  /** outbox deneme sayısı; email için null. */
  attempts: number | null;
  /** Bağlı sipariş id (varsa) — detay sayfasına bağlanır. */
  orderId: string | null;
  /** email: alıcı adresi; outbox: null. */
  toEmail: string | null;
  createdAt: string;
  updatedAt: string;
  /** Kaydın yaşı (saniye) — askıda kalma eşiğini ve replay hedeflemeyi görünür kılar (§16). */
  ageSeconds: number;
  /** true → başarısız/bounce DEĞİL, askıda kalmış (pending/queued 15dk+); yalnız görünürlük. */
  stale: boolean;
}

/**
 * Ops/dead-letter servisi (§16). Başarısız outbox olaylarını + mail loglarını listeler ve
 * ilgili kaydı mevcut kuyruk publish desenini kullanarak yeniden kuyruğa alır (replay).
 * Çekirdek teslim/atama mantığı DEĞİŞMEZ — yalnız durum sıfırlama + re-enqueue.
 */
@Injectable()
export class OpsService {
  private readonly logger = new Logger(OpsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(WEBHOOK_QUEUE) private readonly webhookQueue: Queue,
    @InjectQueue(MAIL_QUEUE) private readonly mailQueue: Queue,
  ) {}

  /**
   * Başarısız outbox_events (status='failed') + email_log (status in failed/bounced) VE askıda
   * kalmış kayıtlar (15dk+ pending outbox / queued|sending email_log) birleşik liste, en son
   * güncellenene göre DESC, limit 100. RAW SQL (§16). Payload/sır DÖNMEZ. Her satırda kaynak
   * (kind), yaş (ageSeconds) ve askıda bayrağı (stale) var → replay hedeflenebilir.
   */
  async deadLetter(): Promise<DeadLetterRow[]> {
    const rows = await rawRows<{
      kind: ReplayKind;
      id: string;
      label: string;
      status: string;
      error: string | null;
      attempts: number | null;
      order_id: string | null;
      to_email: string | null;
      created_at: string;
      updated_at: string;
      age_seconds: number;
      stale: boolean;
    }>(this.db, sql`
      SELECT 'outbox'::text AS kind, oe.id::text AS id, oe.event_type AS label,
             oe.status AS status, oe.last_error AS error, oe.attempts AS attempts,
             oe.order_id::text AS order_id, NULL::text AS to_email,
             oe.created_at AS created_at, oe.updated_at AS updated_at,
             -- yaş (saniye) + askıda-kalma bayrağı (§16 görünürlük)
             EXTRACT(EPOCH FROM (now() - oe.created_at))::int AS age_seconds,
             (oe.status <> 'failed') AS stale
      FROM outbox_events oe
      -- başarısız + askıda kalmış (pending ama 15dk+ teslim edilememiş) webhook'lar
      WHERE oe.status = 'failed'
         OR (oe.status = 'pending' AND oe.created_at < now() - interval '15 minutes')
      UNION ALL
      SELECT 'email'::text AS kind, el.id::text AS id, el.subject AS label,
             el.status AS status, el.error AS error, NULL::int AS attempts,
             el.order_id::text AS order_id, el.to_email AS to_email,
             el.created_at AS created_at, el.updated_at AS updated_at,
             EXTRACT(EPOCH FROM (now() - el.created_at))::int AS age_seconds,
             (el.status NOT IN ('failed', 'bounced')) AS stale
      FROM email_log el
      -- başarısız/bounce + askıda kalmış (queued|sending ama 15dk+ gönderilememiş) mailler
      WHERE el.status IN ('failed', 'bounced')
         OR (el.status IN ('queued', 'sending') AND el.created_at < now() - interval '15 minutes')
      ORDER BY updated_at DESC
      LIMIT 100;
    `);
    return rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      label: r.label,
      status: r.status,
      error: r.error,
      attempts: r.attempts === null ? null : Number(r.attempts),
      orderId: r.order_id,
      toEmail: r.to_email,
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      ageSeconds: r.age_seconds === null ? 0 : Number(r.age_seconds),
      stale: Boolean(r.stale),
    }));
  }

  /**
   * Dead-letter kaydını yeniden kuyruğa alır (§16). Durum 'pending'/'queued'e sıfırlanır,
   * hata temizlenir, mevcut kuyruk publish deseniyle re-enqueue edilir; audit'e düşer.
   * Çekirdek gönderim mantığı çağrılmaz — worker aynı işi tekrar dener.
   */
  async replay(kind: ReplayKind, id: string): Promise<{ replayed: true; kind: ReplayKind; id: string }> {
    if (kind === 'outbox') {
      await this.replayOutbox(id);
    } else {
      await this.replayEmail(id);
    }
    await this.writeAudit(kind, id);
    return { replayed: true, kind, id };
  }

  /** outbox_events → status='pending', last_error=null; webhook 'deliver' işini yeniden ekler. */
  private async replayOutbox(id: string): Promise<void> {
    const [ob] = await this.db
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, id))
      .limit(1);
    if (!ob) throw new NotFoundException('Outbox kaydı bulunamadı');

    await this.db
      .update(outboxEvents)
      .set({ status: 'pending', lastError: null, updatedAt: new Date() })
      .where(eq(outboxEvents.id, id));

    // WebhookService.emit ile aynı kuyruk/opsiyon deseni.
    await this.webhookQueue.add('deliver', { outboxId: id } satisfies WebhookJob, {
      attempts: 8,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 1000,
      // Başarısız işleri sınırla (emit ile ayna) — replay edilen webhook de erişilemeyen
      // hedefte sınırsız birikmesin (§16 kuyruk hijyeni).
      removeOnFail: 5000,
    });
  }

  /** email_log → status='queued', error=null; mail 'delivery' işini yeniden ekler (orderId gerekli). */
  private async replayEmail(id: string): Promise<void> {
    const [log] = await this.db
      .select({ id: emailLog.id, orderId: emailLog.orderId })
      .from(emailLog)
      .where(eq(emailLog.id, id))
      .limit(1);
    if (!log) throw new NotFoundException('Mail kaydı bulunamadı');
    // orderId null ise mail worker teslimat bağlamını kuramaz → replay edilemez.
    if (!log.orderId) throw new NotFoundException('Mail kaydı bir siparişe bağlı değil, yeniden gönderilemez');

    await this.db
      .update(emailLog)
      .set({ status: 'queued', error: null, updatedAt: new Date() })
      .where(eq(emailLog.id, id));

    // MailService.enqueueDelivery ile aynı kuyruk/opsiyon deseni.
    await this.mailQueue.add(
      'delivery',
      { orderId: log.orderId, emailLogId: id } satisfies DeliveryJob,
      { attempts: 5, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 5000 },
    );
  }

  /**
   * Replay'i audit_log'a yazar (best-effort — audit yazımı başarısız olsa bile replay bozulmaz).
   * 'resend' action'ı re-enqueue anlamını taşır (enum'da mevcut).
   */
  private async writeAudit(kind: ReplayKind, id: string): Promise<void> {
    try {
      await this.db.insert(auditLog).values({
        action: 'resend',
        actor: 'panel:admin',
        targetType: `dead_letter:${kind}`,
        targetId: id,
        meta: { op: 'replay', kind },
      });
    } catch {
      // Audit best-effort — ana akışı bozma.
    }
  }
}
