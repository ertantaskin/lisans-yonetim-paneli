import { Body, Controller, HttpException, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { AiReportService, type AiReportResult } from './ai-report.service';

/** Doğal dilde rapor isteği — Türkçe soru (§15 NL→SQL). */
const ReportBody = z.object({ question: z.string().trim().min(3).max(500) });

/**
 * Basit bellek-içi sabit-pencere hız sınırı (IP başına) — AI uçları paylaşılan ADMIN_TOKEN
 * arkasında olsa da AI çağrısı maliyetli/DoS'a açık olduğundan hafif bir ek kalkan. Tek-süreç
 * varsayar; süresi geçen kova tembel sıfırlanır, harita büyürse fırsatçı temizlenir. Kotayı
 * aşınca çağıran 429 üretir.
 */
const AI_RL_WINDOW_MS = 60_000;
const AI_RL_MAX = 20; // dakikada 20 istek/IP
const aiRlBuckets = new Map<string, { count: number; resetAt: number }>();

function aiReportRateLimit(ip: string): void {
  const now = Date.now();
  const key = `report:${ip}`;
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
 * Admin: doğal dilde rapor / NL→SQL (§15). Türkçe soru → AI salt-okunur SELECT üretir →
 * çalıştırılır → SQL + sonuç döner (SQL her zaman gösterilir). AdminGuard (ADMIN_TOKEN)
 * gerektirir. AI kapalıysa 503 (AiUnavailableException) döner; UI yakalar.
 */
@Controller('admin/ai')
@UseGuards(AdminGuard)
export class AiReportController {
  constructor(private readonly report: AiReportService) {}

  /** Türkçe soruyu SELECT'e çevirir ve salt-okunur çalıştırır → /v1/admin/ai/report. */
  @Post('report')
  run(
    @Body(new ZodBody(ReportBody)) body: { question: string },
    @Ip() ip: string,
  ): Promise<AiReportResult> {
    aiReportRateLimit(ip);
    return this.report.report(body.question);
  }
}
