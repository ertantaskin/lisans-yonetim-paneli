import { Body, Controller, HttpException, HttpStatus, Ip, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { ZodBody } from '../common/zod-validation.pipe';
import { AiReportService, type AiReportResult } from './ai-report.service';

/** Doğal dilde rapor isteği — Türkçe soru (§15 NL→SQL). */
const ReportBody = z.object({ question: z.string().trim().min(3).max(500) });

/**
 * Redis sabit-pencere hız sınırı — AI uçları paylaşılan ADMIN_TOKEN arkasında olsa da AI çağrısı
 * maliyetli/DoS'a açık olduğundan hafif bir ek kalkan. RateLimitService dağıtık + restart-dayanıklı
 * sayaç tutar; kotayı aşınca çağıran 429 üretir.
 *
 * KOVA ANAHTARI = ADMİN AKTÖRÜ, IP DEĞİL (düzeltme): panel uçlarına istekler Next admin sunucusu
 * üzerinden PROXY'lenir → API'nin gördüğü IP tüm operatörler için AYNIDIR (tek Caddy/Next hop).
 * "IP başına" sınır bu yüzden pratikte TEK GLOBAL kovaya çöküyordu: bir operatör kotayı doldurunca
 * diğer TÜM operatörler kilitleniyordu. Aktör kimliği (x-admin-actor, ADMIN_TOKEN ile aynı güven
 * düzeyi — bkz. AdminActor) kova başına gerçek kullanıcıyı ayırır. Aktör yoksa/varsayılansa
 * ('panel:admin' — auth KAPALI kurulum ya da sistem çağrısı) IP'ye geri düşülür; o kurulumda
 * zaten tek bir operatör vardır ve panel ADMIN_TOKEN ile korunur.
 */
const AI_RL_WINDOW_SEC = 60;
const AI_RL_MAX = 20; // dakikada 20 istek (aktör başına; aktör yoksa IP başına)

/** Aktör bilinmiyorsa IP'ye düşen kova anahtarı üretir (tek kaynak — diğer AI uçları da kullanmalı). */
function aiRateKey(scope: string, actor: string | undefined, ip: string): string {
  const known = actor && actor !== 'panel:admin' ? actor : null;
  return known ? `ai:${scope}:actor:${known}` : `ai:${scope}:ip:${ip}`;
}

/**
 * Admin: doğal dilde rapor / NL→SQL (§15). Türkçe soru → AI salt-okunur SELECT üretir →
 * çalıştırılır → SQL + sonuç döner (SQL her zaman gösterilir). AdminGuard (ADMIN_TOKEN)
 * gerektirir. AI kapalıysa 503 (AiUnavailableException) döner; UI yakalar.
 */
@Controller('admin/ai')
@UseGuards(AdminGuard)
export class AiReportController {
  constructor(
    private readonly report: AiReportService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Türkçe soruyu SELECT'e çevirir ve salt-okunur çalıştırır → /v1/admin/ai/report. */
  @Post('report')
  async run(
    @Body(new ZodBody(ReportBody)) body: { question: string },
    @Ip() ip: string,
    @AdminActor() actor: string,
  ): Promise<AiReportResult> {
    if (!(await this.rateLimit.hit(aiRateKey('report', actor, ip), AI_RL_MAX, AI_RL_WINDOW_SEC))) {
      throw new HttpException(
        'Çok fazla AI isteği. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.report.report(body.question);
  }
}
