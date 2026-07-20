import { Controller, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { ExpiryService } from './expiry.service';

/** Admin: bakım işleri (elle tetikleme). Tekrarlı iş zaten periyodik çalışır. */
@Controller('admin/maintenance')
@UseGuards(AdminGuard)
export class MaintenanceController {
  constructor(private readonly expiry: ExpiryService) {}

  /** Süre-bitişi taramasını elle çalıştırır (ops + doğrulama). */
  @Post('expire')
  async expire(): Promise<{ expired: number }> {
    return { expired: await this.expiry.sweepExpired() };
  }
}
