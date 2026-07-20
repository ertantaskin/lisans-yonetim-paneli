import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { ReportsService, type ReportsOverview } from './reports.service';

/** Admin: raporlar (salt-okunur agregasyon, §18). */
@Controller('admin/reports')
@UseGuards(AdminGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Panel genel bakış: sipariş/teslim/stok/hız/değişim özetleri. */
  @Get('overview')
  async overview(): Promise<ReportsOverview> {
    return this.reports.overview();
  }
}
