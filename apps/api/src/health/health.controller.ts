import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@jetlisans/shared';
import { HealthService } from './health.service';

/** GET /v1/health — bağlantı testi (§4). */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  check(): Promise<HealthResponse> {
    return this.health.check();
  }
}
