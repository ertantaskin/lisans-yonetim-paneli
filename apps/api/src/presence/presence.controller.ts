import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { PresenceService } from './presence.service';

/**
 * Heartbeat gövde şeması — YALNIZ kaynak anahtarı. Actor artık gövdeden okunmaz:
 * gövde-actor istemci tarafından sahtelenebilirdi (başka operatörün kimliğiyle presence
 * enjekte etme). Kimlik, kod tabanındaki diğer admin uçlarıyla (saved-views vb.) aynı
 * desende `x-admin-actor` başlığından (@AdminActor) gelir — token'la aynı güven düzeyi.
 */
const HeartbeatSchema = z.object({
  resource: z.string().min(1).max(200),
});
type HeartbeatBody = z.infer<typeof HeartbeatSchema>;

/**
 * Operatör presence uçları (§14). Yalnız Next admin sunucusu (proxy) çağırır —
 * tarayıcı ADMIN_TOKEN gönderemez, actor oturumdan `x-admin-actor` başlığıyla iletilir.
 */
@Controller('admin/presence')
@UseGuards(AdminGuard)
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  /** Varlığı tazeler + o kaynaktaki tüm canlı operatörleri döndürür. */
  @Post('heartbeat')
  async heartbeat(
    @AdminActor() actor: string,
    @Body(new ZodBody(HeartbeatSchema)) body: HeartbeatBody,
  ): Promise<{ present: string[] }> {
    await this.presence.heartbeat(body.resource, actor);
    return { present: await this.presence.list(body.resource) };
  }

  /** Bir kaynaktaki canlı operatörler (yalnız okuma). resource yoksa boş liste. */
  @Get()
  async list(@Query('resource') resource?: string): Promise<{ present: string[] }> {
    return { present: resource ? await this.presence.list(resource) : [] };
  }
}
