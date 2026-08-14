import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { SweepAlarmService } from '../maintenance/sweep-alarm.service';
import { LOW_STOCK_QUEUE, LowStockService } from './low-stock.service';
import { LowStockProcessor } from './low-stock.processor';
import { SITE_SILENCE_QUEUE, SiteSilenceService } from './site-silence.service';
import { SiteSilenceProcessor } from './site-silence.processor';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Bildirim + düşük stok + mağaza sessizlik modülü (§12/§16). NotificationsService panel içi
 * bildirim akışı + env-gated Telegram; LowStockService tekrarlı (~30dk) + elle tetik düşük stok
 * tespiti; SiteSilenceService tekrarlı (~30dk) + elle tetik mağaza canlılık (sessizlik) alarmı.
 *
 * SweepAlarmService BURADA DA sağlanır (MaintenanceModule'de de var): sweep başarısızlık
 * alarmı LowStockProcessor'ın da ihtiyacı ama MaintenanceModule'ü import etmek DÖNGÜ olurdu
 * (Maintenance → Notifications). Sınıfın kendisi durumsuzdur ve dedupe'u DB üzerinden yapar →
 * ikinci bir örneğin olması davranışı değiştirmez. `exports` sayesinde bu modülü import eden
 * DailyDigestModule de aynı alarmı kullanabilir (bkz. daily-digest.processor).
 */
@Module({
  imports: [
    AuthModule,
    BullModule.registerQueue({ name: LOW_STOCK_QUEUE }),
    BullModule.registerQueue({ name: SITE_SILENCE_QUEUE }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    LowStockService,
    LowStockProcessor,
    SiteSilenceService,
    SiteSilenceProcessor,
    SweepAlarmService,
  ],
  exports: [NotificationsService, SweepAlarmService],
})
export class NotificationsModule {}
