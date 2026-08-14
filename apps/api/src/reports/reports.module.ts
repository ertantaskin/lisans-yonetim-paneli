import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';
import { SlaController } from './sla.controller';
import { SlaService } from './sla.service';
import { ReorderController } from './reorder.controller';
import { ReorderService } from './reorder.service';

/**
 * Raporlar modülü (§18). AdminGuard yalnız global ConfigService'e bağlı olduğundan
 * (MaintenanceModule deseni) ek import gerektirmez; controller @UseGuards ile kullanır.
 *
 * Üç salt-okunur rapor yüzeyi (hepsi MEVCUT tablolardan, migration YOK):
 *  - ReportsService : genel bakış (sipariş/teslim/stok/hız/değişim)
 *  - SlaService     : teslimat süresi / bekleme (p50 · p95, mağaza & ürün kırılımı)
 *  - ReorderService : yeniden-sipariş önerisi (tükenme tahmini × tedarik süresi)
 */
@Module({
  controllers: [ReportsController, SlaController, ReorderController],
  providers: [ReportsService, SlaService, ReorderService],
  exports: [ReportsService, SlaService, ReorderService],
})
export class ReportsModule {}
