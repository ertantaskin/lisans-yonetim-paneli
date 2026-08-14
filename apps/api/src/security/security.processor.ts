import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SweepAlarmService } from '../maintenance/sweep-alarm.service';
import { SECURITY_QUEUE, SecurityService } from './security.service';

/**
 * Tekrarlı güvenlik/anomali taramasını çalıştırır (§5/§15). ExpiryProcessor deseniyle aynı.
 *
 * MODÜL BAĞIMLILIĞI (ZORUNLU): `SweepAlarmService` NotificationsModule tarafından export
 * edilir → `SecurityModule` MUTLAKA `imports: [NotificationsModule]` içermeli, aksi halde
 * Nest bu provider'ı ÇÖZEMEZ ve API BOOT ETMEZ. Bu, typecheck/build'in yakalayamayacağı bir
 * çalışma-anı bağıdır (DI). Döngü YOK: NotificationsModule → AuthModule → SitesModule zinciri
 * SecurityModule'ü import etmez (MaintenanceModule ile birebir aynı desen).
 */
@Processor(SECURITY_QUEUE)
export class SecurityProcessor extends WorkerHost {
  constructor(
    private readonly security: SecurityService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ created: number }> {
    return this.security.scan();
  }

  /**
   * İş patlarsa kritik alarm (dedupe'lu) + logger.error — expiry/reconcile/retention/low-stock/
   * site-silence ile aynı desen (§16 "sessiz iş ölümü yok").
   *
   * DENETİM BULGUSU (O5): bu handler EKSİKTİ; sınıfın yorumu "ExpiryProcessor deseniyle aynı"
   * diyordu ama desenin ALARM yarısı hiç uygulanmamıştı — tekrarlı işler arasında alarmsız
   * kalan TEK sweep buydu.
   *
   * BURADA EKSTRA KRİTİK: bu tarama anomali/velocity/kota olaylarının ÜRETİCİSİDİR. `scan()`
   * patarsa hiçbir `security_event` yazılmaz; `/security` ekranı BOŞ kalır ve boş ekran
   * "saldırı yok" gibi okunur (aslında "tarama ölü"). Yani sessiz ölüm burada, tam da
   * güvenlik gözlemini kör eden yönde yanlış güven üretiyordu.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error): Promise<void> {
    await this.alarm.report(SECURITY_QUEUE, job?.name ?? 'sweep', err);
  }
}
