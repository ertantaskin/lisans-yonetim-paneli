import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import type { Notification } from '../db/schema/notifications';
import { LowStockService } from './low-stock.service';
import { NotificationsService } from './notifications.service';

/** Admin: bildirim akışı + düşük stok elle tetik (§12). */
@Controller('admin/notifications')
@UseGuards(AdminGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly lowStock: LowStockService,
  ) {}

  /** Son bildirimler (createdAt DESC). limit varsayılan 50, 1..200 sınırlı. */
  @Get()
  async list(@Query('limit') limit?: string): Promise<Notification[]> {
    const n = Number(limit);
    const clamped = Number.isFinite(n) && n > 0 ? Math.min(Math.trunc(n), 200) : 50;
    return this.notifications.list(clamped);
  }

  /** Düşük stok taramasını elle çalıştırır (ops + doğrulama). */
  @Post('check-low-stock')
  async checkLowStock(): Promise<{ created: number }> {
    return { created: await this.lowStock.checkLowStock() };
  }
}
