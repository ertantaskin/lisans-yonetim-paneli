import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { eq } from 'drizzle-orm';
import { buildSignaturePayload } from '@jetlisans/shared';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { outboxEvents, sites } from '../db/schema';
import { WEBHOOK_QUEUE, type WebhookJob } from './webhook.service';

/**
 * Geri kanal webhook worker (§2). Siteye (WP eklentisi) HMAC imzalı POST atar.
 * İmza şeması gelen isteklerle aynı — eklenti kendi secret'iyle doğrular.
 */
@Processor(WEBHOOK_QUEUE)
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
      const secret = this.crypto.decrypt(site.hmacSecretEnc);
      const body = JSON.stringify({
        event: ob.eventType,
        orderId: ob.orderId,
        ...(ob.payload as Record<string, unknown>),
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const nonce = randomUUID();
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
        },
        body,
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
        attempts: (await this.attempts(id)) + 1,
        updatedAt: new Date(),
      })
      .where(eq(outboxEvents.id, id));
  }

  private async attempts(id: string): Promise<number> {
    const [row] = await this.db
      .select({ attempts: outboxEvents.attempts })
      .from(outboxEvents)
      .where(eq(outboxEvents.id, id))
      .limit(1);
    return row?.attempts ?? 0;
  }
}
