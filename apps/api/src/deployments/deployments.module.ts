import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsModule } from '../notifications/notifications.module';
import { BACKUP_ALARM_QUEUE, BackupAlarmService } from './backup-alarm.service';
import { BackupAlarmProcessor } from './backup-alarm.processor';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';

/**
 * DeploymentsModule — panelden prod dağıtım yönetimi (§16). İstek kaydı + geçmiş + host
 * runner geri-bildirim uçları. Gerçek dağıtımı host'taki `scripts/deploy-runner.sh` yapar.
 *
 * NotificationsModule (denetim O1): yedek/tatbikat TAZELİK alarmı (`BackupAlarmService`) kritik
 * bildirim + env-gated Telegram üretir; ayrıca `SweepAlarmService` oradan gelir (sweep'in kendi
 * ölümü de sessiz kalmasın). DÖNGÜ YOK — kontrol edildi: NotificationsModule → AuthModule →
 * SitesModule zincirinin hiçbir halkası DeploymentsModule'ü import etmez (MaintenanceModule ve
 * DailyDigestModule ile birebir aynı desen).
 */
@Module({
  imports: [NotificationsModule, BullModule.registerQueue({ name: BACKUP_ALARM_QUEUE })],
  controllers: [DeploymentsController],
  providers: [DeploymentsService, BackupAlarmService, BackupAlarmProcessor],
  exports: [DeploymentsService],
})
export class DeploymentsModule {}
