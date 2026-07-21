import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { CostsService, type CostReport } from './costs.service';

/**
 * Admin: maliyet raporu (salt-okunur agregasyon, §12/§13). KÂR değil, yalnız
 * MALİYET (PO unit_cost). Prefix ReportsController ile ortak ('admin/reports')
 * ancak route farklı ('costs') — Nest çakışma yaşamaz.
 */
@Controller('admin/reports')
@UseGuards(AdminGuard)
export class CostsController {
  constructor(private readonly costs: CostsService) {}

  /** Maliyet raporu: tedarikçi/ay/ürün harcaması + stok değerleme + fire. */
  @Get('costs')
  async getCostReport(): Promise<CostReport> {
    return this.costs.getCostReport();
  }
}
