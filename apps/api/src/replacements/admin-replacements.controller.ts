import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { ReplacementsService } from './replacements.service';

// `actor` alanı LEGACY (geriye dönük tolerans) — OKUNMAZ. Gerçek aktör yalnız güvenilir
// @AdminActor (x-admin-actor header) kaynağından gelir; body ile SPOOF edilemez (supply-ops deseni).
const ApproveBody = z.object({ actor: z.string().optional() });
const NoteBody = z.object({ note: z.string().min(1), actor: z.string().optional() });

/**
 * Admin mesajı. `internal=true` → yalnız panelde görünen İÇ NOT (müşteriye ne mail gider
 * ne de site-facing uçtan döner). Varsayılan false = müşteriye görünen yanıt + bildirim maili.
 */
const AdminMessageBody = z.object({
  body: z.string().min(1).max(4000),
  internal: z.boolean().optional(),
});
type AdminMessageBody = z.infer<typeof AdminMessageBody>;

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
    @AdminActor() actor: string,
  ) {
    // actor yalnız oturumdan (header) gelir; reject/approve ile tutarlı → izlenebilir (spoof edilemez).
    return this.replacements.requestInfo(id, body.note, actor);
  }

  /** Yazışmanın TAMAMI (iç notlar DAHİL — yalnız admin yolu). */
  @Get(':id/messages')
  messages(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.replacements.listMessages(id, { includeInternal: true });
  }

  /**
   * Cevap yaz (kullanıcı isteği: "CEVAP VERME gibi bir şansımız olmuyor").
   * Mesaj eklemek talebin DURUMUNU DEĞİŞTİRMEZ — durum geçişi ayrı aksiyondur
   * (approve/reject/request-info). Kapanmış talebe de yazılabilir (izlenebilirlik).
   */
  @Post(':id/messages')
  addMessage(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(AdminMessageBody)) body: AdminMessageBody,
    @AdminActor() actor: string,
  ) {
    return this.replacements.addAdminMessage(id, body, actor);
  }
}
