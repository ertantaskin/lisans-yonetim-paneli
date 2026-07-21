import { Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AiSupportService } from './ai-support.service';

/**
 * Admin: AI destek triyajı (§15). Destek kuyruğundaki bir talebi AI kategorize eder +
 * müşteriye TASLAK cevap üretir; insan onaylar/düzenler. OTOMATİK GÖNDERİM YOK — yalnız öneri.
 * Global prefix ile: POST /v1/admin/ai/support/:id/suggest.
 */
@Controller('admin/ai/support')
@UseGuards(AdminGuard)
export class AiSupportController {
  constructor(private readonly support: AiSupportService) {}

  @Post(':id/suggest')
  suggest(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.support.suggest(id);
  }
}
