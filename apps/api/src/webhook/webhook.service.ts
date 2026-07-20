import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { outboxEvents, sites } from '../db/schema';

export const WEBHOOK_QUEUE = 'webhook';

export interface WebhookJob {
  outboxId: string;
}

@Injectable()
export class WebhookService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(WEBHOOK_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Geri kanal olayını kuyruğa alır (§2). Site'de webhook_url yoksa sessizce atlar
   * (WP eklentisi henüz bağlı değilse olay kaybolmaz — outbox'a yazılmaz).
   */
  async emit(
    siteId: string,
    orderId: string | null,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const [site] = await this.db
      .select({ webhookUrl: sites.webhookUrl })
      .from(sites)
      .where(eq(sites.id, siteId))
      .limit(1);
    if (!site?.webhookUrl) return;

    const [ob] = await this.db
      .insert(outboxEvents)
      .values({ siteId, orderId, eventType, payload, status: 'pending' })
      .returning({ id: outboxEvents.id });

    await this.queue.add('deliver', { outboxId: ob!.id } satisfies WebhookJob, {
      attempts: 8,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 1000,
    });
  }
}
