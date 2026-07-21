import { Body, Controller, Ip, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { OnboardingService } from './onboarding.service';

const ClaimBody = z.object({
  code: z.string().min(4),
});
type ClaimBody = z.infer<typeof ClaimBody>;

/**
 * Admin: site onboarding — tek-seferlik bağlan kodu üretimi (§14). ADMIN_TOKEN gerektirir.
 * Global prefix ile: POST /v1/admin/onboarding/sites/:id/connect-code.
 */
@Controller('admin/onboarding')
@UseGuards(AdminGuard)
export class OnboardingAdminController {
  constructor(private readonly onboarding: OnboardingService) {}

  /**
   * Site için tek-seferlik bağlan kodu üretir. Site creds'i yenilenir; yalnız {code, expiresAt}
   * döner (creds koda gömülü, şifreli saklı — claim'de teslim edilir).
   */
  @Post('sites/:id/connect-code')
  connectCode(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.onboarding.issueConnectCode(id);
  }
}

/**
 * PUBLIC: WP eklentisinin kodu creds'e çevirdiği uç (§14). GUARD YOK — koruma tamamen
 * kodun kendisindedir: tek-kullanımlık + 15dk + yüksek entropi + IP rate-limit. Creds
 * teslimden hemen sonra DB'den silinir. Global prefix ile: POST /v1/connect/claim.
 */
@Controller('connect')
export class ConnectController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Post('claim')
  claim(@Body(new ZodBody(ClaimBody)) body: ClaimBody, @Ip() ip: string) {
    return this.onboarding.claim(body.code, ip);
  }
}
