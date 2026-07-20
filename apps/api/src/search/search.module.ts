import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

/**
 * Global arama modülü (§13, Ctrl+K). DB ve CryptoService @Global sağlandığından
 * (ReportsModule deseni) ek import gerektirmez; controller AdminGuard ile korunur.
 */
@Module({
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
