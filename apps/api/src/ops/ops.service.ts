import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { auditLog, emailLog, outboxEvents } from '../db/schema';
import { WEBHOOK_QUEUE, type WebhookJob } from '../webhook/webhook.service';
import {
  MAIL_DELIVERY_JOB,
  MAIL_JOB_OPTS,
  MAIL_QUEUE,
  isDeliverySubject,
  type DeliveryJob,
} from '../mail/mail.service';

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
  /**
   * false → bu satır yeniden kuyruğa ALINAMAZ (UI 'Tekrar dene' butonunu kapatmalı). Sebebi
   * `replayBlockedReason` taşır. Örn. teslimat OLMAYAN mail (durum bildirimi) teslimat işi
   * olarak replay edilirse müşteriye tüm lisans anahtarları giderdi.
   */
  replayable: boolean;
  /** replayable=false ise insan-okur gerekçe; aksi halde null. */
  replayBlockedReason: string | null;
}

/**
 * Dead-letter listesi + KAPSAM bilgisi. Liste `DEAD_LETTER_LIMIT` ile sınırlıdır; arıza
 * anında (yüzlerce başarısız webhook) kalanların SESSİZCE kırpılması operatörü yanıltır
 * ("hepsi bu kadarmış" → replay edilmeyen kayıt kalır). `total` gerçek sayıyı, `truncated`
 * kırpılma olup olmadığını söyler.
 */
export interface DeadLetterPage {
  items: DeadLetterRow[];
  /** Listeleme koşullarına uyan TOPLAM kayıt sayısı (limit uygulanmadan). */
  total: number;
  /** true → total > limit; ekranda "N kayıttan ilk M'si" uyarısı gösterilmeli. */
  truncated: boolean;
  /** Uygulanan satır sınırı (UI mesajında kullanılır). */
  limit: number;
}

/** Birleşik dead-letter listesinin satır sınırı (yanıt küçük kalsın). */
const DEAD_LETTER_LIMIT = 100;

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
   * güncellenene göre DESC, limit DEAD_LETTER_LIMIT. RAW SQL (§16). Payload/sır DÖNMEZ. Her
   * satırda kaynak (kind), yaş (ageSeconds), askıda bayrağı (stale) ve replay uygunluğu var.
   *
   * TOPLAM SAYI: liste kırpılıyorsa operatör bunu GÖRMELİ (arıza anında "listede görünmeyen
   * kayıt replay edilemez" tuzağı). `count(*) OVER ()` pencere fonksiyonu LIMIT'ten ÖNCE tüm
   * küme üzerinde hesaplanır → ek gidiş-dönüş/ikinci sorgu olmadan gerçek toplam elde edilir.
   */
  async deadLetterPage(): Promise<DeadLetterPage> {
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
      total: number;
    }>(this.db, sql`
      WITH dl AS (
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
      )
      SELECT dl.*, (count(*) OVER ())::int AS total
      FROM dl
      -- TIE-BREAK ŞART: bir arıza anında yüzlerce outbox/mail kaydı AYNI transaction'da
      -- (ya da aynı milisaniyede) yazılır ve updated_at damgaları BİREBİR aynı olur →
      -- tie-break'siz LIMIT 100 penceresine hangi satırların gireceği KEYFİ olurdu.
      -- Sonuç somut: operatörün replay etmesi gereken kayıt listede HİÇ görünmeyebilir ve
      -- sayfa her yenilendiğinde başka bir alt küme gelir. (kind, id) çifti benzersizdir.
      ORDER BY updated_at DESC, kind ASC, id DESC
      LIMIT ${DEAD_LETTER_LIMIT};
    `);

    const items = rows.map((r) => {
      const block = this.replayBlockReason(r.kind, r.label, r.order_id);
      return {
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
        replayable: block === null,
        replayBlockedReason: block,
      };
    });

    const total = Number(rows[0]?.total ?? 0);
    return { items, total, truncated: total > items.length, limit: DEAD_LETTER_LIMIT };
  }

  /**
   * Replay engeli gerekçesi (null = replay edilebilir). TEK KAYNAK: liste (UI butonu) ve
   * replay ucu AYNI kuralı kullanır → ekranda aktif görünen buton uçta 400 yemez.
   *
   * KURAL (veri sızıntısı koruması): mail replay'i HER kaydı teslimat işi ('delivery') olarak
   * kuyruğa alır; o iş siparişin TÜM aktif atamalarını çözüp anahtarları gönderir. Dolayısıyla
   * teslimat OLMAYAN bir mail (değişim/destek durum bildirimi, şablon test maili) replay
   * edilirse müşteriye istenmeden tüm lisans anahtarları gider. Tür ayrımı konudan yapılır
   * (email_log'da tür kolonu yok, migration eklenmiyor) — tek kaynak: mail.service.isDeliverySubject.
   */
  private replayBlockReason(kind: ReplayKind, label: string, orderId: string | null): string | null {
    if (kind === 'outbox') return null;
    if (!orderId) return 'Mail kaydı bir siparişe bağlı değil (ör. şablon test maili) — yeniden gönderilemez';
    if (!isDeliverySubject(label)) {
      return 'Bu kayıt teslimat maili değil (durum/bildirim maili) — teslimat olarak yeniden gönderilemez';
    }
    return null;
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

  /**
   * email_log → status='queued', error=null; mail TESLİMAT işini yeniden ekler (orderId gerekli).
   *
   * GÜVENLİK: yalnız TESLİMAT maili replay edilir. Bir durum/bildirim maili (değişim talebi
   * bildirimi) burada 'delivery' işine dönüştürülseydi worker siparişin tüm aktif atamalarını
   * çözüp müşteriye TÜM lisans anahtarlarını gönderirdi (veri sızıntısı sınıfı bulgu). Ayrım
   * listeyle AYNI yerden gelir (replayBlockReason → mail.service.isDeliverySubject); uygun
   * olmayan kayıt AÇIK mesajla 400 alır (sessizce yutulmaz).
   */
  private async replayEmail(id: string): Promise<void> {
    const [log] = await this.db
      .select({ id: emailLog.id, orderId: emailLog.orderId, subject: emailLog.subject })
      .from(emailLog)
      .where(eq(emailLog.id, id))
      .limit(1);
    if (!log) throw new NotFoundException('Mail kaydı bulunamadı');

    const blocked = this.replayBlockReason('email', log.subject, log.orderId);
    if (blocked) throw new BadRequestException(blocked);

    await this.db
      .update(emailLog)
      .set({ status: 'queued', error: null, updatedAt: new Date() })
      .where(eq(emailLog.id, id));

    // MailService.enqueueDelivery ile AYNI kuyruk/iş adı/opsiyon deseni. Opsiyonlar TEK KAYNAKTAN
    // (mail.service.MAIL_JOB_OPTS) okunur: burada literal kopya durduğu sürece asıl teslimat yolu
    // ile replay yolu sessizce ayrışabilirdi (attempts/backoff/removeOnFail sapması → replay edilen
    // mail farklı garantiyle koşar). Profil değişikliği artık iki yolu birden kapsar.
    await this.mailQueue.add(
      MAIL_DELIVERY_JOB,
      { orderId: log.orderId!, emailLogId: id } satisfies DeliveryJob,
      MAIL_JOB_OPTS,
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
        /*
         * TEK BİÇİM `dead_letter` (eskiden `dead_letter:${kind}`).
         *
         * NEDEN: kod tabanındaki DİĞER TÜM `targetType` değerleri düz snake_case tek
         * sözcüktür (order / assignment / license_item / batch / supplier_claim …) ve
         * `/audit` süzgeci de bu sözleşmeye göre yazılmış (`^[a-z_]{1,64}$`). İki nokta
         * taşıyan bu TEK istisna, süzgecin doğrulamasına takılıyordu → bu satırlar
         * `/audit` ekranından HİÇ süzülemiyordu ve etiket sözlüğünde karşılığı olmadığı
         * için ham değer olarak görünüyordu.
         *
         * BİLGİ KAYBI YOK: ayrım (`email` | `webhook`) zaten `meta.kind` içinde duruyor —
         * yani hedef tipini sadeleştirmek hiçbir veriyi silmiyor, yalnız kimlik alanını
         * sözleşmeye döndürüyor. Alternatif (regex'i `:` kabul edecek şekilde genişletmek)
         * hem başka hiçbir yazarın üretmediği bir şekli meşrulaştırır hem de sözlüğe
         * KALICI iki ayrı etiket anahtarı eklemeyi gerektirirdi.
         *
         * GERİYE DÖNÜK: mevcut `dead_letter:email`/`dead_letter:webhook` satırları olduğu
         * gibi kalır (audit izi DEĞİŞTİRİLMEZ). Onlar bugün de süzülemiyordu → regresyon
         * yok; `action=resend` + `targetId` ile hâlâ bulunabilirler.
         */
        targetType: 'dead_letter',
        targetId: id,
        meta: { op: 'replay', kind },
      });
    } catch (err) {
      // Audit best-effort — ana akışı bozma. Ama SESSİZ DEĞİL: replay, müşteriye mail/webhook
      // GÖNDEREN bir operatör eylemidir; izi düşmezse "bu mail kim tarafından, kaç kez tekrar
      // gönderildi" sorusu yanıtsız kalır (mükerrer teslimat şikâyetinin tek kanıtı bu satırdır).
      this.logger.warn(
        `Replay audit kaydı yazılamadı (kind=${kind}, id=${id}) — replay YAPILDI, izi düşmedi: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
