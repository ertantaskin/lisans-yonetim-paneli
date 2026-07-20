import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthModule } from '../auth/auth.module';
import { LOW_STOCK_QUEUE, LowStockService } from './low-stock.service';
import { LowStockProcessor } from './low-stock.processor';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Bildirim + düşük stok modülü (§12). NotificationsService panel içi bildirim akışı +
 * env-gated Telegram; LowStockService tekrarlı (~30dk) + elle tetik düşük stok tespiti.
 */
@Module({
  imports: [AuthModule, BullModule.registerQueue({ name: LOW_STOCK_QUEUE })],
  controllers: [NotificationsController],
  providers: [NotificationsService, LowStockService, LowStockProcessor],
  exports: [NotificationsService],
})
export class NotificationsModule {}
