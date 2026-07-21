import { Module } from '@nestjs/common';
import { UpdatesService } from './updates.service';
import { UpdatesAdminController, UpdatesController } from './updates.controller';

/**
 * UpdatesModule — WP eklentisinin merkezî dağıtım/güncelleme kaynağı (§16). Admin uçları
 * (yayınla/listele) korumalı, public uçları (info/download) guard'sız.
 */
@Module({
  controllers: [UpdatesAdminController, UpdatesController],
  providers: [UpdatesService],
})
export class UpdatesModule {}
