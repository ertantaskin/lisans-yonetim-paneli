import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { SweepAlarmService } from '../maintenance/sweep-alarm.service';
import { LOW_STOCK_QUEUE, LowStockService } from './low-stock.service';
import { LowStockProcessor } from './low-stock.processor';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Bildirim + düşük stok modülü (§12). NotificationsService panel içi bildirim akışı +
 * env-gated Telegram; LowStockService tekrarlı (~30dk) + elle tetik düşük stok tespiti.
 *
 * SweepAlarmService BURADA DA sağlanır (MaintenanceModule'de de var): sweep başarısızlık
 * alarmı LowStockProcessor'ın da ihtiyacı ama MaintenanceModule'ü import etmek DÖNGÜ olurdu
 * (Maintenance → Notifications). Sınıfın kendisi durumsuzdur ve dedupe'u DB üzerinden yapar →
 * ikinci bir örneğin olması davranışı değiştirmez. `exports` sayesinde bu modülü import eden
 * DailyDigestModule de aynı alarmı kullanabilir (bkz. daily-digest.processor).
 */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: LOW_STOCK_QUEUE })],
  controllers: [NotificationsController],
  providers: [NotificationsService, LowStockService, LowStockProcessor, SweepAlarmService],
  exports: [NotificationsService, SweepAlarmService],
})
export class NotificationsModule {}
