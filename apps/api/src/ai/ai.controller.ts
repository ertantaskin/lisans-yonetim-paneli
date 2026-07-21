import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { AiService } from './ai.service';

/**
 * Admin: AI durum ucu (§15). UI "AI kapalı" sarı bandı + özellik gizleme için kullanır.
 * SIR DÖNMEZ (API anahtarı asla dönmez) — yalnız açık/kapalı + aktif model adı.
 */
@Controller('admin/ai')
@UseGuards(AdminGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status() {
    const enabled = this.ai.enabled();
    return { enabled, model: enabled ? this.ai.model() : null };
  }
}
