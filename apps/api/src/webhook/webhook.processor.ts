import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { buildSignaturePayload } from '@lisans/shared';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { outboxEvents, sites } from '../db/schema';
import { WEBHOOK_QUEUE, type WebhookJob } from './webhook.service';

/**
 * Geri kanal webhook worker (§2). Siteye (WP eklentisi) HMAC imzalı POST atar.
 * İmza şeması gelen isteklerle aynı — eklenti kendi secret'iyle doğrular.
 */
// concurrency 5 (varsayılan 1'di): worker TEK iş çalıştırırken erişilemeyen BİR mağaza
// (aşağıdaki 10sn timeout'a kadar asılı kalır) tüm kuyruğu BAŞ-BLOK yapıyordu → kuyruk
// ~0,1 iş/sn'ye düşüyor ve SAĞLIKLI mağazaların 'order.fulfilled' webhook'ları arkada
// sıraya giriyordu (müşteri My Account'ta lisansı görüyor, mağaza durumu dakikalarca
// güncellenmiyordu). mail.processor ile AYNI gerekçe/aynı sayı.
//
// SIRA İNVARYANTI KORUNUR (paralel çalıştırma sırayı bozabilir, ama durum GERİLEYEMEZ):
// gövdedeki monoton `seq` (outbox createdAt epoch-ms, imzalı gövdenin parçası) alıcı
// tarafta karşılaştırılır — WP `class-webhook.php` `_wpteslimat_seq` meta'sını okur ve
// `seq <= son-uygulanan` ise olayı UYGULAMADAN 200 {stale:true} döner. Yani 'partial',
// 'fulfilled'dan sonra ulaşsa bile durumu geri yazamaz. Bu koruma zaten ŞARTTI: BullMQ
// retry'ları concurrency 1'de de sırayı bozuyordu.
@Processor(WEBHOOK_QUEUE, { concurrency: 5 })
export class WebhookProcessor extends WorkerHost {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {
    super();
  }

  async process(job: Job<WebhookJob>): Promise<void> {
    const { outboxId } = job.data;
    const [ob] = await this.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, outboxId))
      .limit(1);
    if (!ob) return;

    const [site] = await this.db.select().from(sites).where(eq(sites.id, ob.siteId)).limit(1);
    if (!site?.webhookUrl) {
      await this.mark(outboxId, 'delivered', null); // hedef yok → düşür
      return;
    }

    try {
      const secret = this.crypto.decrypt(
        site.hmacSecretEnc,
        CryptoService.siteSecretAad(site.id),
      );
      const body = JSON.stringify({
        event: ob.eventType,
        orderId: ob.orderId,
        ...(ob.payload as Record<string, unknown>),
        // Monoton sıra (§2/§7 "webhook sequence — bayat webhook yok sayılır"): outbox kaydının
        // oluşturma anı (epoch-ms). Aynı sipariş için olaylar nedensel sırada üretilir (kısmi
        // ÖNCE, tamamlanan SONRA) → seq artar. BullMQ retry sırayı bozup 'partial'ı 'fulfilled'
        // SONRASINDA ulaştırırsa WP alıcısı seq <= son-uygulanan görüp yok sayar (durum gerilemez).
        // İmzalı gövdenin parçası olduğundan (body sha256) kurcalanamaz.
        seq: ob.createdAt.getTime(),
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomUUID();
      // Trace-Id uçtan uca (§16): giden webhook'ta da izlenebilirlik. Kaydın
      // kendi trace/id'si yoksa outbox id'siyle bağla (yoksa yeni üret) — böylece
      // dış POST logda outbox olayına eşlenebilir. HMAC imzasına girmez (yalnız başlık).
      const traceId = ob.id ?? randomUUID();
      const path = new URL(site.webhookUrl).pathname;
      const sig = createHmac('sha256', secret)
        .update(
          buildSignaturePayload({
            method: 'POST',
            path,
            timestamp: ts,
            nonce,
            bodySha256Hex: createHash('sha256').update(body).digest('hex'),
          }),
        )
        .digest('hex');

      const res = await fetch(site.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-timestamp': ts,
          'x-nonce': nonce,
          'x-signature': sig,
          'x-event': ob.eventType,
          'x-trace-id': traceId,
        },
        body,
        // Açık timeout (10sn): yavaş/asılı hedef worker'ı süresiz bloklamasın. Timeout →
        // AbortError, aşağıdaki catch tarafından yakalanır → failed işaretle + BullMQ retry.
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`webhook ${res.status}`);
      await this.mark(outboxId, 'delivered', null);
    } catch (err) {
      await this.mark(outboxId, 'failed', err instanceof Error ? err.message : String(err));
      throw err; // BullMQ tekrar dener (dead-letter'a kadar)
    }
  }

  private async mark(id: string, status: string, error: string | null): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({
        status,
        lastError: error,
        // Atomik artış (read-modify-write yerine tek UPDATE): aynı outbox iki kez kuyruğa
        // girse bile (ör. ops replay bir retry uçuşurken) sayaç kaybolmaz.
        attempts: sql`${outboxEvents.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(outboxEvents.id, id));
  }
}
