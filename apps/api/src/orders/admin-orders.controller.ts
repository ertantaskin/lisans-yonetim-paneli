import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { AdminOrdersService } from './admin-orders.service';
import { FulfillmentService } from './fulfillment.service';

const RevokeBody = z.object({ reason: z.string().min(1) });

/** Admin: sipariş operasyonları (§13). ADMIN_TOKEN gerektirir. */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminOrdersController {
  constructor(
    private readonly adminOrders: AdminOrdersService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  @Get('orders')
  list(@Query('status') status?: string) {
    return this.adminOrders.list(status);
  }

  /** Bekleyen Teslimatlar ana ekranı. */
  @Get('pending')
  pending() {
    return this.adminOrders.pending();
  }

  @Get('orders/:id')
  detail(@Param('id') id: string) {
    return this.adminOrders.detail(id);
  }

  /** "Kalanları Ata" (units yok) / "N Adet Ata" (?units=N) — gövdesiz (§13). */
  @Post('fulfillments/:lineId/complete')
  complete(@Param('lineId') lineId: string, @Query('units') units?: string) {
    const n = units ? Number.parseInt(units, 10) : undefined;
    return this.fulfillment.completeLine(lineId, n && n > 0 ? n : undefined);
  }

  @Post('assignments/:id/revoke')
  revoke(@Param('id') id: string, @Body(new ZodBody(RevokeBody)) body: { reason: string }) {
    return this.adminOrders.revokeAssignment(id, body.reason, 'panel:admin');
  }

  /** Loglu reveal (§17) — tam lisans payload'ı. */
  @Post('assignments/:id/reveal')
  reveal(@Param('id') id: string) {
    return this.adminOrders.reveal(id, 'panel:admin');
  }

  @Post('assignments/:id/suspend')
  suspend(@Param('id') id: string) {
    return this.adminOrders.suspend(id, true, 'panel:admin');
  }

  @Post('assignments/:id/unsuspend')
  unsuspend(@Param('id') id: string) {
    return this.adminOrders.suspend(id, false, 'panel:admin');
  }

  /** Teslimat mailini tekrar gönder (60sn debounce). */
  @Post('orders/:id/resend')
  resend(@Param('id') id: string) {
    return this.adminOrders.resend(id);
  }
}
