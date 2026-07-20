import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { DashboardService, type DashboardSummary } from './dashboard.service';

/** Admin: genel-bakış (dashboard) KPI özeti (salt-okunur agregasyon, §13). */
@Controller('admin/dashboard')
@UseGuards(AdminGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Panel genel-bakış: bekleyen satır / bugünkü sipariş / düşük stok / açık talep / güvenlik / stok + son siparişler. */
  @Get()
  async summary(): Promise<DashboardSummary> {
    return this.dashboard.summary();
  }
}
