import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsModule } from '../notifications/notifications.module';
import { EXPIRY_QUEUE, ExpiryService } from './expiry.service';
import { ExpiryProcessor } from './expiry.processor';
import { RECONCILE_QUEUE, ReconcileProcessor, ReconcileService } from './reconcile.service';
import { RETENTION_QUEUE, RetentionProcessor, RetentionService } from './retention.service';
import { SweepAlarmService } from './sweep-alarm.service';
import { MaintenanceController } from './maintenance.controller';

@Module({
  // NotificationsModule → ReconcileService (ihlal alarmı) + SweepAlarmService (sweep başarısızlık
  // alarmı) kritik bildirim üretir (§16 alarm yolu). DailyDigestModule ile aynı desen (döngüsüz:
  // NotificationsModule Maintenance'ı import etmez).
  imports: [
    NotificationsModule,
    BullModule.registerQueue(
      { name: EXPIRY_QUEUE },
      { name: RECONCILE_QUEUE },
      { name: RETENTION_QUEUE },
    ),
  ],
  controllers: [MaintenanceController],
  providers: [
    ExpiryService,
    ExpiryProcessor,
    ReconcileService,
    ReconcileProcessor,
    RetentionService,
    RetentionProcessor,
    // Ortak sweep başarısızlık alarmı (expiry/reconcile/retention processor'larının @OnWorkerEvent
    // ('failed') handler'larından çağrılır) — sessiz iş ölümü biter (§16).
    SweepAlarmService,
  ],
  exports: [ExpiryService, ReconcileService, RetentionService],
})
export class MaintenanceModule {}
