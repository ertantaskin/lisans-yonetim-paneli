import { Module } from '@nestjs/common';
import { PresenceController } from './presence.controller';
import { PresenceService } from './presence.service';

/** Operatör presence / çakışma uyarısı modülü (§14). Redis @Global — ekstra import yok. */
@Module({
  controllers: [PresenceController],
  providers: [PresenceService],
})
export class PresenceModule {}
