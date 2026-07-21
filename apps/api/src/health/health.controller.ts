import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import type { HealthResponse } from '@jetlisans/shared';
import { HealthService } from './health.service';

/** GET /v1/health — bağlantı testi (§4). */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * db+redis ping geçerse 200 + {status:'ok'}; herhangi biri düşerse 503 + {status:'degraded'}
   * (BULGU 2). Eskiden degraded'da bile 200 dönüyordu → monitor paneli sağlıklı sanıyordu.
   * Gövde KORUNUR: HttpException(gövde, kod) — obje aynen JSON yanıt gövdesi olur, yalnız HTTP
   * durumu 503'e çıkar (global exception filter yok → NestJS varsayılanı objeyi olduğu gibi döner).
   */
  @Get()
  async check(): Promise<HealthResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }
}
