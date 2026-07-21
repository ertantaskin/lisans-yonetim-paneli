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
import { AiSupportService } from './ai-support.service';

/**
 * Basit bellek-içi sabit-pencere hız sınırı (IP başına) — triyaj ucu paylaşılan ADMIN_TOKEN
 * arkasında olsa da AI çağrısı maliyetli/DoS'a açık olduğundan hafif bir ek kalkan. Tek-süreç
 * varsayar; süresi geçen kova tembel sıfırlanır, harita büyürse fırsatçı temizlenir. Kotayı
 * aşınca 429 atar.
 */
const AI_RL_WINDOW_MS = 60_000;
const AI_RL_MAX = 20; // dakikada 20 istek/IP
const aiRlBuckets = new Map<string, { count: number; resetAt: number }>();

function aiSupportRateLimit(ip: string): void {
  const now = Date.now();
  const key = `support:${ip}`;
  const bucket = aiRlBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (aiRlBuckets.size > 5000) {
      for (const [k, v] of aiRlBuckets) if (now >= v.resetAt) aiRlBuckets.delete(k);
    }
    aiRlBuckets.set(key, { count: 1, resetAt: now + AI_RL_WINDOW_MS });
    return;
  }
  if (bucket.count >= AI_RL_MAX) {
    throw new HttpException(
      'Çok fazla AI isteği. Kısa süre sonra tekrar deneyin.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
  bucket.count += 1;
}

/**
 * Admin: AI destek triyajı (§15). Destek kuyruğundaki bir talebi AI kategorize eder +
 * müşteriye TASLAK cevap üretir; insan onaylar/düzenler. OTOMATİK GÖNDERİM YOK — yalnız öneri.
 * Global prefix ile: POST /v1/admin/ai/support/:id/suggest.
 */
@Controller('admin/ai/support')
@UseGuards(AdminGuard)
export class AiSupportController {
  constructor(private readonly support: AiSupportService) {}

  @Post(':id/suggest')
  suggest(@Param('id', new ParseUUIDPipe()) id: string, @Ip() ip: string) {
    aiSupportRateLimit(ip);
    return this.support.suggest(id);
  }
}
