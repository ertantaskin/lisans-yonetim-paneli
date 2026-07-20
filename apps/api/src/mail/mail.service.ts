import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { DB, type Database } from '../db/db.module';
import { emailLog } from '../db/schema';

export const MAIL_QUEUE = 'mail';

export interface DeliveryJob {
  orderId: string;
  emailLogId: string;
}

@Injectable()
export class MailService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(MAIL_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Teslimat mailini kuyruğa alır (§2: mail asenkron; sağlayıcı çökse bile atama
   * tamamdır, kuyruk tekrar dener). email_log 'queued' oluşturulur.
   */
  async enqueueDelivery(orderId: string, toEmail: string, subject: string): Promise<void> {
    const [log] = await this.db
      .insert(emailLog)
      .values({ orderId, toEmail, subject, status: 'queued' })
      .returning({ id: emailLog.id });

    await this.queue.add('delivery', { orderId, emailLogId: log!.id } satisfies DeliveryJob, {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }
}
