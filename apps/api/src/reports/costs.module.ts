import { Module } from '@nestjs/common';
import { CostsController } from './costs.controller';
import { CostsService } from './costs.service';

/**
 * Maliyet raporu modülü (§12/§13). DbModule global olduğundan (CostsService @Inject(DB))
 * ek import gerektirmez; AdminGuard global ConfigService'e bağlıdır. Self-contained —
 * app.module'e ORKESTRATÖR ekler.
 */
@Module({
  controllers: [CostsController],
  providers: [CostsService],
  exports: [CostsService],
})
export class CostsModule {}
