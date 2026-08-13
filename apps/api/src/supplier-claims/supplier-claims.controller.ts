import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminRole, canRevealPlaintext } from '../auth/admin-role.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { SupplierClaimsService } from './supplier-claims.service';

const CandidatesQuery = z.object({
  supplierId: z.string().uuid(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
});
type CandidatesQuery = z.infer<typeof CandidatesQuery>;

const ListQuery = z.object({
  status: z.union([z.literal(''), z.enum(['draft', 'sent', 'closed', 'canceled'])]).optional(),
  supplierId: z.union([z.literal(''), z.string().uuid()]).optional(),
});
type ListQuery = z.infer<typeof ListQuery>;

const CreateClaimBody = z.object({
  supplierId: z.string().uuid(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  // Operatörün listeden çıkardıkları. Üst sınır aday tavanıyla (2000) hizalı.
  excludeLicenseItemIds: z.array(z.string().uuid()).max(2000).optional(),
  note: z.string().max(2000).optional(),
});
type CreateClaimBody = z.infer<typeof CreateClaimBody>;

const UpdateClaimBody = z.object({
  status: z.enum(['sent', 'closed', 'canceled']).optional(),
  reference: z.string().max(200).optional(),
  note: z.string().max(2000).optional(),
});
type UpdateClaimBody = z.infer<typeof UpdateClaimBody>;

const UpdateItemsBody = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(2000),
  outcome: z.enum(['pending', 'replaced', 'credited', 'rejected']),
  note: z.string().max(500).optional(),
});
type UpdateItemsBody = z.infer<typeof UpdateItemsBody>;

/** '' → undefined (süzgeç yok). */
const blank = (v?: string): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};

/**
 * Tedarikçi değişim fişleri (§12). ADMIN_TOKEN gerektirir (sınıf düzeyinde `AdminGuard`).
 *
 * Düz-metin politikası sipariş detayı / envanter / karantina ile SİMETRİK: owner (ya da auth
 * KAPALI) tam anahtarı görür, owner-olmayan admin maskeli görür. Fiş KESİLİRKEN de aynı yetki
 * uygulanır — çünkü snapshot KALICIDIR: owner-olmayan bir admin fiş keserse dosyaya düz anahtar
 * yazılmaz ve o fiş sonradan owner tarafından açılsa bile maskeli kalır (bilinçli: fişin içeriği
 * "kesildiği andaki yetkiyle" dondurulur).
 */
@Controller('admin/supplier-claims')
@UseGuards(AdminGuard)
export class SupplierClaimsController {
  constructor(private readonly claims: SupplierClaimsService) {}

  /** Z raporu adayları: pencerede biriken, henüz bildirilmemiş kusurlular. */
  @Get('candidates')
  candidates(
    @Query(new ZodBody(CandidatesQuery)) q: CandidatesQuery,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    return this.claims.candidates({
      supplierId: q.supplierId,
      from: blank(q.from),
      to: blank(q.to),
      reveal: canRevealPlaintext(role),
      actor,
    });
  }

  @Get()
  list(@Query(new ZodBody(ListQuery)) q: ListQuery) {
    return this.claims.list({ status: blank(q.status), supplierId: blank(q.supplierId) });
  }

  @Get(':id')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.claims.detail(id);
  }

  @Post()
  create(
    @Body(new ZodBody(CreateClaimBody)) body: CreateClaimBody,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    return this.claims.create(body, actor, canRevealPlaintext(role));
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateClaimBody)) body: UpdateClaimBody,
    @AdminActor() actor: string,
  ) {
    return this.claims.updateStatus(id, body, actor);
  }

  @Patch(':id/items')
  updateItems(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateItemsBody)) body: UpdateItemsBody,
    @AdminActor() actor: string,
  ) {
    return this.claims.updateItems(id, body, actor);
  }
}
