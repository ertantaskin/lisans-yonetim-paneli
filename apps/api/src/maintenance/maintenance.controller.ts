import { Controller, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { ExpiryService } from './expiry.service';
import { ReconcileService, type ReconcileReport } from './reconcile.service';
import { RetentionService, type RetentionReport } from './retention.service';

/** Admin: bakım işleri (elle tetikleme). Tekrarlı iş zaten periyodik çalışır. */
@Controller('admin/maintenance')
@UseGuards(AdminGuard)
export class MaintenanceController {
  constructor(
    private readonly expiry: ExpiryService,
    private readonly reconcile: ReconcileService,
    private readonly retention: RetentionService,
  ) {}

  /** Süre-bitişi taramasını elle çalıştırır (ops + doğrulama). */
  @Post('expire')
  async expire(): Promise<{ expired: number }> {
    return { expired: await this.expiry.sweepExpired() };
  }

  /**
   * Mutabakat/tutarlılık denetimini elle çalıştırır — düzeltme yapmaz, özet döndürür (§16).
   *
   * `?full=true` → SICAK-yol penceresi (varsayılan son 30 gün) KALDIRILIR, tüm geçmiş
   * taranır. Zamanlanmış haftalık TAM koşu da aynı yolu kullanır; bu parametre olay
   * incelemesinde "şimdi bak" demek içindir. Tam tarama pahalıdır (order_lines +
   * assignments tam tarama) → varsayılan bilinçli olarak sıcak penceredir.
   */
  @Post('reconcile')
  async runReconcile(@Query('full') full?: string): Promise<ReconcileReport> {
    return this.reconcile.reconcile(full === 'true' || full === '1');
  }

  /** Saklama/budama koşusunu elle çalıştırır (§9 KVKK + §16) — tablo-bazlı sayaç özeti döndürür. */
  @Post('retention')
  async runRetention(): Promise<RetentionReport> {
    return this.retention.runRetention();
  }
}
