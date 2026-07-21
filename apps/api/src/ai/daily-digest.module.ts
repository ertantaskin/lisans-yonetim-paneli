import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsModule } from '../notifications/notifications.module';
import { AiSummaryModule } from './ai-summary.module';
import { DAILY_DIGEST_QUEUE, DailyDigestService } from './daily-digest.service';
import { DailyDigestProcessor } from './daily-digest.processor';

/**
 * Günlük Telegram özeti + sabit-eşik alarm modülü (§16). AiSummaryModule (metrik + AI
 * anomali paragrafı) + NotificationsModule (env-gated Telegram + bildirim kaydı) import eder;
 * tekrarlı iş her gün 08:00 çalışır. Env-gated (Telegram env yoksa gönderim no-op, iş sessiz).
 */
@Module({
  imports: [
    AiSummaryModule,
    NotificationsModule,
    BullModule.registerQueue({ name: DAILY_DIGEST_QUEUE }),
  ],
  providers: [DailyDigestService, DailyDigestProcessor],
})
export class DailyDigestModule {}
