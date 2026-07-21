import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { PresenceService } from './presence.service';

/** Heartbeat gövde şeması — kaynak anahtarı + actor kimliği (Next proxy enjekte eder). */
const HeartbeatSchema = z.object({
  resource: z.string().min(1).max(200),
  actor: z.string().min(1).max(200),
});
type HeartbeatBody = z.infer<typeof HeartbeatSchema>;

/**
 * Operatör presence uçları (§14). Yalnız Next admin sunucusu (proxy) çağırır —
 * tarayıcı ADMIN_TOKEN gönderemez, actor oturumdan enjekte edilir.
 */
@Controller('admin/presence')
@UseGuards(AdminGuard)
export class PresenceController {
  constructor(private readonly presence: PresenceService) {}

  /** Varlığı tazeler + o kaynaktaki tüm canlı operatörleri döndürür. */
  @Post('heartbeat')
  async heartbeat(
    @Body(new ZodBody(HeartbeatSchema)) body: HeartbeatBody,
  ): Promise<{ present: string[] }> {
    await this.presence.heartbeat(body.resource, body.actor);
    return { present: await this.presence.list(body.resource) };
  }

  /** Bir kaynaktaki canlı operatörler (yalnız okuma). resource yoksa boş liste. */
  @Get()
  async list(@Query('resource') resource?: string): Promise<{ present: string[] }> {
    return { present: resource ? await this.presence.list(resource) : [] };
  }
}
