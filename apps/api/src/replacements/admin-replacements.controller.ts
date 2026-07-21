import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { ReplacementsService } from './replacements.service';

// `actor` alanı LEGACY (geriye dönük tolerans) — OKUNMAZ. Gerçek aktör yalnız güvenilir
// @AdminActor (x-admin-actor header) kaynağından gelir; body ile SPOOF edilemez (supply-ops deseni).
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
    @AdminActor() actor: string,
  ) {
    // actor yalnız oturumdan (x-admin-actor header) gelir; body.actor legacy/yok sayılır
    // → audit_log doğru admin'e atanır, spoof edilemez (supply-ops deseniyle hizalı).
    void body;
    return this.replacements.approve(id, actor);
  }

  @Post(':id/reject')
  reject(
    @Param('id') id: string,
    @Body(new ZodBody(NoteBody)) body: z.infer<typeof NoteBody>,
    @AdminActor() actor: string,
  ) {
    // actor yalnız oturumdan (header) gelir; body.actor legacy/yok sayılır (spoof edilemez).
    return this.replacements.reject(id, body.note, actor);
  }

  @Post(':id/request-info')
  requestInfo(
    @Param('id') id: string,
    @Body(new ZodBody(NoteBody)) body: z.infer<typeof NoteBody>,
  ) {
    return this.replacements.requestInfo(id, body.note);
  }
}
