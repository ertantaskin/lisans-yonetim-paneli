import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SavedViewsController } from './saved-views.controller';
import { SavedViewsService } from './saved-views.service';

/**
 * Kayıtlı görünümler modülü (§14). Operatörün tablo filtre/arama durumunu (URL query)
 * adlandırıp saklaması + geri yüklemesi. Actor bazlı; AdminGuard altında.
 */
@Module({
  imports: [AuthModule],
  controllers: [SavedViewsController],
  providers: [SavedViewsService],
  exports: [SavedViewsService],
})
export class SavedViewsModule {}
