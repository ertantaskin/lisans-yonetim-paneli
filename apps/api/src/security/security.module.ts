import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { SECURITY_QUEUE, SecurityService } from './security.service';
import { SecurityProcessor } from './security.processor';
import { ComplianceService } from './compliance.service';
import { SecurityController } from './security.controller';
import { NotificationsModule } from '../notifications/notifications.module';

/**
 * Güvenlik/anomali + KVKK modülü (§5/§9/§15). MaintenanceModule deseniyle aynı.
 *
 * `NotificationsModule` ZORUNLU: `SecurityProcessor` süpürme hatası alarmı için
 * `SweepAlarmService`'i enjekte ediyor ve o servis oradan export ediliyor. Eksik olsaydı
 * Nest bağımlılığı çözemez ve **API HİÇ BOOT ETMEZDİ** — `tsc` ve `next build` bunu
 * yakalamaz (çalışma anı DI hatası), yalnız gerçekten ayağa kaldırmak yakalar.
 * Döngü yok: NotificationsModule → AuthModule → SitesModule zincirinin hiçbir halkası
 * SecurityModule'ü import etmiyor (MaintenanceModule ile birebir aynı desen).
 */
@Module({
  imports: [NotificationsModule, BullModule.registerQueue({ name: SECURITY_QUEUE })],
  controllers: [SecurityController],
  providers: [SecurityService, SecurityProcessor, ComplianceService],
  exports: [SecurityService, ComplianceService],
})
export class SecurityModule {}
