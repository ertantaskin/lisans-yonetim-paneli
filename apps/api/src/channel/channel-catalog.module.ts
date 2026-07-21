import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ChannelCatalogController } from './channel-catalog.controller';
import { ChannelCatalogService } from './channel-catalog.service';

/**
 * Reseller/marketplace kanalı (§10) — salt-okunur katalog+stok ucu. HmacGuard için
 * AuthModule import edilir; DB @Global sağlanır. FİYAT/gelir kapsam dışı.
 */
@Module({
  imports: [AuthModule],
  controllers: [ChannelCatalogController],
  providers: [ChannelCatalogService],
  exports: [ChannelCatalogService],
})
export class ChannelModule {}
