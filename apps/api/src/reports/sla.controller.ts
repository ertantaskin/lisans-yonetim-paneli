import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { SlaService, type SlaReport } from './sla.service';

/**
 * Admin: teslimat süresi (SLA) raporu — salt-okunur agregasyon (§18).
 *
 * Prefix ReportsController/CostsController ile ortak ('admin/reports'), route farklı ('sla').
 *
 * `days` DTO ile değil `SlaService.normalizeDays` ile sınırlanır: rapor okuma yolunda geçersiz
 * bir gün sayısı 400 ile ekranı boşaltmak yerine varsayılana düşmelidir (adres çubuğundan elle
 * gelen `?days=abc` operatöre hata değil, 30 günlük rapor göstersin). Üst sınır (90) tarama
 * maliyetini sabitler.
 */
@Controller('admin/reports')
@UseGuards(AdminGuard)
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  /** Teslimat süresi: gün serisi + mağaza/ürün kırılımı (p50/p95 dâhil). */
  @Get('sla')
  async getSlaReport(@Query('days') days?: string): Promise<SlaReport> {
    return this.sla.report(days);
  }
}
