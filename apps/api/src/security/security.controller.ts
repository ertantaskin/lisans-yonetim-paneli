import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { ComplianceService, type AnonymizeResult } from './compliance.service';
import { SecurityService } from './security.service';
import type { SecurityEvent } from '../db/schema/securityEvents';

const AnonymizeBody = z.object({ email: z.string().trim().email() });

/** Admin: güvenlik/anomali izi + KVKK anonimleştirme (§5/§9/§15). ADMIN_TOKEN gerektirir. */
@Controller('admin')
@UseGuards(AdminGuard)
export class SecurityController {
  constructor(
    private readonly security: SecurityService,
    private readonly compliance: ComplianceService,
  ) {}

  /** Güvenlik olaylarını listeler (opsiyonel ?type=velocity|quota_exceeded|anomaly|blocklist). */
  @Get('security-events')
  listEvents(@Query('type') type?: string): Promise<SecurityEvent[]> {
    return this.security.listEvents(type);
  }

  /** Anomali taramasını elle tetikler → { created }. */
  @Post('security/scan')
  scan(): Promise<{ created: number }> {
    return this.security.scan();
  }

  /**
   * KVKK anonimleştirme (§9) — verilen e-postaya ait tüm PII'yi maskeler. Tek yönlü;
   * kritik aksiyon → audit'e düşer. GET yok.
   */
  // OwnerGuard (denetim A3): KVKK PII imhası GERİ ALINAMAZ → owner-only (deployments/releases/admin-CRUD
  // emsalleriyle simetrik savunma-derinliği). Next zaten isOwner() + x-admin-role iletir.
  @Post('compliance/anonymize')
  @UseGuards(OwnerGuard)
  anonymize(
    @Body(new ZodBody(AnonymizeBody)) body: { email: string },
    @AdminActor() actor: string,
  ): Promise<AnonymizeResult> {
    return this.compliance.anonymize(body.email, actor);
  }
}
