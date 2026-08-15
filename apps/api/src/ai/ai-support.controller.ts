import {
  Controller,
  HttpException,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { AiSupportService } from './ai-support.service';
import { AI_RL_MAX, AI_RL_WINDOW_SEC, aiRateKey } from './ai-rate-key';


/**
 * Admin: AI destek triyajı (§15). Destek kuyruğundaki bir talebi AI kategorize eder +
 * müşteriye TASLAK cevap üretir; insan onaylar/düzenler. OTOMATİK GÖNDERİM YOK — yalnız öneri.
 * Global prefix ile: POST /v1/admin/ai/support/:id/suggest.
 */
@Controller('admin/ai/support')
@UseGuards(AdminGuard)
export class AiSupportController {
  constructor(
    private readonly support: AiSupportService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post(':id/suggest')
  async suggest(@Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string, @AdminActor() actor: string) {
    if (!(await this.rateLimit.hit(aiRateKey('support', actor, ip), AI_RL_MAX, AI_RL_WINDOW_SEC))) {
      throw new HttpException(
        'Çok fazla AI isteği. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.support.suggest(id);
  }
}
