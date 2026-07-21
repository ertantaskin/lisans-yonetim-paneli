import { Module } from '@nestjs/common';
import { AiModule } from './ai.module';
import { AiSupportController } from './ai-support.controller';
import { AiSupportService } from './ai-support.service';

/**
 * AI destek triyajı özellik modülü (§15). AiModule'den AiService'i alır; destek
 * kuyruğu talebini kategorize edip taslak cevap ÖNERİR (eylem yapmaz). Orkestratör
 * bu modülü app.module'e ekler.
 */
@Module({
  imports: [AiModule],
  controllers: [AiSupportController],
  providers: [AiSupportService],
})
export class AiSupportModule {}
