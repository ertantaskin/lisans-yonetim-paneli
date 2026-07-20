import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { ReplacementsService } from './replacements.service';

const ApproveBody = z.object({ actor: z.string().optional() });
const NoteBody = z.object({ note: z.string().min(1), actor: z.string().optional() });

/** Admin: değişim talebi operasyonları (§13). ADMIN_TOKEN gerektirir. */
@Controller('admin/replacements')
@UseGuards(AdminGuard)
export class AdminReplacementsController {
  constructor(private readonly replacements: ReplacementsService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.replacements.list(status);
  }

  /** Onayla → eskiyi geri al + yenisini ata. Stok yoksa 409. */
  @Post(':id/approve')
  approve(
    @Param('id') id: string,
    @Body(new ZodBody(ApproveBody)) body: z.infer<typeof ApproveBody>,
  ) {
    return this.replacements.approve(id, body.actor ?? 'panel:admin');
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @Body(new ZodBody(NoteBody)) body: z.infer<typeof NoteBody>) {
    return this.replacements.reject(id, body.note, body.actor ?? 'panel:admin');
  }

  @Post(':id/request-info')
  requestInfo(
    @Param('id') id: string,
    @Body(new ZodBody(NoteBody)) body: z.infer<typeof NoteBody>,
  ) {
    return this.replacements.requestInfo(id, body.note);
  }
}
