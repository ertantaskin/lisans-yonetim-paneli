import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { DEPLOY_TARGETS, DeploymentsService } from './deployments.service';

const RequestSchema = z.object({ target: z.enum(DEPLOY_TARGETS) });
type RequestInput = z.infer<typeof RequestSchema>;

const FinishSchema = z.object({
  status: z.enum(['success', 'failed']),
  gitSha: z.string().max(80).optional(),
  log: z.string().max(200000).optional(),
  error: z.string().max(8000).optional(),
});
type FinishInput = z.infer<typeof FinishSchema>;

/**
 * Admin: panelden prod dağıtımı yönetimi (§16). Tüm uçlar X-Admin-Token korumalı.
 * - POST         → yeni dağıtım İSTEĞİ kaydeder (owner-only Next katmanında zorlanır).
 * - GET          → dağıtım geçmişi (salt-okunur görünüm).
 * - POST /claim  → VPS host runner'ının bekleyen isteği atomik alması.
 * - PATCH /:id/finish → runner'ın sonucu (success/failed + log/sha) geri yazması.
 *
 * Panel yalnız KAYIT tutar; gerçek `deploy.sh` çağrısını host'taki runner yapar
 * (API konteynerine Docker soketi VERİLMEZ — güvenlik).
 */
@Controller('admin/deployments')
@UseGuards(AdminGuard)
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @Post()
  async request(@Body(new ZodBody(RequestSchema)) body: RequestInput, @AdminActor() actor: string) {
    return this.deployments.request(body.target, actor);
  }

  @Get()
  async list() {
    return this.deployments.list();
  }

  /** Runner: bekleyen en eski isteği claim et (pending→running). Yoksa null. */
  @Post('claim')
  async claim() {
    const row = await this.deployments.claimNext();
    return row ?? {};
  }

  /** Runner: dağıtım sonucunu yaz. */
  @Patch(':id/finish')
  async finish(@Param('id') id: string, @Body(new ZodBody(FinishSchema)) body: FinishInput) {
    const row = await this.deployments.finish(id, body.status, {
      gitSha: body.gitSha,
      log: body.log,
      error: body.error,
    });
    return row ?? {};
  }
}
