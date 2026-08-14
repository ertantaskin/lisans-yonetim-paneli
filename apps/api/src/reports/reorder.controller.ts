import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { ReorderService, type ReorderReport } from './reorder.service';

/**
 * Admin: yeniden-sipariş önerisi ("tedarik süresi içinde tükenecekler") — salt-okunur.
 * Prefix ReportsController ile ortak ('admin/reports'), route farklı ('reorder').
 *
 * Parametresizdir: formülün girdileri (pencere/emniyet payı/hedef stok günü) sunucudaki
 * SABİTLERDİR ve yanıtta `params` ile döner. Operatör bunları ekrandan değiştirebilseydi
 * aynı raporun iki farklı sayısı dolaşıma girerdi.
 */
@Controller('admin/reports')
@UseGuards(AdminGuard)
export class ReorderController {
  constructor(private readonly reorder: ReorderService) {}

  /** Ürün başına tükenme tahmini × tedarik süresi → şimdi sipariş edilmesi gerekenler. */
  @Get('reorder')
  async getReorderReport(): Promise<ReorderReport> {
    return this.reorder.report();
  }
}
