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
import { AdminGuard } from '../auth/admin.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { AiSupportService } from './ai-support.service';

/**
 * Redis sabit-pencere hız sınırı (IP başına) — triyaj ucu paylaşılan ADMIN_TOKEN arkasında
 * olsa da AI çağrısı maliyetli/DoS'a açık olduğundan hafif bir ek kalkan. RateLimitService
 * dağıtık + restart-dayanıklı sayaç tutar; kotayı aşınca 429 atar.
 */
const AI_RL_WINDOW_SEC = 60;
const AI_RL_MAX = 20; // dakikada 20 istek/IP

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
  async suggest(@Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string) {
    if (!(await this.rateLimit.hit(`ai:support:${ip}`, AI_RL_MAX, AI_RL_WINDOW_SEC))) {
      throw new HttpException(
        'Çok fazla AI isteği. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.support.suggest(id);
  }
}
