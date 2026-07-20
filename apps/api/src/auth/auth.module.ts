import { Module } from '@nestjs/common';
import { SitesModule } from '../sites/sites.module';
import { AdminGuard } from './admin.guard';
import { HmacGuard } from './hmac.guard';

/** Guard'ları (admin token + HMAC) sağlar; kullanan modüller bunu import eder. */
@Module({
  imports: [SitesModule],
  providers: [AdminGuard, HmacGuard],
  exports: [AdminGuard, HmacGuard, SitesModule],
})
export class AuthModule {}
