import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { DEPLOY_TARGETS, DeploymentsService } from './deployments.service';

// note: hedefe özel serbest metin — 'plugin' hedefinde sürüm changelog'u (runner claim
// yanıtından okur). max(2000) servisin MAX_NOTE_CHARS .slice değeriyle HİZALI.
const RequestSchema = z.object({
  target: z.enum(DEPLOY_TARGETS),
  note: z.string().max(2000).optional(),
});
type RequestInput = z.infer<typeof RequestSchema>;

// log/error üst sınırları servisin .slice değerleriyle HİZALI (MAX_LOG_CHARS=20000 / 4000).
// Runner de göndermeden jq içinde bu sınırlara kısaltır → tutarsız cap yüzünden 400 olmaz.
const FinishSchema = z.object({
  status: z.enum(['success', 'failed']),
  gitSha: z.string().max(80).optional(),
  log: z.string().max(20000).optional(),
  error: z.string().max(4000).optional(),
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
 * (API konteynerine Docker soketi VERİLMEZ — güvenlik). 'plugin' hedefinde runner
 * deploy.sh yerine eklenti zip'ini üretip panele publish eder (aynı istek/çalıştırma ayrımı).
 */
@Controller('admin/deployments')
@UseGuards(AdminGuard)
export class DeploymentsController {
  constructor(private readonly deployments: DeploymentsService) {}

  @Post()
  async request(@Body(new ZodBody(RequestSchema)) body: RequestInput, @AdminActor() actor: string) {
    return this.deployments.request(body.target, actor, body.note);
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
