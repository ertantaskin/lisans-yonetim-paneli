import { Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { CreateOrderRequest, type CreateOrderResponse } from '@jetlisans/shared';
import { HmacGuard } from '../auth/hmac.guard';
import { CurrentSite } from '../auth/current-site.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import type { Site } from '../db/schema';
import { OrdersService } from './orders.service';
import { SalesQuotaGuard } from './sales-quota.guard';

/** Site-facing sipariş uçları (§4). HMAC imzalı. */
@Controller('orders')
@UseGuards(HmacGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // SalesQuotaGuard: HmacGuard'dan SONRA (kota ön-kontrolü). createOrder gövdesi DEĞİŞMEZ.
  @Post()
  @UseGuards(SalesQuotaGuard)
  async create(
    @CurrentSite() site: Site,
    @Body(new ZodBody(CreateOrderRequest)) body: CreateOrderRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<CreateOrderResponse> {
    const outcome = await this.orders.createOrder(site, body);
    // 201 fully / 207 partial / 202 pending_stock (§4)
    reply.status(outcome.httpStatus);
    return outcome.body;
  }

  /** Müşteri ekranı: yalnız aktif atamalar + çözülmüş payload (§4, §7). */
  @Get(':id/deliveries')
  deliveries(@CurrentSite() site: Site, @Param('id') id: string) {
    return this.orders.getDeliveries(site, id);
  }
}
