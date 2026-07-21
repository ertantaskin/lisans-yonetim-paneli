import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { RiskScoreService } from './risk-score.service';

/**
 * Admin: müşteri ADVISORY risk skoru (§8/§9). Okuma-anında türetilir — KALICI YOK,
 * OTOMATİK EYLEM YOK; yalnız operatöre şeffaf sinyal ("panel önerir, insan karar verir").
 * Global prefix ile: GET /v1/admin/customers/:email/risk. ADMIN_TOKEN gerektirir.
 *
 * e-posta path param'ı Fastify router'ı tarafından yüzde-çözülür (customers.controller
 * deseniyle aynı); servis ayrıca trim+lowercase kanonikleştirir. Dönüş tipi servisten
 * akar (yerel re-declare YOK).
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class RiskScoreController {
  constructor(private readonly riskScore: RiskScoreService) {}

  @Get('customers/:email/risk')
  risk(@Param('email') email: string) {
    return this.riskScore.scoreCustomer(email);
  }
}
